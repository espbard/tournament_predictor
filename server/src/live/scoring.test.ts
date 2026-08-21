import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SCORING_CONFIG, type LiveScoringConfig } from '@tournament-predictor/shared';
import { calculateLivePoints, isFixtureScorable } from './scoring';

const CONFIG = DEFAULT_LIVE_SCORING_CONFIG;

function finished(home: number | null, away: number | null) {
  return { normalTimeHome: home, normalTimeAway: away, status: 'finished' as const };
}

const score = (
  actual: [number, number],
  predicted: [number, number],
  config: LiveScoringConfig = CONFIG,
) =>
  calculateLivePoints(
    { homeScore: predicted[0], awayScore: predicted[1] },
    finished(actual[0], actual[1]),
    config,
  );

describe('calculateLivePoints', () => {
  // The worked table from the plan, §2.
  it.each([
    { actual: [2, 1], predicted: [2, 1], total: 4, note: 'exact' },
    { actual: [2, 1], predicted: [3, 2], total: 2, note: 'outcome + goal difference' },
    { actual: [2, 1], predicted: [3, 1], total: 1, note: 'outcome only' },
    { actual: [2, 1], predicted: [1, 1], total: 0, note: 'nothing' },
    { actual: [1, 1], predicted: [0, 0], total: 2, note: 'draw, outcome + goal difference' },
  ])('$actual vs $predicted scores $total ($note)', ({ actual, predicted, total }) => {
    expect(score(actual as [number, number], predicted as [number, number]).points).toBe(total);
  });

  it('breaks an exact score into all three tiers', () => {
    expect(score([2, 1], [2, 1])).toEqual({
      points: 4,
      correctOutcomePoints: 1,
      correctGoalDifferencePoints: 1,
      exactScorePoints: 2,
    });
  });

  it('awards goal difference without the exact score', () => {
    expect(score([2, 1], [3, 2])).toEqual({
      points: 2,
      correctOutcomePoints: 1,
      correctGoalDifferencePoints: 1,
      exactScorePoints: 0,
    });
  });

  it('awards the outcome alone when the margin is wrong', () => {
    expect(score([2, 1], [3, 1])).toEqual({
      points: 1,
      correctOutcomePoints: 1,
      correctGoalDifferencePoints: 0,
      exactScorePoints: 0,
    });
  });

  it('scores an exact goalless draw', () => {
    expect(score([0, 0], [0, 0]).points).toBe(4);
  });

  it('gives nothing for predicting the wrong winner', () => {
    expect(score([2, 1], [1, 2])).toEqual({
      points: 0,
      correctOutcomePoints: 0,
      correctGoalDifferencePoints: 0,
      exactScorePoints: 0,
    });
  });

  // A draw predicted as a different draw has the right outcome and, necessarily, the
  // right goal difference of zero.
  it('treats any predicted draw as the right goal difference for a draw', () => {
    expect(score([2, 2], [1, 1])).toMatchObject({
      correctOutcomePoints: 1,
      correctGoalDifferencePoints: 1,
      exactScorePoints: 0,
    });
  });

  it('never awards goal difference to a wrong outcome', () => {
    // A 1-goal home win predicted as a 1-goal away win: same margin, opposite sign.
    expect(score([2, 1], [1, 2])).toMatchObject({
      correctOutcomePoints: 0,
      correctGoalDifferencePoints: 0,
    });
  });

  it('honours a custom config', () => {
    const custom: LiveScoringConfig = {
      correct_outcome: 3,
      correct_goal_difference: 5,
      exact_score: 10,
    };
    expect(score([2, 1], [2, 1], custom).points).toBe(18);
    expect(score([2, 1], [3, 2], custom).points).toBe(8);
  });

  it('awards nothing when every tier is configured to zero', () => {
    const zeroed: LiveScoringConfig = {
      correct_outcome: 0,
      correct_goal_difference: 0,
      exact_score: 0,
    };
    expect(score([2, 1], [2, 1], zeroed).points).toBe(0);
  });
});

describe('calculateLivePoints — unscorable fixtures', () => {
  const perfect = { homeScore: 2, awayScore: 1 };

  it.each(['scheduled', 'in_play', 'paused', 'postponed', 'suspended', 'cancelled'] as const)(
    'awards nothing while a fixture is %s, even with a perfect prediction',
    status => {
      const result = calculateLivePoints(
        perfect,
        { normalTimeHome: 2, normalTimeAway: 1, status },
        CONFIG,
      );
      expect(result.points).toBe(0);
    },
  );

  // The scoring-integrity case: the adapter returns nulls rather than guessing the
  // normal-time score after extra time, and that must never become points.
  it('awards nothing when the normal-time score is unknown', () => {
    expect(calculateLivePoints(perfect, finished(null, null), CONFIG).points).toBe(0);
    expect(calculateLivePoints(perfect, finished(2, null), CONFIG).points).toBe(0);
    expect(calculateLivePoints(perfect, finished(null, 1), CONFIG).points).toBe(0);
  });

  // A tie decided in extra time or on penalties still scores on the 90-minute result:
  // 0-0 after normal time is a draw for scoring purposes, however the tie ended.
  it('scores an extra-time tie on its normal-time score only', () => {
    const drawnAfter90 = finished(0, 0);
    expect(calculateLivePoints({ homeScore: 0, awayScore: 0 }, drawnAfter90, CONFIG).points).toBe(4);
    expect(calculateLivePoints({ homeScore: 1, awayScore: 0 }, drawnAfter90, CONFIG).points).toBe(0);
  });
});

describe('isFixtureScorable', () => {
  it('accepts a finished fixture with a normal-time score', () => {
    expect(isFixtureScorable(finished(1, 0))).toBe(true);
  });

  it('rejects an unfinished fixture', () => {
    expect(isFixtureScorable({ normalTimeHome: 1, normalTimeAway: 0, status: 'in_play' })).toBe(false);
  });

  it('rejects a finished fixture with no normal-time score', () => {
    expect(isFixtureScorable(finished(null, null))).toBe(false);
  });
});
