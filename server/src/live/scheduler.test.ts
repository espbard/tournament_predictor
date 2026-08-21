import { describe, expect, it } from 'vitest';
import { classifyTournament, planTick, type SchedulableTournament } from './scheduler';

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
    const planned = planTick([tournament({ hasLiveFixture: true })], 6, NOW);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ kind: 'window', temperature: 'hot', cost: 1 });
  });

  it('uses a full structure sync for a cold tournament', () => {
    const planned = planTick([tournament()], 6, NOW);
    expect(planned[0]).toMatchObject({ kind: 'structure', temperature: 'cold', cost: 3 });
  });

  it('skips a hot tournament synced within the last minute', () => {
    const planned = planTick(
      [tournament({ hasLiveFixture: true, lastFixtureSyncAt: at(-20_000) })],
      6,
      NOW,
    );
    expect(planned).toEqual([]);
  });

  it('skips a cold tournament synced within the last six hours', () => {
    const planned = planTick([tournament({ lastStructureSyncAt: at(-2 * HOUR) })], 6, NOW);
    expect(planned).toEqual([]);
  });

  it('skips a warm tournament synced within the last fifteen minutes', () => {
    const planned = planTick(
      [tournament({ nextKickoffAt: at(6 * HOUR), lastFixtureSyncAt: at(-5 * MINUTE) })],
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
        tournament({ id: 'fresher', hasLiveFixture: true, lastFixtureSyncAt: at(-2 * MINUTE) }),
        tournament({ id: 'staler', hasLiveFixture: true, lastFixtureSyncAt: at(-30 * MINUTE) }),
      ],
      6,
      NOW,
    );
    expect(planned.map(p => p.tournamentId)).toEqual(['staler', 'fresher']);
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
