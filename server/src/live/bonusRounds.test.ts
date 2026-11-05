import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_SCORING_CONFIG,
  SetLiveBonusRoundFixturesSchema,
  bonusRoundScore,
  canSeeLiveBonusRound,
  gameweekStrip,
  layoutLiveRounds,
  suggestLiveBonusRoundAnchor,
  type LiveRoundLayoutStage,
  type PlaceableBonusRound,
} from '@tournament-predictor/shared';
import { calculateBonusRoundPoints, isBonusRoundFixtureScorable } from './bonusRoundPoints';

// Bonus rounds: where they sit among a competition's own rounds, who sees them, and how
// they score. The database side is thin; the rules worth pinning are all here.

const STAGES: LiveRoundLayoutStage[] = [
  { key: 'league_phase', kind: 'table', matchdays: [1, 2, 3, 4, 5, 6, 7, 8] },
  { key: 'knockout_playoff', kind: 'knockout', matchdays: [1, 2] },
  { key: 'round_of_16', kind: 'knockout', matchdays: [1, 2] },
];

function round(
  id: string,
  afterStageKey: string | null,
  afterMatchday: number | null,
  firstKickoffAt: string | null = null,
): PlaceableBonusRound {
  return { id, afterStageKey, afterMatchday, firstKickoffAt };
}

describe('layoutLiveRounds', () => {
  it('puts a matchday anchor inside the table stage, after that gameweek', () => {
    const layout = layoutLiveRounds(STAGES, [round('nov', 'league_phase', 4)]);
    expect(layout.top.map(i => (i.type === 'stage' ? i.stageKey : i.round.id))).toEqual([
      'league_phase',
      'knockout_playoff',
      'round_of_16',
    ]);
    expect(layout.inStage.get('league_phase')?.get(4)?.map(r => r.id)).toEqual(['nov']);
  });

  it('puts a stage anchor between the stage pills', () => {
    const layout = layoutLiveRounds(STAGES, [round('march', 'knockout_playoff', null)]);
    expect(layout.top.map(i => (i.type === 'stage' ? i.stageKey : i.round.id))).toEqual([
      'league_phase',
      'knockout_playoff',
      'march',
      'round_of_16',
    ]);
  });

  it('treats a matchday on a knockout stage as after the whole stage', () => {
    const layout = layoutLiveRounds(STAGES, [round('r', 'knockout_playoff', 1)]);
    expect(layout.top[2]).toMatchObject({ type: 'bonus' });
    expect(layout.inStage.size).toBe(0);
  });

  it('puts a round with no anchor before everything', () => {
    const layout = layoutLiveRounds(STAGES, [round('first', null, null)]);
    expect(layout.top[0]).toMatchObject({ type: 'bonus', round: { id: 'first' } });
  });

  it('falls back to the nearest gameweek below a matchday the stage does not have', () => {
    const stages: LiveRoundLayoutStage[] = [{ key: 'league_phase', kind: 'table', matchdays: [1, 2, 5] }];
    const layout = layoutLiveRounds(stages, [round('a', 'league_phase', 4), round('b', 'league_phase', 0)]);
    expect(layout.inStage.get('league_phase')?.get(2)?.map(r => r.id)).toEqual(['a']);
    // Nothing below: before the first gameweek, stored under 0.
    expect(layout.inStage.get('league_phase')?.get(0)?.map(r => r.id)).toEqual(['b']);
  });

  it('never loses a round whose stage is not listed', () => {
    const layout = layoutLiveRounds(STAGES, [round('lost', 'final', null)]);
    expect(layout.top[layout.top.length - 1]).toMatchObject({ type: 'bonus', round: { id: 'lost' } });
  });

  it('orders rounds sharing an anchor by their first kickoff', () => {
    const layout = layoutLiveRounds(STAGES, [
      round('later', 'league_phase', 4, '2026-11-17T19:45:00Z'),
      round('earlier', 'league_phase', 4, '2026-11-13T19:45:00Z'),
      round('empty', 'league_phase', 4, null),
    ]);
    expect(layout.inStage.get('league_phase')?.get(4)?.map(r => r.id)).toEqual(['earlier', 'later', 'empty']);
  });
});

describe('gameweekStrip', () => {
  it('interleaves rounds after their gameweek', () => {
    const after = new Map([
      [0, ['pre']],
      [2, ['mid']],
    ]);
    expect(gameweekStrip([1, 2, 3], after)).toEqual([
      { type: 'bonus', round: 'pre' },
      { type: 'gameweek', matchday: 1 },
      { type: 'gameweek', matchday: 2 },
      { type: 'bonus', round: 'mid' },
      { type: 'gameweek', matchday: 3 },
    ]);
  });
});

describe('suggestLiveBonusRoundAnchor', () => {
  const options = [
    { afterStageKey: 'league_phase', afterMatchday: 4, firstKickoffAt: '2026-11-04T17:45:00Z' },
    { afterStageKey: 'league_phase', afterMatchday: 5, firstKickoffAt: '2026-11-24T17:45:00Z' },
    { afterStageKey: 'league_phase', afterMatchday: null, firstKickoffAt: '2026-09-16T16:45:00Z' },
  ];

  it('places the November Nations League after matchday 4', () => {
    expect(suggestLiveBonusRoundAnchor(options.slice(0, 2), '2026-11-13T19:45:00Z')).toEqual({
      afterStageKey: 'league_phase',
      afterMatchday: 4,
    });
  });

  it('suggests before everything when nothing starts earlier, or the round is empty', () => {
    const none = { afterStageKey: null, afterMatchday: null };
    expect(suggestLiveBonusRoundAnchor(options, '2026-08-01T00:00:00Z')).toEqual(none);
    expect(suggestLiveBonusRoundAnchor(options, null)).toEqual(none);
  });
});

describe('canSeeLiveBonusRound', () => {
  const player = { isAdmin: false, isTestAccount: false };
  it('hides a test round from regular players only', () => {
    expect(canSeeLiveBonusRound(player, { visibility: 'test' })).toBe(false);
    expect(canSeeLiveBonusRound({ ...player, isTestAccount: true }, { visibility: 'test' })).toBe(true);
    expect(canSeeLiveBonusRound({ ...player, isAdmin: true }, { visibility: 'test' })).toBe(true);
    expect(canSeeLiveBonusRound(player, { visibility: 'everyone' })).toBe(true);
  });
});

describe('bonus-round scoring', () => {
  const finished = {
    status: 'finished' as const,
    normalTimeHome: 2,
    normalTimeAway: 1,
    scoreOverrideHome: null,
    scoreOverrideAway: null,
  };

  it('scores on the three tiers like a normal match', () => {
    const exact = calculateBonusRoundPoints({ homeScore: 2, awayScore: 1 }, finished, 1, DEFAULT_LIVE_SCORING_CONFIG);
    expect(exact.points).toBe(4);
    const outcome = calculateBonusRoundPoints({ homeScore: 3, awayScore: 0 }, finished, 1, DEFAULT_LIVE_SCORING_CONFIG);
    expect(outcome.points).toBe(1);
  });

  it("applies the round's multiplier as bonus points", () => {
    const result = calculateBonusRoundPoints({ homeScore: 2, awayScore: 1 }, finished, 2, DEFAULT_LIVE_SCORING_CONFIG);
    expect(result.points).toBe(8);
    expect(result.exactScorePoints).toBe(2);
    expect(result.multiplierBonusPoints).toBe(4);
  });

  it("scores on the admin's override when one is set", () => {
    // 2-1 from the provider included extra time; it was 1-1 after 90 minutes.
    const overridden = { ...finished, scoreOverrideHome: 1, scoreOverrideAway: 1 };
    expect(bonusRoundScore(overridden)).toEqual({ home: 1, away: 1, overridden: true });
    const draw = calculateBonusRoundPoints({ homeScore: 0, awayScore: 0 }, overridden, 1, DEFAULT_LIVE_SCORING_CONFIG);
    expect(draw.points).toBe(2);
    const old = calculateBonusRoundPoints({ homeScore: 2, awayScore: 1 }, overridden, 1, DEFAULT_LIVE_SCORING_CONFIG);
    expect(old.points).toBe(0);
  });

  it('ignores a half-set override', () => {
    expect(bonusRoundScore({ ...finished, scoreOverrideHome: 0 })).toEqual({ home: 2, away: 1, overridden: false });
  });

  it('awards nothing until the match has finished', () => {
    const live = { ...finished, status: 'in_play' as const };
    expect(isBonusRoundFixtureScorable(live)).toBe(false);
    expect(calculateBonusRoundPoints({ homeScore: 2, awayScore: 1 }, live, 1, DEFAULT_LIVE_SCORING_CONFIG).points).toBe(0);
  });
});

describe('SetLiveBonusRoundFixturesSchema', () => {
  it('defaults the multiplier to 1 and rejects one out of bounds', () => {
    const ok = SetLiveBonusRoundFixturesSchema.parse({ fixtures: [{ fixtureId: 'f1' }] });
    expect(ok.fixtures[0].multiplier).toBe(1);
    expect(SetLiveBonusRoundFixturesSchema.safeParse({ fixtures: [{ fixtureId: 'f1', multiplier: 0 }] }).success).toBe(
      false,
    );
  });
});
