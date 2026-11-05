import { bonusFixtureStatus, type LiveScoringConfig } from '@tournament-predictor/shared';
import { calculateLivePoints, isFixtureScorable, type LiveScoreResult } from './scoring';

// ── Bonus-round points (pure) ─────────────────────────────────────────────────
//
// A bonus-round prediction scores exactly like a normal one — the competition's three
// tiers and the match's multiplier — against the 90-minute result an admin typed in.
// Kept free of the database so it can be tested; bonusRoundScoring.ts applies it.

export interface BonusFixtureScoreInput {
  homeScore: number | null;
  awayScore: number | null;
  multiplier: number;
}

/** The match as calculateLivePoints wants it. */
function scoringInput(fixture: BonusFixtureScoreInput) {
  return {
    status: bonusFixtureStatus(fixture),
    normalTimeHome: fixture.homeScore,
    normalTimeAway: fixture.awayScore,
    multiplier: fixture.multiplier,
  };
}

/** Whether the match has a result to score against. */
export function isBonusFixtureScorable(fixture: BonusFixtureScoreInput): boolean {
  return isFixtureScorable(scoringInput(fixture));
}

export function calculateBonusRoundPoints(
  prediction: { homeScore: number; awayScore: number },
  fixture: BonusFixtureScoreInput,
  config: LiveScoringConfig,
): LiveScoreResult {
  return calculateLivePoints(prediction, scoringInput(fixture), config);
}
