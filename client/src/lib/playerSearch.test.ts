import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  searchPlayers,
  clearPlayerSearchCache,
  foldPlayerName,
  narrowCachedPlayers,
  filterPlayersByQuery,
} from './playerSearch';

/**
 * The two databases, stubbed to behave the way the real ones do — which is the whole point
 * of this module: TheSportsDB matches only from the *start* of a full name, so a surname
 * finds nothing there and has to come back through Wikipedia.
 */
const SPORTS_DB_PLAYERS = [
  {
    idPlayer: '1',
    strPlayer: 'Andreas Helmersen',
    strTeam: 'Rosenborg',
    strSport: 'Soccer',
    strThumb: 'https://example.test/helmersen.png',
  },
  {
    idPlayer: '2',
    strPlayer: 'Andreas Hanche-Olsen',
    strTeam: 'Mainz 05',
    strSport: 'Soccer',
    strThumb: null,
  },
  { idPlayer: '3', strPlayer: 'Andreas Helms', strTeam: null, strSport: 'Basketball', strThumb: null },
];

const WIKIPEDIA_PAGES = [
  { pageid: 9, title: 'Helmersen', description: 'surname', index: 1 },
  {
    pageid: 10,
    title: 'Andreas Helmersen',
    description: 'Norwegian footballer',
    index: 3,
    thumbnail: { source: 'https://example.test/wiki/helmersen.jpg' },
  },
  {
    pageid: 11,
    title: 'Nils Helmersen (footballer, born 1990)',
    description: 'Norwegian football player',
    index: 2,
  },
  { pageid: 12, title: 'Helmersen Stadion', description: 'football stadium in Norway', index: 4 },
];

interface Stub {
  sportsDbFails?: boolean;
  wikipediaFails?: boolean;
  /** Milliseconds TheSportsDB takes to answer — its free tier is the slow half. */
  sportsDbDelay?: number;
  /** TheSportsDB never answers at all, until something aborts the request. */
  sportsDbHangs?: boolean;
}

/** What a fetch does when its signal is aborted, timeout or otherwise. */
function abortable<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    run().then(resolve, reject);
  });
}

function stubFetch(stub: Stub = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    calls.push(url);
    if (url.includes('thesportsdb')) {
      if (stub.sportsDbFails) throw new Error('offline');
      if (stub.sportsDbHangs) return abortable(init?.signal, () => new Promise<never>(() => {}));
      const term = new URL(url).searchParams.get('p') ?? '';
      const hits = SPORTS_DB_PLAYERS.filter(p =>
        p.strPlayer.toLowerCase().startsWith(term.toLowerCase()),
      );
      const answer = { ok: true, json: async () => ({ player: hits.length > 0 ? hits : null }) };
      if (!stub.sportsDbDelay) return answer;
      return abortable(
        init?.signal,
        () => new Promise(resolve => setTimeout(() => resolve(answer), stub.sportsDbDelay)),
      );
    }
    if (stub.wikipediaFails) throw new Error('offline');
    const search = new URL(url).searchParams.get('gsrsearch') ?? '';
    const pages = search.includes('intitle:Helmersen') ? WIKIPEDIA_PAGES : [];
    return { ok: true, json: async () => ({ query: { pages } }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => clearPlayerSearchCache());
afterEach(() => vi.unstubAllGlobals());

describe('foldPlayerName', () => {
  it('ignores accents, case and punctuation', () => {
    expect(foldPlayerName('Kylian Mbappé')).toBe('kylian mbappe');
    expect(foldPlayerName('Erling Braut Håland')).toBe('erling braut haland');
    expect(foldPlayerName('Martin Ødegaard')).toBe('martin odegaard');
    expect(foldPlayerName('Andreas Hanche-Olsen')).toBe('andreas hanche olsen');
  });
});

describe('searchPlayers', () => {
  it('finds a player by surname alone, with the club and photo TheSportsDB has', async () => {
    stubFetch();
    const results = await searchPlayers('Helmersen');

    expect(results[0]).toMatchObject({
      name: 'Andreas Helmersen',
      team: 'Rosenborg',
      thumb: 'https://example.test/helmersen.png',
    });
  });

  it('offers a player Wikipedia knows and TheSportsDB does not, by name alone', async () => {
    stubFetch();
    const results = await searchPlayers('Helmersen');

    // The article's disambiguating parenthesis is not part of anybody's name.
    expect(results.map(r => r.name)).toContain('Nils Helmersen');
  });

  it('leaves out everything that is not a footballer', async () => {
    stubFetch();
    const names = (await searchPlayers('Helmersen')).map(r => r.name);

    expect(names).not.toContain('Helmersen'); // the surname page
    expect(names).not.toContain('Helmersen Stadion'); // a ground
    expect(names).not.toContain('Andreas Helms'); // a basketball player
  });

  it('still answers a search that starts the name, best match first', async () => {
    stubFetch();
    const names = (await searchPlayers('Andreas H')).map(r => r.name);

    expect(names).toEqual(['Andreas Hanche-Olsen', 'Andreas Helmersen']);
  });

  it('does not suggest names the typed text does not appear in', async () => {
    const calls = stubFetch();
    await searchPlayers('Andreas H');

    // Wikipedia is asked about "Andreas" — a one-letter word matches no title — and every
    // other Andreas it returns has to be thrown away again.
    expect(calls.some(c => c.includes('wikipedia'))).toBe(true);
    expect((await searchPlayers('Andreas H')).every(r => r.name.startsWith('Andreas H'))).toBe(true);
  });

  it('asks each database once for a search already made', async () => {
    const calls = stubFetch();
    await searchPlayers('Helmersen');
    const asked = calls.length;

    await searchPlayers('  helmersen '); // same name, folded the same way
    expect(calls.length).toBe(asked);
  });

  it('still finds the player when TheSportsDB is down', async () => {
    stubFetch({ sportsDbFails: true });
    const names = (await searchPlayers('Helmersen')).map(r => r.name);

    expect(names).toContain('Andreas Helmersen');
  });

  it('still answers a name-start search when Wikipedia is down', async () => {
    stubFetch({ wikipediaFails: true });
    const names = (await searchPlayers('Andreas H')).map(r => r.name);

    expect(names).toEqual(['Andreas Hanche-Olsen', 'Andreas Helmersen']);
  });

  it('reports an outage rather than an empty list when nothing can be reached', async () => {
    stubFetch({ sportsDbFails: true, wikipediaFails: true });

    await expect(searchPlayers('Helmersen')).rejects.toThrow();
  });

  it('ignores a query too short to mean anything', async () => {
    const calls = stubFetch();

    expect(await searchPlayers('a')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('being quick about it', () => {
  it('shows what Wikipedia found without waiting for the slow database', async () => {
    stubFetch({ sportsDbDelay: 300 });
    const snapshots: string[][] = [];

    const search = searchPlayers('Helmersen', {
      onResults: found => snapshots.push(found.map(r => r.name)),
    });

    // Long enough for the quick leg, nowhere near long enough for the slow one.
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
    expect(snapshots[0]).toContain('Andreas Helmersen');

    const final = await search;
    // And the club the slow leg was carrying lands on the row that was already there.
    expect(final.find(r => r.name === 'Andreas Helmersen')?.team).toBe('Rosenborg');
    expect(snapshots.length).toBeGreaterThan(1);
  });

  it('gives a suggestion a face from the article, before any club is known', async () => {
    stubFetch({ sportsDbDelay: 300 });
    const snapshots: (string | null)[][] = [];

    const search = searchPlayers('Helmersen', {
      onResults: found => snapshots.push(found.map(r => r.thumb)),
    });
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0));

    expect(snapshots[0]).toContain('https://example.test/wiki/helmersen.jpg');
    await search;
  });

  it('does not look a player up twice across two different searches', async () => {
    const calls = stubFetch();
    // Resolves "Nils Helmersen" as one of the names behind the surname.
    await searchPlayers('Helmersen');
    const asked = calls.length;

    // A different search, but the player behind it is one TheSportsDB has already answered
    // for, so only the search itself costs anything.
    await searchPlayers('Nils Helmersen');
    const added = calls.slice(asked);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('wikipedia');
  });

  it('narrows what is already on screen while the search runs', async () => {
    stubFetch();
    await searchPlayers('Helmersen');

    // A longer version of a search already made is answered on the spot.
    const narrowed = narrowCachedPlayers('Andreas Helmersen');
    expect(narrowed?.map(r => r.name)).toEqual(['Andreas Helmersen']);

    // Something unrelated is not, and the caller is told so rather than shown the wrong list.
    expect(narrowCachedPlayers('Ronaldo')).toBeNull();
  });

  it('drops the names a fresh query no longer fits', () => {
    const shown = [
      { id: '1', name: 'Andreas Helmersen', team: null, thumb: null },
      { id: '2', name: 'Erling Haaland', team: null, thumb: null },
    ];
    expect(filterPlayersByQuery(shown, 'helm').map(r => r.name)).toEqual(['Andreas Helmersen']);
    expect(filterPlayersByQuery(shown, 'zzz')).toEqual([]);
  });

  it('goes on without a database that has stopped answering', async () => {
    vi.useFakeTimers();
    try {
      stubFetch({ sportsDbHangs: true });
      const search = searchPlayers('Helmersen');

      // The hung leg is dropped at the timeout — as is the lookup behind it, which asks the
      // same silent database — and what Wikipedia found still stands.
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.advanceTimersByTimeAsync(6_000);
      const names = (await search).map(r => r.name);
      expect(names).toContain('Andreas Helmersen');
    } finally {
      vi.useRealTimers();
    }
  });
});
