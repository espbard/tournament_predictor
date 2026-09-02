import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchPlayers, clearPlayerSearchCache, foldPlayerName } from './playerSearch';

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
  { pageid: 10, title: 'Andreas Helmersen', description: 'Norwegian footballer', index: 3 },
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
}

function stubFetch(stub: Stub = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('thesportsdb')) {
      if (stub.sportsDbFails) throw new Error('offline');
      const term = new URL(url).searchParams.get('p') ?? '';
      const hits = SPORTS_DB_PLAYERS.filter(p =>
        p.strPlayer.toLowerCase().startsWith(term.toLowerCase()),
      );
      return { ok: true, json: async () => ({ player: hits.length > 0 ? hits : null }) };
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
