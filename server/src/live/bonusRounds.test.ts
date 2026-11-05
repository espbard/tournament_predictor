import { describe, expect, it } from 'vitest';
import {
  CreateLiveBonusFixtureSchema,
  CreateLiveBonusTeamSchema,
  DEFAULT_LIVE_SCORING_CONFIG,
  UpdateLiveBonusFixtureSchema,
  bonusFixtureStatus,
  canSeeLiveBonusRound,
  layoutLiveRounds,
  suggestLiveBonusRoundAnchor,
  type LiveRoundLayoutStage,
  type PlaceableBonusRound,
} from '@tournament-predictor/shared';
import { calculateBonusRoundPoints, isBonusFixtureScorable } from './bonusRoundPoints';

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
  const played = { homeScore: 2, awayScore: 1, multiplier: 1 };
  const config = DEFAULT_LIVE_SCORING_CONFIG;

  it('scores on the three tiers like a normal match', () => {
    expect(calculateBonusRoundPoints({ homeScore: 2, awayScore: 1 }, played, config).points).toBe(4);
    expect(calculateBonusRoundPoints({ homeScore: 3, awayScore: 2 }, played, config).points).toBe(2);
    expect(calculateBonusRoundPoints({ homeScore: 3, awayScore: 0 }, played, config).points).toBe(1);
    expect(calculateBonusRoundPoints({ homeScore: 0, awayScore: 0 }, played, config).points).toBe(0);
  });

  it("applies the match's multiplier as bonus points", () => {
    const result = calculateBonusRoundPoints({ homeScore: 2, awayScore: 1 }, { ...played, multiplier: 2 }, config);
    expect(result.points).toBe(8);
    expect(result.exactScorePoints).toBe(2);
    expect(result.multiplierBonusPoints).toBe(4);
  });

  it('awards nothing until the admin has entered the result', () => {
    const unplayed = { homeScore: null, awayScore: null, multiplier: 1 };
    expect(bonusFixtureStatus(unplayed)).toBe('scheduled');
    expect(isBonusFixtureScorable(unplayed)).toBe(false);
    expect(calculateBonusRoundPoints({ homeScore: 2, awayScore: 1 }, unplayed, config).points).toBe(0);
    // Half a result is not a result.
    expect(bonusFixtureStatus({ homeScore: 1, awayScore: null })).toBe('scheduled');
    expect(bonusFixtureStatus(played)).toBe('finished');
  });
});

describe('bonus-round match schemas', () => {
  const match = { homeTeamId: 'norway', awayTeamId: 'manual:italy', kickoffAt: '2026-11-13T19:45:00.000Z' };

  it('defaults the multiplier to 1 and rejects one out of bounds', () => {
    expect(CreateLiveBonusFixtureSchema.parse(match).multiplier).toBe(1);
    expect(CreateLiveBonusFixtureSchema.safeParse({ ...match, multiplier: 0 }).success).toBe(false);
  });

  it('needs two different teams and a real kickoff', () => {
    expect(CreateLiveBonusFixtureSchema.safeParse({ ...match, awayTeamId: '' }).success).toBe(false);
    expect(CreateLiveBonusFixtureSchema.safeParse({ ...match, awayTeamId: 'norway' }).success).toBe(false);
    expect(CreateLiveBonusFixtureSchema.safeParse({ ...match, kickoffAt: 'tomorrow' }).success).toBe(false);
  });

  it('takes a result as both scores or neither', () => {
    expect(UpdateLiveBonusFixtureSchema.safeParse({ homeScore: 2, awayScore: 1 }).success).toBe(true);
    expect(UpdateLiveBonusFixtureSchema.safeParse({ homeScore: null, awayScore: null }).success).toBe(true);
    expect(UpdateLiveBonusFixtureSchema.safeParse({ homeScore: 2 }).success).toBe(false);
    expect(UpdateLiveBonusFixtureSchema.safeParse({ homeScore: 2, awayScore: null }).success).toBe(false);
  });
});

describe('CreateLiveBonusTeamSchema', () => {
  it('needs a name; the logo is optional', () => {
    expect(CreateLiveBonusTeamSchema.safeParse({ name: 'Norway' }).success).toBe(true);
    expect(CreateLiveBonusTeamSchema.safeParse({ name: 'Norway', imageUrl: '/api/images/teams/x.png' }).success).toBe(true);
    expect(CreateLiveBonusTeamSchema.safeParse({ name: '  ' }).success).toBe(false);
  });
});
