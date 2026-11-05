import { bonusRoundScore, type LiveFixtureStatus, type LiveScoringConfig } from '@tournament-predictor/shared';
import { calculateLivePoints, isFixtureScorable, type LiveScoreResult } from './scoring';

// ── Bonus-round points (pure) ─────────────────────────────────────────────────
//
// A bonus-round prediction scores exactly like a normal one — the competition's three
// tiers — with two differences, both about where the inputs come from:
//
//   * the multiplier is the round's, set per match by the admin, never the source
//     fixture's own `multiplier` (that belongs to the source tournament);
//   * the result is the admin's normal-time override where one is set, since the
//     Nations League's provider cannot tell 90 minutes from extra time.
//
// Kept free of the database so it can be tested; bonusRoundScoring.ts applies it.

export interface BonusRoundFixtureScoreInput {
  status: LiveFixtureStatus;
  normalTimeHome: number | null;
  normalTimeAway: number | null;
  scoreOverrideHome: number | null;
  scoreOverrideAway: number | null;
}

/** The fixture as calculateLivePoints wants it, with the round's score and multiplier. */
export function bonusRoundScoringInput(fixture: BonusRoundFixtureScoreInput, roundMultiplier: number) {
  const score = bonusRoundScore(fixture);
  return {
    status: fixture.status,
    normalTimeHome: score.home,
    normalTimeAway: score.away,
    multiplier: roundMultiplier,
  };
}

/** Whether the fixture has a result a bonus round can be scored on. */
export function isBonusRoundFixtureScorable(fixture: BonusRoundFixtureScoreInput): boolean {
  return isFixtureScorable(bonusRoundScoringInput(fixture, 1));
}

export function calculateBonusRoundPoints(
  prediction: { homeScore: number; awayScore: number },
  fixture: BonusRoundFixtureScoreInput,
  roundMultiplier: number,
  config: LiveScoringConfig,
): LiveScoreResult {
  return calculateLivePoints(prediction, bonusRoundScoringInput(fixture, roundMultiplier), config);
}
