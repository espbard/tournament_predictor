import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BigBallsProvider,
  maxFromLimitError,
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

/**
 * The documented example is a May 2026 kickoff, which belongs to season 2025 — so a fetch
 * for 2026 correctly drops it. Tests about fetching and paging use a date inside the
 * season they ask for; tests about mapping keep the documented payload as it is.
 */
const IN_SEASON = { ...DOCUMENTED_MATCH, kickoff_utc: '2026-09-08T16:45:00.000Z' };

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
    const paths = stubFetch(() => ({ body: { data: [IN_SEASON] } }));

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
    for (const body of [[IN_SEASON], { data: [IN_SEASON] }, { matches: [IN_SEASON] }]) {
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
      data: ids.map(id => ({ ...IN_SEASON, id })),
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
          data: [{ ...IN_SEASON, id: 'shared' }, { ...IN_SEASON, id: `m${n}` }],
          meta: { page: n, total_pages: 2 },
        },
      };
    });

    const fixtures = await provider().fetchFixtures('ucl', '2026');
    expect(fixtures.map(f => f.providerFixtureId).sort()).toEqual(['m1', 'm2', 'shared']);
  });

  it('gives up rather than looping on a provider that always offers the same next page', async () => {
    const paths = stubFetch(() => ({
      body: { data: [IN_SEASON], next: '/v1/matches?page=2' },
    }));

    await provider().fetchFixtures('ucl', '2026');

    // The first request, then the repeated "next" once — never again.
    expect(paths).toHaveLength(2);
  });

  it('warns when a response looks like an unexplained page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => ({
      body: Array.from({ length: 50 }, (_, i) => ({ ...IN_SEASON, id: `m${i}` })),
    }));

    await provider().fetchFixtures('ucl', '2026');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated page'));
  });

  // The failure this exists for: three rounds of "still exactly 50" against an API whose
  // paging convention is not documented and not in its envelope. Rather than guess a
  // fourth time, the adapter tries the conventions and keeps whichever actually returns
  // matches it does not already hold.
  describe('paging discovery', () => {
    const fifty = (offset = 0) =>
      Array.from({ length: 50 }, (_, i) => ({ ...IN_SEASON, id: `m${offset + i}` }));

    it('takes a bigger page when the provider honours a size parameter', async () => {
      const paths = stubFetch(path => {
        const limit = new URLSearchParams(path.split('?')[1]).get('limit');
        return {
          body: limit
            ? Array.from({ length: 144 }, (_, i) => ({ ...IN_SEASON, id: `m${i}` }))
            : fifty(),
        };
      });

      const fixtures = await provider().fetchFixtures('ucl', '2026');

      expect(fixtures).toHaveLength(144);
      expect(paths.some(p => p.includes('limit=200'))).toBe(true);
    });

    it('walks page numbers when that is what the provider takes', async () => {
      stubFetch(path => {
        const params = new URLSearchParams(path.split('?')[1]);
        if (params.has('limit') || params.has('per_page') || params.has('page_size') || params.has('count')) {
          // A size parameter this API does not take.
          return { status: 400, body: { message: 'unknown parameter' } };
        }
        const page = Number(params.get('page') ?? '1');
        return { body: page <= 3 ? fifty((page - 1) * 50) : [] };
      });

      const fixtures = await provider().fetchFixtures('ucl', '2026');

      expect(fixtures).toHaveLength(150);
    });

    it('walks offsets when that is what the provider takes', async () => {
      stubFetch(path => {
        const params = new URLSearchParams(path.split('?')[1]);
        if (params.has('limit') || params.has('per_page') || params.has('page_size') || params.has('count')) {
          return { status: 400, body: { message: 'unknown parameter' } };
        }
        // Ignores page entirely, which is what makes it look like the same page again.
        if (params.has('page')) return { body: fifty() };
        const offset = Number(params.get('offset') ?? '0');
        return { body: offset < 100 ? fifty(offset) : [] };
      });

      const fixtures = await provider().fetchFixtures('ucl', '2026');

      expect(fixtures).toHaveLength(100);
    });

    // The important negative: a provider that ignores every unknown parameter returns
    // the same page each time, and must not be walked forever or double-counted.
    it('stops, and says so, when nothing it tries returns anything new', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const paths = stubFetch(() => ({ body: fifty() }));

      const fixtures = await provider().fetchFixtures('ucl', '2026');

      expect(fixtures).toHaveLength(50);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no paging convention found'));
      // Bounded: the probe tries each convention once and gives up.
      expect(paths.length).toBeLessThan(15);
    });

    it('does not probe at all when the count is not page-shaped', async () => {
      const paths = stubFetch(() => ({
        body: Array.from({ length: 144 }, (_, i) => ({ ...IN_SEASON, id: `m${i}` })),
      }));

      await provider().fetchFixtures('ucl', '2026');

      expect(paths).toHaveLength(1);
    });
  });

  // Captured from the real API on 2026-08-30: no pagination in the envelope at all, and
  // a note saying the Champions League is served from a stored table rather than a live
  // adapter. Both facts drive behaviour, so both are pinned.
  const REAL_ENVELOPE = {
    data: [
      {
        id: '72f2d036-2869-4a95-b670-8efee7d9be09',
        sport: 'football',
        league: 'UEFA Champions League',
        home: { name: 'Club Brugge KV', short_name: 'BRU', logo_url: 'https://crests.football-data.org/851.png' },
        away: { name: 'Aston Villa', short_name: 'AVL', logo_url: 'https://r2.thesportsdb.com/x.png' },
        kickoff_utc: '2026-09-08T16:45:00.000Z',
        status: 'scheduled',
        score: null,
        linescore: null,
        attendance: null,
        broadcast: null,
        has_odds: false,
      },
    ],
    meta: {
      source: 'stored',
      cached: false,
      request_id: '604095c5-1f88-4314-b43d-34b3be4140b6',
      note: 'Upcoming matches served from the stored table (no live adapter covers this sport/league; refreshed by ingest).',
    },
    error: null,
  };

  it('maps the real envelope, and offers no next page from it', () => {
    const matches = BigBallsProvider.matchesFrom(REAL_ENVELOPE, '/v1/matches');
    expect(matches).toHaveLength(1);

    const fixture = mapBigBallsMatch(matches[0] as any);
    expect(fixture.homeTeam?.name).toBe('Club Brugge KV');
    expect(fixture.awayTeam?.shortName).toBe('AVL');
    expect(fixture.status).toBe('scheduled');
    expect(fixture.kickoffAt).toBe('2026-09-08T16:45:00.000Z');
    // A match not yet played carries no score, and none is invented for it.
    expect(fixture.score.normalTime).toEqual({ home: null, away: null });

    // Nothing in meta is pagination, so there is nothing to follow — which is what makes
    // the discovery probe the only way through.
    expect(BigBallsProvider.totalFrom(REAL_ENVELOPE)).toBeNull();
    expect(BigBallsProvider.nextPagePath(REAL_ENVELOPE, '/v1/matches', 50)).toBeNull();
  });

  it('asks the season request the sync makes, then retries it with a bigger page', async () => {
    const paths = stubFetch(path => {
      if (path.startsWith('/v1/leagues')) return { body: { data: [{ key: 'CL', name: 'UEFA Champions League' }] } };
      const limit = new URLSearchParams(path.split('?')[1]).get('limit');
      return {
        body: {
          ...REAL_ENVELOPE,
          data: Array.from({ length: limit ? 144 : 50 }, (_, i) => ({
            ...REAL_ENVELOPE.data[0],
            id: `m${i}`,
          })),
        },
      };
    });

    const probes = await provider().probe('CL', '2026');

    // The season request carries the same date range a whole-season sync sends.
    expect(paths[1]).toBe(
      '/v1/matches?sport=football&league=CL&date_from=2026-06-01&date_to=2027-07-31',
    );
    expect(probes.map(p => p.key)).toEqual(['competition', 'matches_season', 'matches_paged']);
    expect(probes[2].count).toBe(144);
    expect(probes[2].detail).toContain('the cap lifts');
    // The provider's own note about how the league is served is surfaced, not swallowed.
    expect(probes[1].detail).toContain('served from the stored table');
  });

  it('does not ask for a bigger page when the first response was not page-shaped', async () => {
    const paths = stubFetch(path =>
      path.startsWith('/v1/leagues')
        ? { body: { data: [] } }
        : { body: { data: Array.from({ length: 144 }, (_, i) => ({ ...REAL_ENVELOPE.data[0], id: `m${i}` })) } },
    );

    const probes = await provider().probe('CL', '2026');

    expect(probes.map(p => p.key)).toEqual(['competition', 'matches_season']);
    expect(paths).toHaveLength(2);
  });

  // The regression this exists for: 273 fixtures, two seasons' worth, from a request that
  // asked for one. The date parameters are advisory to this provider.
  describe('when the provider ignores the dates it was given', () => {
    const at = (kickoff: string, id: string) => ({ ...DOCUMENTED_MATCH, id, kickoff_utc: kickoff });

    it('keeps only the season asked for', async () => {
      stubFetch(() => ({
        body: {
          data: [
            at('2025-09-16T19:00:00.000Z', 'last-season'),
            at('2026-09-08T16:45:00.000Z', 'this-season'),
            at('2027-06-05T19:00:00.000Z', 'this-season-final'),
            at('2027-09-14T19:00:00.000Z', 'next-season'),
          ],
        },
      }));

      const fixtures = await provider().fetchFixtures('CL', '2026');

      expect(fixtures.map(f => f.providerFixtureId)).toEqual(['this-season', 'this-season-final']);
    });

    it('drops a match with no kickoff time, having nothing to place it by', async () => {
      stubFetch(() => ({
        body: { data: [at('2026-09-08T16:45:00.000Z', 'dated'), { ...DOCUMENTED_MATCH, id: 'undated', kickoff_utc: null }] },
      }));

      const fixtures = await provider().fetchFixtures('CL', '2026');
      expect(fixtures.map(f => f.providerFixtureId)).toEqual(['dated']);
    });

    it('takes the season window from the caller, which knows the competition', async () => {
      const paths = stubFetch(() => ({
        body: {
          data: [
            at('2026-08-15T19:00:00.000Z', 'before-the-window'),
            at('2026-09-15T19:00:00.000Z', 'inside'),
          ],
        },
      }));

      const fixtures = await provider().fetchFixtures('CL', '2026', {
        seasonWindow: { dateFrom: '2026-09-01', dateTo: '2027-06-01' },
      });

      // Sent as the request...
      expect(paths[0]).toContain('date_from=2026-09-01&date_to=2027-06-01');
      // ...and enforced on the answer, which is the half that actually holds.
      expect(fixtures.map(f => f.providerFixtureId)).toEqual(['inside']);
    });

    it('enforces an explicit window too', async () => {
      stubFetch(() => ({
        body: {
          data: [
            at('2026-09-08T16:45:00.000Z', 'inside'),
            at('2026-10-20T19:00:00.000Z', 'outside'),
          ],
        },
      }));

      const fixtures = await provider().fetchFixtures('CL', '2026', {
        dateFrom: '2026-09-07',
        dateTo: '2026-09-09',
      });

      expect(fixtures.map(f => f.providerFixtureId)).toEqual(['inside']);
    });

    it('says how many it dropped rather than doing it silently', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFetch(() => ({
        body: { data: [at('2025-09-16T19:00:00.000Z', 'last'), at('2026-09-08T16:45:00.000Z', 'this')] },
      }));

      await provider().fetchFixtures('CL', '2026');

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside the requested dates'));
    });
  });

  // The API answers a too-large page with the size it would accept. Reading that is the
  // difference between "the cap does not lift" and lifting it.
  describe('a stated maximum page size', () => {
    const REFUSAL =
      '400 Bad Request: {"error":{"code":"bad_request","message":"One or more query ' +
      'parameters are invalid.","validation_errors":{"fieldErrors":{"limit":["Number ' +
      'must be less than or equal to 200"]}}}}';

    it('reads the size out of the rejection', () => {
      expect(maxFromLimitError(new Error(REFUSAL))).toBe(200);
      expect(maxFromLimitError(REFUSAL)).toBe(200);
    });

    it('is null when nothing states one', () => {
      expect(maxFromLimitError(new Error('400 Bad Request: nope'))).toBeNull();
      expect(maxFromLimitError(null)).toBeNull();
    });

    it('asks again for exactly the size the provider named', async () => {
      const paths = stubFetch(path => {
        const limit = Number(new URLSearchParams(path.split('?')[1]).get('limit') ?? '0');
        if (limit === 0) {
          return { body: { data: Array.from({ length: 50 }, (_, i) => ({ ...IN_SEASON, id: `m${i}` })) } };
        }
        if (limit > 200) return { status: 400, body: JSON.parse(REFUSAL.slice(REFUSAL.indexOf('{'))) };
        return {
          body: { data: Array.from({ length: 144 }, (_, i) => ({ ...IN_SEASON, id: `m${i}` })) },
        };
      });

      const fixtures = await provider().fetchFixtures('CL', '2026');

      expect(fixtures).toHaveLength(144);
      expect(paths.some(p => p.includes('limit=200'))).toBe(true);
    });
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
