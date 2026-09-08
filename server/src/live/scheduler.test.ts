import { describe, expect, it } from 'vitest';
import {
  classifyTournament,
  nextSyncDueAt,
  planTick,
  resolveSyncEnabled,
  resolveSyncEnabledFromEnv,
  type SchedulableTournament,
} from './scheduler';

// The scheduler's budgeting, isolated from the database and the provider. What matters
// here is that a busy competition cannot starve the others and that the free tier's
// 10 requests/minute is never overspent.

const NOW = new Date('2026-08-21T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tournament(over: Partial<SchedulableTournament> = {}): SchedulableTournament {
  return {
    id: 't1',
    lastStructureSyncAt: null,
    lastFixtureSyncAt: null,
    nextKickoffAt: null,
    hasLiveFixture: false,
    ...over,
  };
}

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe('classifyTournament', () => {
  it('is hot while a fixture is being played', () => {
    expect(classifyTournament(tournament({ hasLiveFixture: true }), NOW)).toBe('hot');
  });

  it('is hot just before kickoff', () => {
    expect(classifyTournament(tournament({ nextKickoffAt: at(10 * MINUTE) }), NOW)).toBe('hot');
  });

  // A fixture that kicked off an hour ago is still being played, and its status may not
  // have been updated yet — that is exactly when polling matters most.
  it('stays hot for a fixture that recently kicked off', () => {
    expect(classifyTournament(tournament({ nextKickoffAt: at(-1 * HOUR) }), NOW)).toBe('hot');
  });

  it('goes cold once a kickoff is long past', () => {
    expect(classifyTournament(tournament({ nextKickoffAt: at(-5 * HOUR) }), NOW)).toBe('cold');
  });

  it('is warm for something later today', () => {
    expect(classifyTournament(tournament({ nextKickoffAt: at(6 * HOUR) }), NOW)).toBe('warm');
  });

  it('is cold for something next week', () => {
    expect(classifyTournament(tournament({ nextKickoffAt: at(7 * 24 * HOUR) }), NOW)).toBe('cold');
  });

  // The Champions League before its draw: no fixtures at all, so nothing is imminent.
  it('is cold when no kickoff is known', () => {
    expect(classifyTournament(tournament(), NOW)).toBe('cold');
  });
});

describe('planTick', () => {
  it('polls a hot tournament with a cheap window sync', () => {
    const planned = planTick(
      [tournament({ hasLiveFixture: true, lastStructureSyncAt: at(-1 * MINUTE) })],
      6,
      NOW,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ kind: 'window', temperature: 'hot', cost: 1 });
  });

  it('uses a full structure sync for a cold tournament', () => {
    const planned = planTick([tournament()], 6, NOW);
    expect(planned[0]).toMatchObject({ kind: 'structure', temperature: 'cold', cost: 3 });
  });

  it('skips a hot tournament synced within the last minute', () => {
    const planned = planTick(
      [
        tournament({
          hasLiveFixture: true,
          lastFixtureSyncAt: at(-20_000),
          lastStructureSyncAt: at(-1 * MINUTE),
        }),
      ],
      6,
      NOW,
    );
    expect(planned).toEqual([]);
  });

  // Nothing has ever been fetched for it, so the window sync alone would leave it with no
  // teams and no table.
  it('always plans a structure sync for a tournament that has never had one', () => {
    const planned = planTick([tournament({ hasLiveFixture: true })], 6, NOW);
    expect(planned.map(p => p.kind)).toEqual(['window', 'structure']);
  });

  it('skips a cold tournament synced within the last six hours', () => {
    const planned = planTick([tournament({ lastStructureSyncAt: at(-2 * HOUR) })], 6, NOW);
    expect(planned).toEqual([]);
  });

  it('skips a warm tournament synced within the last fifteen minutes', () => {
    const planned = planTick(
      [
        tournament({
          nextKickoffAt: at(6 * HOUR),
          lastFixtureSyncAt: at(-5 * MINUTE),
          lastStructureSyncAt: at(-1 * MINUTE),
        }),
      ],
      6,
      NOW,
    );
    expect(planned).toEqual([]);
  });

  it('never plans more requests than the budget allows', () => {
    const cold = [1, 2, 3, 4].map(n => tournament({ id: `t${n}` }));
    const planned = planTick(cold, 6, NOW);

    // Structure syncs cost 3 each, so a budget of 6 buys exactly two.
    expect(planned).toHaveLength(2);
    expect(planned.reduce((sum, p) => sum + p.cost, 0)).toBeLessThanOrEqual(6);
  });

  it('serves hot tournaments before cold ones', () => {
    const planned = planTick(
      [tournament({ id: 'cold' }), tournament({ id: 'hot', hasLiveFixture: true })],
      6,
      NOW,
    );
    expect(planned[0].tournamentId).toBe('hot');
  });

  it('breaks ties by staleness so no tournament is starved', () => {
    const planned = planTick(
      [
        tournament({
          id: 'fresher',
          hasLiveFixture: true,
          lastFixtureSyncAt: at(-2 * MINUTE),
          lastStructureSyncAt: at(-1 * MINUTE),
        }),
        tournament({
          id: 'staler',
          hasLiveFixture: true,
          lastFixtureSyncAt: at(-30 * MINUTE),
          lastStructureSyncAt: at(-1 * MINUTE),
        }),
      ],
      6,
      NOW,
    );
    expect(planned.map(p => p.tournamentId)).toEqual(['staler', 'fresher']);
  });

  // A tournament playing every day never goes cold, so without this its table, its
  // qualification statuses and its scorers' goal counts would never refresh.
  it('refreshes the structure of a busy tournament that never cools down', () => {
    const planned = planTick(
      [
        tournament({
          hasLiveFixture: true,
          lastFixtureSyncAt: at(-2 * MINUTE),
          lastStructureSyncAt: at(-7 * HOUR),
        }),
      ],
      6,
      NOW,
    );
    expect(planned.map(p => p.kind)).toEqual(['window', 'structure']);
  });

  it('leaves a recently refreshed structure alone', () => {
    const planned = planTick(
      [
        tournament({
          hasLiveFixture: true,
          lastFixtureSyncAt: at(-2 * MINUTE),
          lastStructureSyncAt: at(-2 * HOUR),
        }),
      ],
      6,
      NOW,
    );
    expect(planned.map(p => p.kind)).toEqual(['window']);
  });

  // Live scores are what somebody is watching; the table is not.
  it('serves live scores before a structure refresh when the budget is tight', () => {
    const planned = planTick(
      [
        tournament({ id: 'stale-structure', lastStructureSyncAt: at(-9 * HOUR) }),
        tournament({ id: 'live', hasLiveFixture: true, lastStructureSyncAt: at(-1 * MINUTE) }),
      ],
      1,
      NOW,
    );
    expect(planned.map(p => p.tournamentId)).toEqual(['live']);
  });

  // With a budget of 1 a structure sync does not fit, but a cheaper window sync behind it
  // still should — the budget check skips rather than stops.
  it('fits a cheaper job when an expensive one does not', () => {
    const planned = planTick(
      [tournament({ id: 'cold' }), tournament({ id: 'hot', hasLiveFixture: true })],
      1,
      NOW,
    );
    expect(planned.map(p => p.tournamentId)).toEqual(['hot']);
  });

  it('plans nothing when there are no tournaments', () => {
    expect(planTick([], 6, NOW)).toEqual([]);
  });
});

describe('nextSyncDueAt', () => {
  it('is a minute after the last poll while a match is on', () => {
    const due = nextSyncDueAt(
      tournament({
        hasLiveFixture: true,
        lastFixtureSyncAt: at(-20_000),
        lastStructureSyncAt: at(-1 * MINUTE),
      }),
      NOW,
    );
    expect(due.getTime()).toBe(NOW.getTime() + 40_000);
  });

  // Something overdue reads as "now" rather than as a countdown that has gone negative.
  it('never points into the past', () => {
    const due = nextSyncDueAt(tournament({ hasLiveFixture: true }), NOW);
    expect(due.getTime()).toBe(NOW.getTime());
  });

  it('falls back to the structure refresh when that is what comes first', () => {
    const due = nextSyncDueAt(
      tournament({
        nextKickoffAt: at(6 * HOUR),
        lastFixtureSyncAt: at(-1 * MINUTE),
        lastStructureSyncAt: at(-5 * HOUR),
      }),
      NOW,
    );
    // Warm, so the window sync is due in 14 minutes and the structure refresh in one hour.
    expect(due.getTime()).toBe(NOW.getTime() + 14 * MINUTE);
  });
});

// The switch that decides whether any of this runs at all. The rule that matters: a
// production deployment with a key syncs on its own, without one more variable being set.
describe('resolveSyncEnabledFromEnv', () => {
  it('is on in production once a provider key is configured', () => {
    expect(
      resolveSyncEnabledFromEnv({ NODE_ENV: 'production', FOOTBALL_DATA_API_KEY: 'k' }),
    ).toEqual({ enabled: true, reason: 'production-default' });
  });

  it('is off in production with no key, since there is nothing to sync from', () => {
    expect(resolveSyncEnabledFromEnv({ NODE_ENV: 'production' })).toEqual({
      enabled: false,
      reason: 'no-provider-key',
    });
  });

  // Two developers running `npm run dev` would otherwise share, and exhaust, the
  // account-wide request budget.
  it('is off in development unless asked for', () => {
    expect(resolveSyncEnabledFromEnv({ NODE_ENV: 'development', FOOTBALL_DATA_API_KEY: 'k' })).toEqual(
      { enabled: false, reason: 'development-default' },
    );
  });

  it('honours an explicit setting in both directions', () => {
    expect(
      resolveSyncEnabledFromEnv({ NODE_ENV: 'development', LIVE_SYNC_ENABLED: 'true' }).enabled,
    ).toBe(true);
    expect(
      resolveSyncEnabledFromEnv({
        NODE_ENV: 'production',
        FOOTBALL_DATA_API_KEY: 'k',
        LIVE_SYNC_ENABLED: 'false',
      }).enabled,
    ).toBe(false);
  });
});

describe('resolveSyncEnabled', () => {
  const production = { NODE_ENV: 'production', FOOTBALL_DATA_API_KEY: 'k' };

  it('lets an admin turn the sync off without a redeploy', () => {
    expect(resolveSyncEnabled(false, production).enabled).toBe(false);
  });

  it('lets an admin turn it on where the environment would not have', () => {
    expect(resolveSyncEnabled(true, { NODE_ENV: 'development' }).enabled).toBe(true);
  });

  // Clearing the override is not the same as forcing it off.
  it('defers to the environment when there is no override', () => {
    expect(resolveSyncEnabled(null, production).enabled).toBe(true);
  });

  // The kill switch a developer sets so their machine spends nothing must not be
  // reachable from a database somebody else is also using.
  it('cannot be overridden past an explicit LIVE_SYNC_ENABLED=false', () => {
    expect(resolveSyncEnabled(true, { ...production, LIVE_SYNC_ENABLED: 'false' })).toEqual({
      enabled: false,
      reason: 'env-off',
      override: true,
    });
  });
});
