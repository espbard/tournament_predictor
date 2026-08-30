import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_FORMATS, resolveStageKey } from '@tournament-predictor/shared';
import {
  FootballDataProvider,
  isKickoffConfirmed,
  matchSeasonYear,
  mapFixtureStatus,
  mapMatch,
  mapScore,
  mapStandings,
  mapTeam,
  normalTimeFromScore,
} from './footballData';
import { ProviderError } from './types';
import { RateLimiter } from './rateLimiter';

// Raw→DTO mapping, checked against payloads actually returned by football-data.org on
// 2026-08-21 and committed under __fixtures__/. No network access here: the fixtures are
// the contract, and if the provider changes shape the smoke script is what catches it.
//
// Read rather than imported, so the server tsconfig does not need resolveJsonModule and
// the payloads stay untyped `any` — which is what raw provider data actually is.

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8'));
}

const clMatches = fixture('cl-matches.sample.json');
const plMatches = fixture('pl-matches.sample.json');
const plTeams = fixture('pl-teams.sample.json');
const clStandings = fixture('cl-standings.sample.json');

const findByDuration = (d: string) =>
  clMatches.matches.find((m: any) => m.status === 'FINISHED' && m.score?.duration === d);
const findByStage = (s: string) => clMatches.matches.find((m: any) => m.stage === s);

describe('mapFixtureStatus', () => {
  it.each([
    ['SCHEDULED', 'scheduled'],
    ['TIMED', 'scheduled'],
    ['IN_PLAY', 'in_play'],
    ['PAUSED', 'paused'],
    ['FINISHED', 'finished'],
    ['AWARDED', 'finished'],
    ['POSTPONED', 'postponed'],
    ['SUSPENDED', 'suspended'],
    ['CANCELLED', 'cancelled'],
  ])('maps %s to %s', (raw, expected) => {
    expect(mapFixtureStatus(raw)).toBe(expected);
  });

  it('is case and whitespace insensitive', () => {
    expect(mapFixtureStatus('  in_play ')).toBe('in_play');
  });

  // The safety property: never guess a status that leaves predictions open.
  it('maps an unknown status to suspended rather than scheduled', () => {
    expect(mapFixtureStatus('SOMETHING_NEW')).toBe('suspended');
    expect(mapFixtureStatus(null)).toBe('suspended');
    expect(mapFixtureStatus(undefined)).toBe('suspended');
  });
});

describe('isKickoffConfirmed', () => {
  it('treats SCHEDULED as provisional and TIMED as confirmed', () => {
    expect(isKickoffConfirmed('SCHEDULED')).toBe(false);
    expect(isKickoffConfirmed('TIMED')).toBe(true);
  });

  it('treats a played match as having had a real kickoff time', () => {
    expect(isKickoffConfirmed('FINISHED')).toBe(true);
    expect(isKickoffConfirmed('IN_PLAY')).toBe(true);
  });
});

describe('normalTimeFromScore', () => {
  it('uses fullTime when the match ended in normal time', () => {
    const m = findByDuration('REGULAR');
    expect(m).toBeDefined();
    expect(normalTimeFromScore(m.score)).toEqual(m.score.fullTime);
  });

  it('uses regularTime after extra time, not fullTime', () => {
    const m = findByDuration('EXTRA_TIME');
    expect(m).toBeDefined();
    expect(normalTimeFromScore(m.score)).toEqual(m.score.regularTime);
  });

  // The regression this whole rule exists to prevent. In the captured payload the tie
  // finished 0-1 after 90 and was won 4-1 on penalties, and the provider reports
  // fullTime as 1-5 — regular time plus the shootout, which is not a real scoreline.
  it('uses regularTime after a shootout, never the shootout-inflated fullTime', () => {
    const m = findByDuration('PENALTY_SHOOTOUT');
    expect(m).toBeDefined();

    const normal = normalTimeFromScore(m.score);
    expect(normal).toEqual(m.score.regularTime);
    expect(normal).not.toEqual(m.score.fullTime);
  });

  it('refuses to guess when a non-regular match has no regularTime', () => {
    expect(
      normalTimeFromScore({
        winner: 'HOME_TEAM',
        duration: 'EXTRA_TIME',
        fullTime: { home: 3, away: 2 },
      }),
    ).toEqual({ home: null, away: null });
  });

  it('returns nulls for a fixture that has not been played', () => {
    expect(normalTimeFromScore(plMatches.matches[0].score)).toEqual({ home: null, away: null });
  });

  it('tolerates a missing score object', () => {
    expect(normalTimeFromScore(undefined)).toEqual({ home: null, away: null });
    expect(normalTimeFromScore(null)).toEqual({ home: null, away: null });
  });
});

describe('mapScore', () => {
  it('keeps extra time, penalties and the provider full-time score for display', () => {
    const m = findByDuration('PENALTY_SHOOTOUT');
    const score = mapScore(m.score);

    expect(score.normalTime).toEqual(m.score.regularTime);
    expect(score.extraTime).toEqual(m.score.extraTime);
    expect(score.penalties).toEqual(m.score.penalties);
    expect(score.final).toEqual(m.score.fullTime);
    expect(score.winner).toBe(m.score.winner);
  });

  it('retains the raw provider object so a mapping bug stays diagnosable', () => {
    const m = findByDuration('REGULAR');
    expect(mapScore(m.score).raw).toEqual(m.score);
  });

  it('fills absent extra-time and penalty sections with nulls', () => {
    const score = mapScore(plMatches.matches[0].score);
    expect(score.extraTime).toEqual({ home: null, away: null });
    expect(score.penalties).toEqual({ home: null, away: null });
    expect(score.winner).toBeNull();
  });
});

describe('mapMatch', () => {
  it('maps a scheduled league fixture', () => {
    const raw = plMatches.matches[0];
    const f = mapMatch(raw);

    expect(f).toMatchObject({
      providerFixtureId: String(raw.id),
      homeProviderTeamId: String(raw.homeTeam.id),
      awayProviderTeamId: String(raw.awayTeam.id),
      kickoffAt: raw.utcDate,
      kickoffConfirmed: true,
      status: 'scheduled',
      providerStage: 'REGULAR_SEASON',
      groupName: null,
      matchday: raw.matchday,
      minute: null,
    });
    expect(f.providerLastUpdated).toBe(raw.lastUpdated);
  });

  it('stringifies provider ids, since ours are text columns', () => {
    const f = mapMatch(plMatches.matches[0]);
    expect(typeof f.providerFixtureId).toBe('string');
    expect(typeof f.homeProviderTeamId).toBe('string');
  });

  it('leaves team ids null for an undrawn knockout slot', () => {
    const raw = {
      ...findByStage('LAST_16'),
      homeTeam: { id: null, name: null },
      awayTeam: { id: null, name: null },
    };
    const f = mapMatch(raw);
    expect(f.homeProviderTeamId).toBeNull();
    expect(f.awayProviderTeamId).toBeNull();
  });

  // Two-legged ties come back with matchday 1 and 2, which is the leg number. That is
  // more reliable than ordering legs by kickoff, since both legs can share a date.
  it('carries the leg number through as matchday on two-legged ties', () => {
    for (const stage of ['PLAYOFFS', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS']) {
      const raw = findByStage(stage);
      expect(raw, `${stage} missing from fixture data`).toBeDefined();
      expect([1, 2]).toContain(mapMatch(raw).matchday);
    }
  });

  it('normalises an empty group to null', () => {
    expect(mapMatch({ ...plMatches.matches[0], group: '  ' }).groupName).toBeNull();
  });
});

describe('stage vocabulary', () => {
  // Guards the format mapping against a provider rename: every stage string present in
  // the captured payloads must resolve to a known internal stage key.
  it('resolves every Champions League stage the provider actually sent', () => {
    const stages: string[] = [...new Set(clMatches.matches.map((m: any) => m.stage))] as string[];
    expect(stages.length).toBeGreaterThan(0);

    for (const stage of stages) {
      expect(
        resolveStageKey(LIVE_FORMATS.ucl_swiss, 'football_data', stage),
        `unmapped Champions League stage: ${stage}`,
      ).not.toBeNull();
    }
  });

  it('resolves the Premier League stage', () => {
    expect(resolveStageKey(LIVE_FORMATS.domestic_league, 'football_data', 'REGULAR_SEASON')).toBe(
      'regular_season',
    );
  });

  // PLAYOFFS is the February knockout round between league-phase places 9-24, and it is
  // the only play-off-ish string football-data emits for the Champions League: coverage
  // starts at the league phase, so the August PLAY_OFF_ROUND qualifier never appears.
  // If it ever does, it must not collide with the February round.
  it('keeps the February knockout play-off separate from the August qualifier', () => {
    const format = LIVE_FORMATS.ucl_swiss;
    expect(resolveStageKey(format, 'football_data', 'PLAYOFFS')).toBe('knockout_playoff');
    expect(resolveStageKey(format, 'football_data', 'PLAY_OFF_ROUND')).toBe('qualifying_playoff');
  });

  it('returns null for an unknown stage rather than throwing', () => {
    expect(resolveStageKey(LIVE_FORMATS.ucl_swiss, 'football_data', 'THIRD_PLACE')).toBeNull();
  });
});

describe('mapTeam', () => {
  it('maps the fields the app stores and ignores the rest', () => {
    const raw = plTeams.teams[0];
    expect(mapTeam(raw)).toEqual({
      providerTeamId: String(raw.id),
      name: raw.name,
      shortName: raw.shortName,
      tla: raw.tla,
      crestUrl: raw.crest,
      groupName: null,
    });
  });

  it('falls back to the provider id when a team has no name', () => {
    expect(mapTeam({ id: 999, name: null }).name).toBe('999');
  });
});

describe('mapStandings', () => {
  it('keeps only the TOTAL table, not the HOME and AWAY duplicates', () => {
    const rows = mapStandings(clStandings);
    const total = clStandings.standings.find((t: any) => t.type === 'TOTAL');

    expect(clStandings.standings.length).toBe(3);
    expect(rows).toHaveLength(total.table.length);
  });

  it('renames the provider fields to ours', () => {
    const rows = mapStandings(clStandings);
    const first = clStandings.standings[0].table[0];

    expect(rows[0]).toEqual({
      providerStage: 'LEAGUE_STAGE',
      groupName: null,
      providerTeamId: String(first.team.id),
      position: first.position,
      played: first.playedGames,
      won: first.won,
      drawn: first.draw,
      lost: first.lost,
      goalsFor: first.goalsFor,
      goalsAgainst: first.goalsAgainst,
      goalDifference: first.goalDifference,
      points: first.points,
      form: first.form,
    });
  });

  it('produces one row per team, satisfying the live_standings unique key', () => {
    const rows = mapStandings(clStandings);
    const keys = rows.map(r => `${r.providerStage}:${r.providerTeamId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stores an empty form string as null', () => {
    const rows = mapStandings({
      standings: [
        { stage: 'LEAGUE_STAGE', type: 'TOTAL', group: null, table: [{ position: 1, team: { id: 1 }, form: '' }] },
      ],
    });
    expect(rows[0].form).toBeNull();
  });

  it('returns an empty array for a season with no table yet', () => {
    expect(mapStandings({ standings: [] })).toEqual([]);
    expect(mapStandings({})).toEqual([]);
    expect(mapStandings(null)).toEqual([]);
  });
});

describe('matchSeasonYear', () => {
  it('reads the year off the match\'s own season start date', () => {
    expect(matchSeasonYear(plMatches.matches[0])).toBe('2026');
    expect(matchSeasonYear(clMatches.matches[0])).toBe('2024');
  });

  it('is null when the payload carries no season', () => {
    expect(matchSeasonYear({})).toBeNull();
    expect(matchSeasonYear({ season: { startDate: null } })).toBeNull();
  });
});

// The reason this exists: on 29 August 2026 the Champions League tournament sat at zero
// fixtures two days after the draw. `season=` returning nothing while the unfiltered
// endpoint has the season's matches is one of the two ways that happens, and it is the
// only one the adapter can do anything about.
describe('FootballDataProvider.fetchFixtures', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Stub fetch, returning a body per requested path. Records the paths asked for. */
  function stubFetch(bodyByPath: Record<string, unknown>) {
    const paths: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      const path = String(url).replace('https://api.football-data.org/v4', '');
      paths.push(path);
      const body = bodyByPath[path];
      if (body === undefined) {
        return new Response('{"message":"not found"}', { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }) as any;
    return paths;
  }

  const provider = () => new FootballDataProvider('test-key', new RateLimiter({ limit: 50, intervalMs: 1000 }));

  it('uses the season-filtered response when it has matches, and asks nothing else', async () => {
    const paths = stubFetch({ '/competitions/PL/matches?season=2026': plMatches });

    const fixtures = await provider().fetchFixtures('PL', '2026');

    expect(fixtures).toHaveLength(plMatches.matches.length);
    expect(paths).toEqual(['/competitions/PL/matches?season=2026']);
  });

  it('falls back to the unfiltered endpoint when season= comes back empty', async () => {
    const paths = stubFetch({
      '/competitions/CL/matches?season=2026': { matches: [] },
      '/competitions/CL/matches': plMatches,
    });

    const fixtures = await provider().fetchFixtures('CL', '2026');

    // plMatches is a 2026 payload, so both of its matches survive the season filter.
    expect(fixtures).toHaveLength(plMatches.matches.length);
    expect(paths).toEqual(['/competitions/CL/matches?season=2026', '/competitions/CL/matches']);
  });

  it('keeps only the requested season out of the fallback', async () => {
    stubFetch({
      '/competitions/CL/matches?season=2026': { matches: [] },
      // The unfiltered endpoint serves whatever the provider calls the current season.
      '/competitions/CL/matches': clMatches,
    });

    // clMatches is 2024, so nothing in it may be attributed to 2026.
    expect(await provider().fetchFixtures('CL', '2026')).toEqual([]);
  });

  it('does not fall back on an empty window request', async () => {
    const paths = stubFetch({
      '/competitions/CL/matches?season=2026&dateFrom=2026-08-28&dateTo=2026-08-30': { matches: [] },
    });

    const fixtures = await provider().fetchFixtures('CL', '2026', {
      dateFrom: '2026-08-28',
      dateTo: '2026-08-30',
    });

    // An empty three-day window is ordinary, not a symptom.
    expect(fixtures).toEqual([]);
    expect(paths).toHaveLength(1);
  });

  it('still reports an unpublished season as a 404, without a fallback request', async () => {
    const paths = stubFetch({});

    await expect(provider().fetchFixtures('CL', '2026')).rejects.toMatchObject({
      status: 404,
    });
    await expect(provider().fetchFixtures('CL', '2026')).rejects.toBeInstanceOf(ProviderError);
    expect(paths).toEqual([
      '/competitions/CL/matches?season=2026',
      '/competitions/CL/matches?season=2026',
    ]);
  });
});

// A diagnostic that throws on the first refusal answers nothing: the point is to see
// which endpoints refused and which did not.
describe('FootballDataProvider.probe', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(bodyByPath: Record<string, { status?: number; body: unknown }>) {
    globalThis.fetch = vi.fn(async (url: any) => {
      const path = String(url).replace('https://api.football-data.org/v4', '');
      const hit = bodyByPath[path];
      if (!hit) return new Response('{"message":"not found"}', { status: 404 });
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
    }) as any;
  }

  const provider = () =>
    new FootballDataProvider('test-key', new RateLimiter({ limit: 50, intervalMs: 1000 }));

  it('reports every endpoint, refusals included, without throwing', async () => {
    stubFetch({
      '/competitions/CL': { body: { currentSeason: { startDate: '2026-09-15' }, seasons: [{ startDate: '2026-09-15' }] } },
      '/competitions/CL/matches?season=2026': { body: { matches: [] } },
      '/competitions/CL/matches': { body: clMatches },
      '/competitions/CL/teams?season=2026': { status: 403, body: { message: 'restricted' } },
      '/competitions/CL/standings?season=2026': { body: clStandings },
    });

    const probes = await provider().probe('CL', '2026');
    const by = new Map(probes.map(p => [p.key, p]));

    expect(probes.map(p => p.key)).toEqual([
      'competition',
      'matches_season',
      'matches_unfiltered',
      'teams',
      'standings',
    ]);
    expect(by.get('competition')!.countForSeason).toBe(1);
    expect(by.get('matches_season')!.count).toBe(0);
    // clMatches is a 2024 payload, so none of it counts towards 2026.
    expect(by.get('matches_unfiltered')!.count).toBe(clMatches.matches.length);
    expect(by.get('matches_unfiltered')!.countForSeason).toBe(0);
    expect(by.get('teams')!.ok).toBe(false);
    expect(by.get('teams')!.status).toBe(403);
    expect(by.get('standings')!.count).toBeGreaterThan(0);
  });

  it('records the URL it asked for, so the request itself can be checked', async () => {
    stubFetch({});
    const probes = await provider().probe('CL', '2026');

    expect(probes.find(p => p.key === 'matches_season')!.url).toBe(
      'https://api.football-data.org/v4/competitions/CL/matches?season=2026',
    );
    expect(probes.every(p => !p.ok && p.status === 404)).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('runs requests up to the limit without delay', async () => {
    const limiter = new RateLimiter({ limit: 3, intervalMs: 10_000 });
    const started = Date.now();
    const results = await Promise.all([1, 2, 3].map(n => limiter.schedule(async () => n)));

    expect(results).toEqual([1, 2, 3]);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('delays a request that would exceed the limit', async () => {
    const limiter = new RateLimiter({ limit: 2, intervalMs: 200 });
    const started = Date.now();
    await Promise.all([1, 2, 3].map(n => limiter.schedule(async () => n)));

    // The third has to wait for the first to age out of the window.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('preserves FIFO order', async () => {
    const limiter = new RateLimiter({ limit: 1, intervalMs: 20 });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map(n => limiter.schedule(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps draining after a task rejects', async () => {
    const limiter = new RateLimiter({ limit: 5, intervalMs: 1000 });
    const failed = limiter.schedule(async () => {
      throw new Error('boom');
    });

    await expect(failed).rejects.toThrow('boom');
    await expect(limiter.schedule(async () => 'ok')).resolves.toBe('ok');
  });

  it('reports remaining budget and spends it', async () => {
    const limiter = new RateLimiter({ limit: 3, intervalMs: 10_000 });
    expect(limiter.availableNow()).toBe(3);

    await limiter.schedule(async () => null);
    expect(limiter.availableNow()).toBe(2);
  });

  it('reports no budget while paused after a 429', () => {
    const limiter = new RateLimiter({ limit: 10, intervalMs: 1000 });
    limiter.pauseFor(5_000);
    expect(limiter.availableNow()).toBe(0);
  });
});
