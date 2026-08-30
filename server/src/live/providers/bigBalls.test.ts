import { afterEach, describe, expect, it, vi } from 'vitest';
import { BigBallsProvider, mapBigBallsMatch, mapBigBallsScore, mapBigBallsStatus, mapBigBallsTeam } from './bigBalls';
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

    expect(paths).toEqual(['/v1/matches?sport=football&league=ucl']);
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
