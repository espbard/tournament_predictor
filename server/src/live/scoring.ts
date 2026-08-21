import type {
  LiveFixtureStatus,
  LiveScoreBreakdown,
  LiveScoringConfig,
} from '@tournament-predictor/shared';

// ── Live tournament scoring ───────────────────────────────────────────────────
//
// Three stacking tiers, evaluated per fixture against the score at the end of normal
// time. The tiers are nested — an exact scoreline necessarily also has the right goal
// difference and outcome — so the configured values simply add. Four points by default.
//
//   outcome (home win / draw / away win)   +1
//   goal difference                        +1
//   exact scoreline                        +2
//
// Pure, no database access, mirroring the shape of calculateMatchPoints in
// server/src/lib/scoring.ts but with no stage or progressing-team dimension: this
// tournament type has no bracket and no group positions.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §2 and §9.

export interface LivePredictionInput {
  homeScore: number;
  awayScore: number;
}

export interface LiveFixtureScoreInput {
  /** End of 90 minutes. Null when the provider could not tell us — see the adapter. */
  normalTimeHome: number | null;
  normalTimeAway: number | null;
  status: LiveFixtureStatus;
}

export interface LiveScoreResult extends LiveScoreBreakdown {
  points: number;
}

const ZERO: LiveScoreResult = {
  points: 0,
  correctOutcomePoints: 0,
  correctGoalDifferencePoints: 0,
  exactScorePoints: 0,
};

/**
 * Whether a fixture can award points at all.
 *
 * Both conditions matter. An unfinished fixture obviously scores nothing, but so does a
 * *finished* one with no normal-time score: that is the adapter refusing to guess after
 * extra time, and inventing points from the full-time score would award them on a
 * scoreline the rules exclude. Such a fixture stays unscored and is surfaced in the admin
 * UI as needing attention.
 */
export function isFixtureScorable(fixture: LiveFixtureScoreInput): boolean {
  return (
    fixture.status === 'finished' &&
    fixture.normalTimeHome !== null &&
    fixture.normalTimeAway !== null
  );
}

export function calculateLivePoints(
  prediction: LivePredictionInput,
  fixture: LiveFixtureScoreInput,
  config: LiveScoringConfig,
): LiveScoreResult {
  if (!isFixtureScorable(fixture)) return { ...ZERO };

  const actualHome = fixture.normalTimeHome!;
  const actualAway = fixture.normalTimeAway!;

  const correctOutcome =
    Math.sign(actualHome - actualAway) === Math.sign(prediction.homeScore - prediction.awayScore);
  const correctGoalDifference =
    actualHome - actualAway === prediction.homeScore - prediction.awayScore;
  const exactScore = actualHome === prediction.homeScore && actualAway === prediction.awayScore;

  const correctOutcomePoints = correctOutcome ? config.correct_outcome : 0;
  const correctGoalDifferencePoints = correctGoalDifference ? config.correct_goal_difference : 0;
  const exactScorePoints = exactScore ? config.exact_score : 0;

  return {
    points: correctOutcomePoints + correctGoalDifferencePoints + exactScorePoints,
    correctOutcomePoints,
    correctGoalDifferencePoints,
    exactScorePoints,
  };
}
