import { describe, it, expect } from 'vitest';
import {
  calculateMatchPoints,
  computeGroupStandings,
  calculateGroupPositionPoints,
  getUserPredictedTeamForKnockoutSlot,
  calculateKnockoutPoints,
  type KnockoutMatchSlot,
} from './scoring.js';
import type { ScoringConfig, BracketPredictions } from '@tournament-predictor/shared';

const CONFIG: ScoringConfig = {
  exact_score: 3,
  correct_result: 1,
  correct_group_position: 1,
  correct_team_progresses: 2,
  correct_team_in_knockout_tie: 1,
  correct_team_in_final: 5,
  correct_winner: 10,
};

// ── calculateMatchPoints ──────────────────────────────────────────────────────

describe('calculateMatchPoints', () => {
  it('awards exact_score + correct_result for exact match', () => {
    const result = calculateMatchPoints(
      { homeScore: 2, awayScore: 1, progressingTeamId: null },
      { homeScore: 2, awayScore: 1, stage: 'group' },
      CONFIG,
    );
    expect(result.points).toBe(4); // exact(3) + result(1)
    expect(result.breakdown.exactScore).toBe(3);
    expect(result.breakdown.correctResult).toBe(1);
  });

  it('awards only correct_result for correct direction', () => {
    const result = calculateMatchPoints(
      { homeScore: 3, awayScore: 0, progressingTeamId: null },
      { homeScore: 1, awayScore: 0, stage: 'group' },
      CONFIG,
    );
    expect(result.points).toBe(1);
    expect(result.breakdown.exactScore).toBe(0);
    expect(result.breakdown.correctResult).toBe(1);
  });

  it('awards 0 for wrong result', () => {
    const result = calculateMatchPoints(
      { homeScore: 2, awayScore: 0, progressingTeamId: null },
      { homeScore: 0, awayScore: 1, stage: 'group' },
      CONFIG,
    );
    expect(result.points).toBe(0);
  });

  it('awards correct_result for correct draw prediction', () => {
    const result = calculateMatchPoints(
      { homeScore: 1, awayScore: 1, progressingTeamId: null },
      { homeScore: 0, awayScore: 0, stage: 'group' },
      CONFIG,
    );
    expect(result.points).toBe(1);
  });

  it('awards correct_team_progresses for knockout when progressing team matches', () => {
    const result = calculateMatchPoints(
      { homeScore: 1, awayScore: 1, progressingTeamId: 'team-a' },
      { homeScore: 1, awayScore: 1, stage: 'round_of_16', actualProgressingTeamId: 'team-a' },
      CONFIG,
    );
    expect(result.breakdown.correctTeamProgresses).toBe(2);
  });

  it('does not award correct_team_progresses for group stage', () => {
    const result = calculateMatchPoints(
      { homeScore: 1, awayScore: 1, progressingTeamId: 'team-a' },
      { homeScore: 1, awayScore: 1, stage: 'group', actualProgressingTeamId: 'team-a' },
      CONFIG,
    );
    expect(result.breakdown.correctTeamProgresses).toBe(0);
  });

  it('does not award correct_team_progresses for knockout when team is wrong', () => {
    const result = calculateMatchPoints(
      { homeScore: 1, awayScore: 1, progressingTeamId: 'team-b' },
      { homeScore: 1, awayScore: 1, stage: 'semi_final', actualProgressingTeamId: 'team-a' },
      CONFIG,
    );
    expect(result.breakdown.correctTeamProgresses).toBe(0);
  });
});

// ── computeGroupStandings ─────────────────────────────────────────────────────

describe('computeGroupStandings', () => {
  const teamGroupMap = new Map([
    ['t1', 'A'], ['t2', 'A'], ['t3', 'A'],
  ]);

  it('ranks by points then goal difference', () => {
    // t1 beats t2 2-0 and t3 1-0; t2 draws t3 1-1
    // t1: 6pts GD=+3; t3: 1pt GD=-1 (lost 0-1, drew 1-1); t2: 1pt GD=-2 (lost 0-2, drew 1-1)
    const matchList = [
      { homeTeamId: 't1', awayTeamId: 't2', homeScore: 2, awayScore: 0 },
      { homeTeamId: 't1', awayTeamId: 't3', homeScore: 1, awayScore: 0 },
      { homeTeamId: 't2', awayTeamId: 't3', homeScore: 1, awayScore: 1 },
    ];
    const standings = computeGroupStandings(matchList, teamGroupMap);
    const groupA = standings.get('A')!;
    expect(groupA[0].teamId).toBe('t1'); // 6 pts
    expect(groupA[1].teamId).toBe('t3'); // 1 pt, GD=-1
    expect(groupA[2].teamId).toBe('t2'); // 1 pt, GD=-2
  });

  it('breaks ties with goal difference', () => {
    const teamGroupMap2 = new Map([['t1', 'A'], ['t2', 'A']]);
    const matchList = [
      { homeTeamId: 't1', awayTeamId: 't2', homeScore: 3, awayScore: 1 },
    ];
    const standings = computeGroupStandings(matchList, teamGroupMap2);
    const groupA = standings.get('A')!;
    expect(groupA[0].teamId).toBe('t1');
    expect(groupA[0].gd).toBe(2);
  });

  it('returns empty map for no completed matches', () => {
    const standings = computeGroupStandings([], teamGroupMap);
    expect(standings.size).toBe(0);
  });
});

// ── calculateGroupPositionPoints ─────────────────────────────────────────────

describe('calculateGroupPositionPoints', () => {
  it('awards 1pt per correct position', () => {
    const actual = new Map([['A', [{ teamId: 't1', points: 6, gd: 3, gf: 5 }, { teamId: 't2', points: 3, gd: 0, gf: 2 }]]]);
    const predicted = new Map([['A', [{ teamId: 't1', points: 6, gd: 3, gf: 5 }, { teamId: 't2', points: 3, gd: 0, gf: 2 }]]]);
    expect(calculateGroupPositionPoints(actual, predicted, CONFIG)).toBe(2);
  });

  it('awards 0 for wrong predictions', () => {
    const actual = new Map([['A', [{ teamId: 't1', points: 6, gd: 3, gf: 5 }, { teamId: 't2', points: 3, gd: 0, gf: 2 }]]]);
    const predicted = new Map([['A', [{ teamId: 't2', points: 3, gd: 0, gf: 2 }, { teamId: 't1', points: 6, gd: 3, gf: 5 }]]]);
    expect(calculateGroupPositionPoints(actual, predicted, CONFIG)).toBe(0);
  });

  it('awards partial credit', () => {
    const actual = new Map([
      ['A', [
        { teamId: 't1', points: 9, gd: 5, gf: 6 },
        { teamId: 't2', points: 4, gd: 1, gf: 3 },
        { teamId: 't3', points: 0, gd: -6, gf: 0 },
      ]],
    ]);
    const predicted = new Map([
      ['A', [
        { teamId: 't1', points: 9, gd: 5, gf: 6 }, // correct (1pt)
        { teamId: 't3', points: 0, gd: -6, gf: 0 }, // wrong
        { teamId: 't2', points: 4, gd: 1, gf: 3 }, // wrong
      ]],
    ]);
    expect(calculateGroupPositionPoints(actual, predicted, CONFIG)).toBe(1);
  });
});

// ── getUserPredictedTeamForKnockoutSlot ───────────────────────────────────────

describe('getUserPredictedTeamForKnockoutSlot', () => {
  const r16Matches = [
    { id: 'r16-0', stage: 'round_of_16', homeTeamId: 'team-a', awayTeamId: 'team-b' },
    { id: 'r16-1', stage: 'round_of_16', homeTeamId: 'team-c', awayTeamId: 'team-d' },
    { id: 'r16-2', stage: 'round_of_16', homeTeamId: 'team-e', awayTeamId: 'team-f' },
    { id: 'r16-3', stage: 'round_of_16', homeTeamId: 'team-g', awayTeamId: 'team-h' },
  ];
  const qfMatches = [
    { id: 'qf-0', stage: 'quarter_final', homeTeamId: null, awayTeamId: null },
    { id: 'qf-1', stage: 'quarter_final', homeTeamId: null, awayTeamId: null },
  ];
  const sfMatches = [
    { id: 'sf-0', stage: 'semi_final', homeTeamId: null, awayTeamId: null },
  ];
  const finalMatches = [
    { id: 'f-0', stage: 'final', homeTeamId: null, awayTeamId: null },
  ];

  const matchesByStage = new Map<string, KnockoutMatchSlot[]>([
    ['round_of_16', r16Matches],
    ['quarter_final', qfMatches],
    ['semi_final', sfMatches],
    ['final', finalMatches],
  ]);

  it('returns actual team for first-round home slot', () => {
    const result = getUserPredictedTeamForKnockoutSlot(
      'round_of_16', 0, 'home', 'round_of_16', matchesByStage, {},
    );
    expect(result).toBe('team-a');
  });

  it('returns actual team for first-round away slot', () => {
    const result = getUserPredictedTeamForKnockoutSlot(
      'round_of_16', 1, 'away', 'round_of_16', matchesByStage, {},
    );
    expect(result).toBe('team-d');
  });

  it('traces winner from home win prediction', () => {
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 2, awayScore: 1, progressingTeamId: null },
    };
    // QF-0 home slot comes from winner of R16-0 (team-a wins)
    const result = getUserPredictedTeamForKnockoutSlot(
      'quarter_final', 0, 'home', 'round_of_16', matchesByStage, preds,
    );
    expect(result).toBe('team-a');
  });

  it('traces winner from away win prediction', () => {
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 0, awayScore: 2, progressingTeamId: null },
    };
    const result = getUserPredictedTeamForKnockoutSlot(
      'quarter_final', 0, 'home', 'round_of_16', matchesByStage, preds,
    );
    expect(result).toBe('team-b');
  });

  it('uses explicit progressingTeamId on a draw', () => {
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 1, awayScore: 1, progressingTeamId: 'team-b' },
    };
    const result = getUserPredictedTeamForKnockoutSlot(
      'quarter_final', 0, 'home', 'round_of_16', matchesByStage, preds,
    );
    expect(result).toBe('team-b');
  });

  it('returns null for draw without progressingTeamId', () => {
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 1, awayScore: 1, progressingTeamId: null },
    };
    const result = getUserPredictedTeamForKnockoutSlot(
      'quarter_final', 0, 'home', 'round_of_16', matchesByStage, preds,
    );
    expect(result).toBeNull();
  });

  it('traces two levels deep (SF from R16 picks)', () => {
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 2, awayScore: 0, progressingTeamId: null }, // team-a wins
      'round_of_16_1': { homeScore: 0, awayScore: 1, progressingTeamId: null }, // team-d wins
      'quarter_final_0': { homeScore: 1, awayScore: 0, progressingTeamId: null }, // team-a wins QF
    };
    const result = getUserPredictedTeamForKnockoutSlot(
      'semi_final', 0, 'home', 'round_of_16', matchesByStage, preds,
    );
    expect(result).toBe('team-a');
  });
});

// ── calculateKnockoutPoints ───────────────────────────────────────────────────

describe('calculateKnockoutPoints', () => {
  const firstRound = 'round_of_16';

  const allMatches = [
    { id: 'r16-0', stage: 'round_of_16', homeTeamId: 'team-a', awayTeamId: 'team-b', homeScore: 2, awayScore: 1, progressingTeamId: 'team-a', status: 'completed' },
    { id: 'r16-1', stage: 'round_of_16', homeTeamId: 'team-c', awayTeamId: 'team-d', homeScore: 0, awayScore: 2, progressingTeamId: 'team-d', status: 'completed' },
    { id: 'qf-0', stage: 'quarter_final', homeTeamId: 'team-a', awayTeamId: 'team-d', homeScore: 3, awayScore: 0, progressingTeamId: 'team-a', status: 'completed' },
    { id: 'sf-0', stage: 'semi_final', homeTeamId: null, awayTeamId: null, homeScore: 0, awayScore: 0, progressingTeamId: null, status: 'scheduled' },
    { id: 'f-0', stage: 'final', homeTeamId: null, awayTeamId: null, homeScore: 0, awayScore: 0, progressingTeamId: null, status: 'scheduled' },
  ];

  it('awards basic points (exact_score + correct_result) for R16 bracket predictions', () => {
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 2, awayScore: 1, progressingTeamId: null }, // exact
    };
    const result = calculateKnockoutPoints(allMatches, firstRound, preds, CONFIG);
    // R16-0: exact(3) + result(1) = 4; R16-1: no prediction; QF-0: no bracket pred
    expect(result.total).toBeGreaterThanOrEqual(4);
    expect(result.breakdown.exactScore).toBe(3);
    expect(result.breakdown.correctResult).toBe(1);
  });

  it('awards correct_team_in_knockout_tie for correctly predicted QF team', () => {
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 2, awayScore: 0, progressingTeamId: null }, // team-a advances
      'round_of_16_1': { homeScore: 0, awayScore: 1, progressingTeamId: null }, // team-d advances
      'quarter_final_0': { homeScore: 1, awayScore: 0, progressingTeamId: null }, // team-a wins QF
    };
    const result = calculateKnockoutPoints(allMatches, firstRound, preds, CONFIG);
    // R16-0: result(1); R16-1: result(1); QF-0: result(1) + team-a predicted(1) + team-d predicted(1)
    expect(result.total).toBe(5);
    expect(result.breakdown.correctTeamInKnockoutTie).toBe(2);
  });

  it('does not award knockout_tie for first round (teams are from draw)', () => {
    // If we only have R16 completed, no knockout_tie points apply
    const onlyR16 = allMatches.filter(m => m.stage === 'round_of_16');
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 2, awayScore: 1, progressingTeamId: null },
    };
    const result = calculateKnockoutPoints(onlyR16, firstRound, preds, CONFIG);
    // R16-0: exact(3) + result(1) = 4; no knockout_tie for first round
    expect(result.total).toBe(4);
    expect(result.breakdown.correctTeamInKnockoutTie).toBe(0);
  });

  it('awards correct_winner for correct final winner prediction via trajectory', () => {
    // Use semi_final as firstRound so the bracket is symmetric (2 SF → 1 Final)
    const sfFirstRound = 'semi_final';
    const sfMatches = [
      { id: 'sf-0', stage: 'semi_final', homeTeamId: 'team-a', awayTeamId: 'team-b', homeScore: 2, awayScore: 0, progressingTeamId: 'team-a', status: 'completed' },
      { id: 'sf-1', stage: 'semi_final', homeTeamId: 'team-c', awayTeamId: 'team-d', homeScore: 0, awayScore: 1, progressingTeamId: 'team-d', status: 'completed' },
    ];
    const finalMatch = { id: 'f-0', stage: 'final', homeTeamId: 'team-a', awayTeamId: 'team-d', homeScore: 1, awayScore: 0, progressingTeamId: 'team-a', status: 'completed' };
    const matchesForTest = [...sfMatches, finalMatch];
    const preds: BracketPredictions = {
      'semi_final_0': { homeScore: 1, awayScore: 0, progressingTeamId: null }, // team-a wins SF-0
      'semi_final_1': { homeScore: 0, awayScore: 1, progressingTeamId: null }, // team-d wins SF-1
      'final_0': { homeScore: 1, awayScore: 0, progressingTeamId: null }, // team-a wins final
    };
    const result = calculateKnockoutPoints(matchesForTest, sfFirstRound, preds, CONFIG);
    // Final: team-a via trajectory → correct_winner(10), team-d via trajectory → correct_team_in_final(5)
    expect(result.breakdown.correctWinner).toBe(CONFIG.correct_winner); // 10
    expect(result.breakdown.correctTeamInFinal).toBe(CONFIG.correct_team_in_final); // 5
  });

  // ── flip logic tests ────────────────────────────────────────────────────────
  // User's bracket trajectory predicts Germany (home) vs Italy (away) at QF.
  // r16-0: germany beats france 2-0; r16-1: italy beats portugal 0-2.
  // User preds for r16 match actuals exactly, so baseline = exactScore:6, correctResult:2.
  describe('score flip logic (predicted Germany 2-1 Italy at QF)', () => {
    const flipFirstRound = 'round_of_16';
    const flipR16: typeof allMatches = [
      { id: 'fr16-0', stage: 'round_of_16', homeTeamId: 'germany', awayTeamId: 'france', homeScore: 2, awayScore: 0, progressingTeamId: 'germany', status: 'completed' },
      { id: 'fr16-1', stage: 'round_of_16', homeTeamId: 'portugal', awayTeamId: 'italy', homeScore: 0, awayScore: 2, progressingTeamId: 'italy', status: 'completed' },
    ];
    const flipPreds: BracketPredictions = {
      'round_of_16_0': { homeScore: 2, awayScore: 0, progressingTeamId: null }, // germany wins → predictedHome at QF
      'round_of_16_1': { homeScore: 0, awayScore: 2, progressingTeamId: null }, // italy wins  → predictedAway at QF
      'quarter_final_0': { homeScore: 2, awayScore: 1, progressingTeamId: null },
    };
    function makeFlipMatches(homeId: string, awayId: string, hs: number, as_: number, prog: string | null) {
      return [
        ...flipR16,
        { id: 'fqf-0', stage: 'quarter_final', homeTeamId: homeId, awayTeamId: awayId, homeScore: hs, awayScore: as_, progressingTeamId: prog, status: 'completed' as const },
      ];
    }

    it('case 1: Germany 2-1 Italy — exact + result + both teams bonus (no flip)', () => {
      const r = calculateKnockoutPoints(makeFlipMatches('germany', 'italy', 2, 1, 'germany'), flipFirstRound, flipPreds, CONFIG);
      expect(r.breakdown.exactScore).toBe(9);        // r16×2 + qf
      expect(r.breakdown.correctResult).toBe(3);     // r16×2 + qf
      expect(r.breakdown.correctTeamInKnockoutTie).toBe(2); // germany + italy
    });

    it('case 2: Italy 1-2 Germany — still perfect (both teams swapped → flip)', () => {
      const r = calculateKnockoutPoints(makeFlipMatches('italy', 'germany', 1, 2, 'germany'), flipFirstRound, flipPreds, CONFIG);
      expect(r.breakdown.exactScore).toBe(9);
      expect(r.breakdown.correctResult).toBe(3);
      expect(r.breakdown.correctTeamInKnockoutTie).toBe(2);
    });

    it('case 3: Germany 1-2 Italy — team bonuses only, no score/result points', () => {
      const r = calculateKnockoutPoints(makeFlipMatches('germany', 'italy', 1, 2, 'italy'), flipFirstRound, flipPreds, CONFIG);
      expect(r.breakdown.exactScore).toBe(6);        // only r16 baseline
      expect(r.breakdown.correctResult).toBe(2);
      expect(r.breakdown.correctTeamInKnockoutTie).toBe(2);
    });

    it('case 4: Spain 1-2 Germany — almost perfect (1 correct team on wrong side → flip)', () => {
      const r = calculateKnockoutPoints(makeFlipMatches('spain', 'germany', 1, 2, 'germany'), flipFirstRound, flipPreds, CONFIG);
      expect(r.breakdown.exactScore).toBe(9);        // flipped 2-1 matches prediction
      expect(r.breakdown.correctResult).toBe(3);
      expect(r.breakdown.correctTeamInKnockoutTie).toBe(1); // only germany
    });

    it('case 5: Spain 2-1 England — exact score + result, no team bonuses', () => {
      const r = calculateKnockoutPoints(makeFlipMatches('spain', 'england', 2, 1, 'spain'), flipFirstRound, flipPreds, CONFIG);
      expect(r.breakdown.exactScore).toBe(9);
      expect(r.breakdown.correctResult).toBe(3);
      expect(r.breakdown.correctTeamInKnockoutTie).toBe(0);
    });

    it('case 6: Spain 1-2 England — zero points from QF match', () => {
      const r = calculateKnockoutPoints(makeFlipMatches('spain', 'england', 1, 2, 'england'), flipFirstRound, flipPreds, CONFIG);
      expect(r.breakdown.exactScore).toBe(6);        // only r16 baseline
      expect(r.breakdown.correctResult).toBe(2);
      expect(r.breakdown.correctTeamInKnockoutTie).toBe(0);
    });
  });

  it('does not award correct_winner when user predicted correct finalist but wrong winner', () => {
    const sfFirstRound = 'semi_final';
    const sfMatches = [
      { id: 'sf-0', stage: 'semi_final', homeTeamId: 'team-a', awayTeamId: 'team-b', homeScore: 2, awayScore: 0, progressingTeamId: 'team-a', status: 'completed' },
      { id: 'sf-1', stage: 'semi_final', homeTeamId: 'team-c', awayTeamId: 'team-d', homeScore: 0, awayScore: 1, progressingTeamId: 'team-d', status: 'completed' },
    ];
    // Final: team-a wins, but user predicted team-d to win
    const finalMatch = { id: 'f-0', stage: 'final', homeTeamId: 'team-a', awayTeamId: 'team-d', homeScore: 1, awayScore: 0, progressingTeamId: 'team-a', status: 'completed' };
    const matchesForTest = [...sfMatches, finalMatch];
    const preds: BracketPredictions = {
      'semi_final_0': { homeScore: 1, awayScore: 0, progressingTeamId: null }, // team-a wins SF-0
      'semi_final_1': { homeScore: 0, awayScore: 1, progressingTeamId: null }, // team-d wins SF-1
      'final_0': { homeScore: 0, awayScore: 1, progressingTeamId: null },      // user predicts away (team-d) to win
    };
    const result = calculateKnockoutPoints(matchesForTest, sfFirstRound, preds, CONFIG);
    // Both teams predicted in final correctly, but user picked team-d to win (wrong) → no correct_winner
    expect(result.breakdown.correctWinner).toBe(0);
    expect(result.breakdown.correctTeamInFinal).toBe(CONFIG.correct_team_in_final * 2);
  });

  it('awards correct_team_in_final for correctly predicted finalist who loses', () => {
    // R16-0: team-a wins; R16-1: team-d wins; QF-0: team-a beats team-d
    // User predicts team-d to win the QF and reach the final
    // SF shell and final included so bracket trajectory resolves
    const sfShell = { id: 'sf-0', stage: 'semi_final', homeTeamId: null, awayTeamId: null, homeScore: 0, awayScore: 0, progressingTeamId: null, status: 'scheduled' };
    const finalMatch = { id: 'f-0', stage: 'final', homeTeamId: 'team-a', awayTeamId: 'team-d', homeScore: 1, awayScore: 0, progressingTeamId: 'team-a', status: 'completed' };
    const matchesWithFinal = [
      allMatches[0], allMatches[1], allMatches[2], sfShell, finalMatch,
    ];
    const preds: BracketPredictions = {
      'round_of_16_0': { homeScore: 1, awayScore: 0, progressingTeamId: null }, // team-a advances
      'round_of_16_1': { homeScore: 0, awayScore: 1, progressingTeamId: null }, // team-d advances
      'quarter_final_0': { homeScore: 0, awayScore: 1, progressingTeamId: null }, // team-d advances (away = team-d)
      'semi_final_0': { homeScore: 1, awayScore: 0, progressingTeamId: null }, // home = team-d (from QF away win) → team-d to Final
      'final_0': { homeScore: 0, awayScore: 1, progressingTeamId: null }, // team-d wins final
    };
    const result = calculateKnockoutPoints(matchesWithFinal, firstRound, preds, CONFIG);
    // Final: user predicted team-d to be in final (correct, but they lose) → correct_team_in_final(5)
    // team-a: user didn't predict team-a to reach the final (user had team-d winning QF)
    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.breakdown.correctTeamInFinal).toBeGreaterThanOrEqual(5);
  });
});
