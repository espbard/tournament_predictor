import { describe, it, expect } from 'vitest';
import { resolveFirstRoundSlots, type GroupStandingTeam } from '@tournament-predictor/shared';

function team(teamId: string, points: number, gd: number, gf: number): GroupStandingTeam {
  return { teamId, points, gd, gf };
}

describe('resolveFirstRoundSlots', () => {
  it('resolves a direct-qualifier slot and a lucky-loser slot in the same match', () => {
    // 5 groups (A-E) so the WC2026 lucky-loser combo for the first empty slot (A,B,C,D,F)
    // is filtered down to the groups that actually exist here.
    const standings = new Map<string, GroupStandingTeam[]>([
      ['A', [team('a1', 9, 5, 8), team('a2', 6, 1, 4), team('a3', 4, 0, 3)]],
      ['B', [team('b1', 9, 5, 8), team('b2', 6, 1, 4), team('b3', 1, -3, 1)]],
      ['C', [team('c1', 9, 5, 8), team('c2', 6, 1, 4), team('c3', 2, -2, 2)]],
      ['D', [team('d1', 9, 5, 8), team('d2', 6, 1, 4), team('d3', 0, -4, 0)]],
    ]);

    // Match 1: home is the direct qualifier "1A", away is left blank → lucky loser slot.
    const bracketSlots = { m1_home: '1A' };

    const resolved = resolveFirstRoundSlots(bracketSlots, standings, 2, 1, {});

    expect(resolved['m1_home']).toBe('a1');
    // Before the fix, any slot not present in bracketSlots resolved to null even
    // though a lucky-loser team should fill it. The best-ranked third-place team
    // among the eligible groups (A, B, C, D here) is a3 (4 pts, gd 0, gf 3).
    expect(resolved['m1_away']).toBe('a3');
  });

  it('returns null for a slot that has no label and no eligible lucky-loser teams', () => {
    const standings = new Map<string, GroupStandingTeam[]>([
      ['A', [team('a1', 9, 5, 8), team('a2', 6, 1, 4)]],
    ]);
    const resolved = resolveFirstRoundSlots({}, standings, 2, 1, {});
    expect(resolved['m1_home']).toBeNull();
  });

  it('only ever assigns lucky-loser slots to the top-N ranked third-place teams, never a lower-ranked one', () => {
    // Only groups A, C, D exist. Each has a third-place ("lucky loser") candidate.
    // The WC2026 combo table (filtered to these existing groups) gives:
    //   slot m1_away (combo #1 'A,B,C,D,F' ∩ {A,C,D}) -> eligible {A, C, D}
    //   slot m2_away (combo #2 'C,D,F,G,H' ∩ {A,C,D}) -> eligible {C, D}
    // Only 2 lucky-loser slots exist, so per the real qualification rule exactly
    // the top-2 ranked third-place teams (by points/GD/GF) should qualify —
    // d3 (rank 1) and a3 (rank 2) — while c3 (rank 3, worst) must never appear,
    // even though a naive slot-filling algorithm could be tempted to swap it in
    // when the higher-ranked teams don't trivially fit slot order.
    const standings = new Map<string, GroupStandingTeam[]>([
      ['A', [team('a1', 9, 5, 8), team('a2', 6, 1, 4), team('a3', 4, 1, 3)]],
      ['C', [team('c1', 9, 5, 8), team('c2', 6, 1, 4), team('c3', 2, -1, 1)]],
      ['D', [team('d1', 9, 5, 8), team('d2', 6, 1, 4), team('d3', 6, 3, 5)]],
    ]);
    const bracketSlots = { m1_home: '1A', m2_home: '1C' };

    const resolved = resolveFirstRoundSlots(bracketSlots, standings, 2, 2, {});

    const llAssignments = [resolved['m1_away'], resolved['m2_away']];
    expect(llAssignments.sort()).toEqual(['a3', 'd3']);
    expect(llAssignments).not.toContain('c3');
  });
});
