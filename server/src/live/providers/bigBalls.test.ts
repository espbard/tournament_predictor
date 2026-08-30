import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BigBallsProvider,
  mapBigBallsMatch,
  mapBigBallsScore,
  mapBigBallsStatus,
  mapBigBallsTeam,
  seasonDateRange,
} from './bigBalls';
import { RateLimiter } from './rateLimiter';
import { ProviderError } from './types';

// ⚠ Unlike footballData.test.ts, the payload below is bigballsdata's *documented*
// example, not a response captured from the live API — the host is unreachable from the
// environment this adapter was written in. So this pins the mapping to the documented
// contract and no more. `npm run live:capture -w server` fetches real payloads into
// __fixtures__/; when it has been run, this file should be rewritten against those, and
// the ✗ cases below rechecked in case the real schema carries more than the docs show.

const DOCUMENTED_MATCH = {
  id: 'bb_match_8h2k5p9q3xyz',
  sport: 'football',
  league: 'EPL',
  home: { name: 'Arsenal', short_name: 'ARS', logo_url: 'https://cdn.bigballsdata.com/teams/ars.png' },
  away: { name: 'Chelsea', short_name: 'CHE', logo_url: 'https://cdn.bigballsdata.com/teams/che.png' },
  kickoff_utc: '2026-05-20T19:00:00Z',
  status: 'in_progress',
  score: { home: 2, away: 1 },
  linescore: null,
  attendance: 60260,
  broadcast: 'Sky Sports Main Event',
  has_odds: true,
};

describe('mapBigBallsStatus', () => {
  it.each([
    ['scheduled', 'scheduled'],
    ['in_progress', 'in_play'],
    ['live', 'in_play'],
    ['half_time', 'paused'],
    ['final', 'finished'],
    ['finished', 'finished'],
    ['postponed', 'postponed'],
    ['cancelled', 'cancelled'],
  ])('maps %s to %s', (raw, expected) => {
    expect(mapBigBallsStatus(raw)).toBe(expected);
  });

  it('is insensitive to case, spacing and hyphens', () => {
    expect(mapBigBallsStatus(' In-Progress ')).toBe('in_play');
    expect(mapBigBallsStatus('HALF TIME')).toBe('paused');
  });

  // The same safety property the football-data adapter has: never guess a status that
  // leaves a played match open for predictions.
  it('maps an unknown status to suspended rather than scheduled', () => {
    expect(mapBigBallsStatus('something_new')).toBe('suspended');
    expect(mapBigBallsStatus(null)).toBe('suspended');
  });
});

describe('mapBigBallsScore', () => {
  it('reports the single score as normal time', () => {
    const score = mapBigBallsScore({ home: 2, away: 1 });
    expect(score.normalTime).toEqual({ home: 2, away: 1 });
    expect(score.winner).toBe('HOME_TEAM');
  });

  it('derives the winner, including a draw', () => {
    expect(mapBigBallsScore({ home: 1, away: 1 }).winner).toBe('DRAW');
    expect(mapBigBallsScore({ home: 0, away: 3 }).winner).toBe('AWAY_TEAM');
  });

  // This provider publishes one pair of numbers. Inventing a half-time or extra-time
  // split from it is exactly the kind of guess the scoring model refuses to make.
  it('leaves every score it was not given null', () => {
    const score = mapBigBallsScore({ home: 2, away: 1 });
    expect(score.halfTime).toEqual({ home: null, away: null });
    expect(score.extraTime).toEqual({ home: null, away: null });
    expect(score.penalties).toEqual({ home: null, away: null });
  });

  it('is all nulls for a match not yet played', () => {
    const score = mapBigBallsScore(null);
    expect(score.normalTime).toEqual({ home: null, away: null });
    expect(score.winner).toBeNull();
  });
});

describe('mapBigBallsTeam', () => {
  it('maps a named team, with the name standing in for the missing id', () => {
    const team = mapBigBallsTeam(DOCUMENTED_MATCH.home)!;
    expect(team.name).toBe('Arsenal');
    expect(team.shortName).toBe('ARS');
    expect(team.crestUrl).toBe('https://cdn.bigballsdata.com/teams/ars.png');
    // Never a real id: the sync engine matches these by name, never by this value.
    expect(team.providerTeamId).toBe('name:arsenal');
  });

  it('is null when no name is given', () => {
    expect(mapBigBallsTeam(null)).toBeNull();
    expect(mapBigBallsTeam({ name: '   ' })).toBeNull();
  });
});

describe('mapBigBallsMatch', () => {
  const fixture = mapBigBallsMatch(DOCUMENTED_MATCH);

  it('maps the documented match', () => {
    expect(fixture.providerFixtureId).toBe('bb_match_8h2k5p9q3xyz');
    expect(fixture.kickoffAt).toBe('2026-05-20T19:00:00Z');
    expect(fixture.kickoffConfirmed).toBe(true);
    expect(fixture.status).toBe('in_play');
    expect(fixture.homeTeam?.name).toBe('Arsenal');
    expect(fixture.awayTeam?.name).toBe('Chelsea');
    expect(fixture.score.normalTime).toEqual({ home: 2, away: 1 });
  });

  // The three gaps documented at the top of bigBalls.ts, pinned so they are not
  // forgotten: no team ids, no stage, no matchday.
  it('carries no team ids, because the provider publishes none', () => {
    expect(fixture.homeProviderTeamId).toBeNull();
    expect(fixture.awayProviderTeamId).toBeNull();
  });

  it('carries no stage, which is what makes the tournament default apply', () => {
    expect(fixture.providerStage).toBeNull();
  });

  it('carries no matchday in the documented schema', () => {
    expect(fixture.matchday).toBeNull();
  });

  // If the real API does supply them, they must be used rather than discarded.
  it('reads a stage, round and matchday when the payload has them', () => {
    const withRound = mapBigBallsMatch({ ...DOCUMENTED_MATCH, round: 'Round of 16', matchday: '2' });
    expect(withRound.providerStage).toBe('Round of 16');
    expect(withRound.matchday).toBe(2);
  });

  it('treats a match with no kickoff time as unconfirmed', () => {
    const undated = mapBigBallsMatch({ ...DOCUMENTED_MATCH, kickoff_utc: null });
    expect(undated.kickoffAt).toBeNull();
    expect(undated.kickoffConfirmed).toBe(false);
  });
});

// Why this exists: a Champions League league phase is 8 rounds of 18. Getting 5 rounds
// of 10 back is what a paged endpoint and a default date window look like from the
// outside, and neither announced itself.
describe('seasonDateRange', () => {
  it('spans a European season from its starting year', () => {
    expect(seasonDateRange('2026')).toEqual({ dateFrom: '2026-06-01', dateTo: '2027-07-31' });
  });

  it('asks without a range when the season is not a year', () => {
    expect(seasonDateRange('not-a-year')).toEqual({});
  });
});

describe('BigBallsProvider.nextPagePath', () => {
  const path = '/v1/matches?sport=football&league=ucl';

  it('follows a next link verbatim, absolute or relative', () => {
    expect(BigBallsProvider.nextPagePath({ next: '/v1/matches?page=2' }, path, 50)).toBe(
      '/v1/matches?page=2',
    );
    expect(
      BigBallsProvider.nextPagePath(
        { links: { next: 'https://api.bigballsdata.com/v1/matches?page=3' } },
        path,
        100,
      ),
    ).toBe('/v1/matches?page=3');
  });

  it('advances the page number from pagination metadata', () => {
    const next = BigBallsProvider.nextPagePath(
      { data: [], meta: { page: 1, total_pages: 3 } },
      path,
      50,
    );
    expect(next).toBe('/v1/matches?sport=football&league=ucl&page=2');
  });

  it('stops on the last page', () => {
    expect(
      BigBallsProvider.nextPagePath({ meta: { page: 3, total_pages: 3 } }, path, 144),
    ).toBeNull();
    expect(BigBallsProvider.nextPagePath({ has_more: false }, path, 50)).toBeNull();
  });

  it('keeps going while a reported total is short of what we hold', () => {
    expect(BigBallsProvider.nextPagePath({ total: 144 }, path, 50)).toContain('page=2');
    expect(BigBallsProvider.nextPagePath({ total: 144 }, path, 144)).toBeNull();
  });

  it('follows a cursor when one is offered', () => {
    expect(BigBallsProvider.nextPagePath({ next_cursor: 'abc' }, path, 50)).toBe(
      '/v1/matches?sport=football&league=ucl&cursor=abc',
    );
  });

  it('offers no next page for a plain array', () => {
    expect(BigBallsProvider.nextPagePath([{ id: '1' }], path, 1)).toBeNull();
  });
});

describe('BigBallsProvider.looksTruncated', () => {
  it('knows a page-sized response with nothing to explain it', () => {
    expect(BigBallsProvider.looksTruncated(50, null)).toBe(true);
    expect(BigBallsProvider.looksTruncated(100, null)).toBe(true);
    // 144 is a whole league phase, not a page size.
    expect(BigBallsProvider.looksTruncated(144, null)).toBe(false);
  });

  it('trusts a reported total over the shape of the number', () => {
    expect(BigBallsProvider.looksTruncated(50, 50)).toBe(false);
    expect(BigBallsProvider.looksTruncated(144, 288)).toBe(true);
  });
});

describe('BigBallsProvider', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (path: string) => { status?: number; body: unknown }) {
    const paths: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const path = String(url).replace('https://api.bigballsdata.com', '');
      paths.push(path);
      expect(init.headers.Authorization).toBe('Bearer test-key');
      const { status = 200, body } = handler(path);
      return new Response(JSON.stringify(body), { status });
    }) as any;
    return paths;
  }

  const provider = () =>
    new BigBallsProvider('test-key', new RateLimiter({ limit: 50, intervalMs: 1000 }));

  it('asks for the league by key and maps what comes back', async () => {
    const paths = stubFetch(() => ({ body: { data: [DOCUMENTED_MATCH] } }));

    const fixtures = await provider().fetchFixtures('ucl', '2026');

    expect(paths).toEqual([
      '/v1/matches?sport=football&league=ucl&date_from=2026-06-01&date_to=2027-07-31',
    ]);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].homeTeam?.name).toBe('Arsenal');
  });

  it('passes a date window through', async () => {
    const paths = stubFetch(() => ({ body: [] }));

    await provider().fetchFixtures('ucl', '2026', { dateFrom: '2026-09-16', dateTo: '2026-09-18' });

    expect(paths[0]).toBe(
      '/v1/matches?sport=football&league=ucl&date_from=2026-09-16&date_to=2026-09-18',
    );
  });

  it('accepts a bare array or any of the usual envelopes', async () => {
    for (const body of [[DOCUMENTED_MATCH], { data: [DOCUMENTED_MATCH] }, { matches: [DOCUMENTED_MATCH] }]) {
      stubFetch(() => ({ body }));
      expect(await provider().fetchFixtures('ucl', '2026')).toHaveLength(1);
    }
  });

  // The whole reason this provider exists is a silent empty result. A response shape we
  // do not understand must not be read as "no matches".
  it('throws on a response shape it does not recognise', async () => {
    stubFetch(() => ({ body: { unexpected: 'shape' } }));
    await expect(provider().fetchFixtures('ucl', '2026')).rejects.toThrow(/unrecognised response shape/);
  });

  it('refuses to serve teams or standings', async () => {
    await expect(provider().fetchTeams()).rejects.toBeInstanceOf(ProviderError);
    await expect(provider().fetchStandings()).rejects.toThrow(/fixtures only/);
  });

  it('reports a missing key rather than calling out', async () => {
    const paths = stubFetch(() => ({ body: [] }));
    await expect(
      new BigBallsProvider(undefined, new RateLimiter({ limit: 5, intervalMs: 1000 })).fetchFixtures(
        'ucl',
        '2026',
      ),
    ).rejects.toThrow(/BIG_BALLS_API_KEY is not set/);
    expect(paths).toEqual([]);
  });

  it('asks for the whole season rather than trusting the endpoint default', async () => {
    const paths = stubFetch(() => ({ body: [] }));

    await provider().fetchFixtures('ucl', '2026');

    expect(paths[0]).toBe(
      '/v1/matches?sport=football&league=ucl&date_from=2026-06-01&date_to=2027-07-31',
    );
  });

  it('follows pagination until the whole season is in hand', async () => {
    const page = (n: number, ids: string[], totalPages: number) => ({
      data: ids.map(id => ({ ...DOCUMENTED_MATCH, id })),
      meta: { page: n, total_pages: totalPages, total: 3 },
    });
    const paths = stubFetch(path => {
      const n = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
      return { body: page(n, [`m${n}`], 3) };
    });

    const fixtures = await provider().fetchFixtures('ucl', '2026');

    expect(fixtures.map(f => f.providerFixtureId)).toEqual(['m1', 'm2', 'm3']);
    expect(paths).toHaveLength(3);
  });

  it('does not return one match twice when pages overlap', async () => {
    stubFetch(path => {
      const n = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
      return {
        body: {
          data: [{ ...DOCUMENTED_MATCH, id: 'shared' }, { ...DOCUMENTED_MATCH, id: `m${n}` }],
          meta: { page: n, total_pages: 2 },
        },
      };
    });

    const fixtures = await provider().fetchFixtures('ucl', '2026');
    expect(fixtures.map(f => f.providerFixtureId).sort()).toEqual(['m1', 'm2', 'shared']);
  });

  it('gives up rather than looping on a provider that always offers the same next page', async () => {
    const paths = stubFetch(() => ({
      body: { data: [DOCUMENTED_MATCH], next: '/v1/matches?page=2' },
    }));

    await provider().fetchFixtures('ucl', '2026');

    // The first request, then the repeated "next" once — never again.
    expect(paths).toHaveLength(2);
  });

  it('warns when a response looks like an unexplained page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => ({
      body: Array.from({ length: 50 }, (_, i) => ({ ...DOCUMENTED_MATCH, id: `m${i}` })),
    }));

    await provider().fetchFixtures('ucl', '2026');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated page'));
  });

  it('probes the league list and the match list without throwing', async () => {
    stubFetch(path =>
      path.startsWith('/v1/leagues')
        ? { body: { data: [{ key: 'epl', name: 'Premier League' }, { key: 'ucl', name: 'Champions League' }] } }
        : { status: 403, body: { message: 'forbidden' } },
    );

    const probes = await provider().probe('ucl', '2026');

    expect(probes.map(p => p.key)).toEqual(['competition', 'matches_season']);
    expect(probes[0].countForSeason).toBe(1);
    expect(probes[0].detail).toContain('is listed');
    expect(probes[1].ok).toBe(false);
    expect(probes[1].status).toBe(403);
  });
});
