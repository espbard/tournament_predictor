import {
  liveFixtureMultiplier,
  type LiveFixtureStatus,
  type LiveScoringConfig,
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
// A fixture with a multiplier — an admin marking one match as worth more — awards the
// extra separately rather than by inflating the tiers. A perfect prediction on a x3 match
// is 1 + 1 + 2 with a multiplier bonus of 8, not 3 + 3 + 6.
//
// That split is the whole reason the bonus is its own number: the leaderboard shows a
// column per source, and a highlighted match must not quietly make somebody look like a
// better predictor of goal difference than they are. The tiers stay comparable between
// members whatever the admin has highlighted, and the bonus says what the highlight was
// worth on its own.
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
  /**
   * The fixture's point multiplier. Optional so a caller that predates the column — or a
   * fixture row stored before it — still scores at face value; see liveFixtureMultiplier.
   */
  multiplier?: number | null;
}

/**
 * Per-fixture result. Deliberately not `LiveScoreBreakdown` — that type describes a
 * member's whole-competition breakdown, which also carries table-prediction points, and
 * a single fixture can never produce those.
 */
export interface LiveScoreResult {
  /** Everything awarded, tiers and multiplier bonus together. */
  points: number;
  correctOutcomePoints: number;
  correctGoalDifferencePoints: number;
  exactScorePoints: number;
  /**
   * What the fixture's multiplier added on top of the tiers, and nothing else: the tiers
   * once more for a x2 match, twice more for a x3. Zero on an ordinary fixture.
   */
  multiplierBonusPoints: number;
}

const ZERO: LiveScoreResult = {
  points: 0,
  correctOutcomePoints: 0,
  correctGoalDifferencePoints: 0,
  exactScorePoints: 0,
  multiplierBonusPoints: 0,
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

  // The tiers are what the prediction itself earned, at face value.
  const correctOutcomePoints = correctOutcome ? config.correct_outcome : 0;
  const correctGoalDifferencePoints = correctGoalDifference ? config.correct_goal_difference : 0;
  const exactScorePoints = exactScore ? config.exact_score : 0;
  const base = correctOutcomePoints + correctGoalDifferencePoints + exactScorePoints;

  // ...and the highlight is what the multiplier added to them. A x1 fixture adds nothing,
  // and a prediction that earned nothing is multiplied to nothing however big the number.
  const multiplier = liveFixtureMultiplier(fixture.multiplier);
  const multiplierBonusPoints = base * (multiplier - 1);

  return {
    points: base + multiplierBonusPoints,
    correctOutcomePoints,
    correctGoalDifferencePoints,
    exactScorePoints,
    multiplierBonusPoints,
  };
}
