import { describe, expect, it } from 'vitest';
import { deriveMatchdays, type MatchdayAssignable } from './matchdays';

// The matchday is the gameweek: get this wrong and the admin's selected-matches panel
// groups the wrong fixtures together, or shows none at all. Pure, so it is pinned
// directly — see the plan's note that server/src/db/client.ts connects at import time.

function fixture(
  providerFixtureId: string,
  kickoff: string | null,
  over: Partial<MatchdayAssignable> = {},
): MatchdayAssignable {
  return {
    providerFixtureId,
    stageKey: 'league_phase',
    matchday: null,
    kickoffAt: kickoff ? new Date(kickoff) : null,
    ...over,
  };
}

describe('deriveMatchdays', () => {
  // The real shape of a Champions League league phase: each round played across a
  // Tuesday and a Wednesday, the next round a fortnight later.
  it('recovers the round numbering from a league-phase calendar', () => {
    const fixtures = [
      fixture('r1-tue-a', '2026-09-15T19:00:00Z'),
      fixture('r1-tue-b', '2026-09-15T21:00:00Z'),
      fixture('r1-wed-a', '2026-09-16T19:00:00Z'),
      fixture('r2-tue-a', '2026-09-29T19:00:00Z'),
      fixture('r2-wed-a', '2026-09-30T21:00:00Z'),
      fixture('r3-tue-a', '2026-10-20T19:00:00Z'),
    ];

    const out = deriveMatchdays(fixtures);

    expect(out.get('r1-tue-a')).toBe(1);
    expect(out.get('r1-tue-b')).toBe(1);
    expect(out.get('r1-wed-a')).toBe(1);
    expect(out.get('r2-tue-a')).toBe(2);
    expect(out.get('r2-wed-a')).toBe(2);
    expect(out.get('r3-tue-a')).toBe(3);
  });

  it('holds a round that spreads over three nights together', () => {
    const out = deriveMatchdays([
      fixture('a', '2026-09-15T19:00:00Z'),
      fixture('b', '2026-09-16T19:00:00Z'),
      fixture('c', '2026-09-17T19:00:00Z'),
      fixture('d', '2026-09-29T19:00:00Z'),
    ]);

    expect([out.get('a'), out.get('b'), out.get('c')]).toEqual([1, 1, 1]);
    expect(out.get('d')).toBe(2);
  });

  it('does not chain a continuous run of fixtures into one endless round', () => {
    // Every three days, so no single gap ever ends a round: only the span guard does.
    const out = deriveMatchdays([
      fixture('a', '2026-09-01T19:00:00Z'),
      fixture('b', '2026-09-04T19:00:00Z'),
      fixture('c', '2026-09-07T19:00:00Z'),
      fixture('d', '2026-09-10T19:00:00Z'),
      fixture('e', '2026-09-13T19:00:00Z'),
    ]);

    // Six days after the round began is still inside it; nine days is not.
    expect([out.get('a'), out.get('b'), out.get('c')]).toEqual([1, 1, 1]);
    expect([out.get('d'), out.get('e')]).toEqual([2, 2]);
  });

  it('numbers each stage from one', () => {
    const out = deriveMatchdays([
      fixture('lp-1', '2026-09-15T19:00:00Z'),
      fixture('lp-2', '2026-09-29T19:00:00Z'),
      fixture('ko-1', '2027-02-17T19:00:00Z', { stageKey: 'knockout_playoff' }),
      fixture('ko-2', '2027-02-24T19:00:00Z', { stageKey: 'knockout_playoff' }),
    ]);

    expect(out.get('lp-1')).toBe(1);
    expect(out.get('lp-2')).toBe(2);
    // A two-legged tie: the legs are a week apart, which is the leg number the tie
    // grouping wants.
    expect(out.get('ko-1')).toBe(1);
    expect(out.get('ko-2')).toBe(2);
  });

  // football-data reports a matchday on every fixture; this must not touch those.
  it('leaves a stage alone when the provider reported any matchday', () => {
    const out = deriveMatchdays([
      fixture('a', '2026-09-15T19:00:00Z', { matchday: 1 }),
      fixture('b', '2026-09-29T19:00:00Z', { matchday: 2 }),
      fixture('c', '2026-10-20T19:00:00Z', { matchday: 3 }),
    ]);

    expect(out.get('a')).toBe(1);
    expect(out.get('b')).toBe(2);
    expect(out.get('c')).toBe(3);
  });

  // Half-reported is the dangerous case: deriving the rest would produce two different
  // fixtures both labelled matchday 2.
  it('refuses to mix reported and derived numbering within a stage', () => {
    const out = deriveMatchdays([
      fixture('reported', '2026-09-15T19:00:00Z', { matchday: 5 }),
      fixture('missing', '2026-09-29T19:00:00Z'),
    ]);

    expect(out.get('reported')).toBe(5);
    expect(out.get('missing')).toBeNull();
  });

  it('leaves a fixture with no kickoff time unplaced', () => {
    const out = deriveMatchdays([
      fixture('dated', '2026-09-15T19:00:00Z'),
      fixture('undated', null),
    ]);

    expect(out.get('dated')).toBe(1);
    expect(out.get('undated')).toBeNull();
  });

  it('leaves a fixture with no stage unplaced', () => {
    const out = deriveMatchdays([fixture('nostage', '2026-09-15T19:00:00Z', { stageKey: null })]);
    expect(out.get('nostage')).toBeNull();
  });

  it('is independent of the order fixtures arrive in', () => {
    const dates = [
      ['a', '2026-09-15T19:00:00Z'],
      ['b', '2026-09-16T19:00:00Z'],
      ['c', '2026-09-29T19:00:00Z'],
    ] as const;

    const forwards = deriveMatchdays(dates.map(([id, at]) => fixture(id, at)));
    const backwards = deriveMatchdays([...dates].reverse().map(([id, at]) => fixture(id, at)));

    expect([...forwards.entries()].sort()).toEqual([...backwards.entries()].sort());
  });

  it('handles an empty list', () => {
    expect(deriveMatchdays([]).size).toBe(0);
  });
});
