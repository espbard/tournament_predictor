import type { ScoringConfig } from '@tournament-predictor/shared';

interface PredictionInput {
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
}

interface MatchResult {
  homeScore: number;
  awayScore: number;
  stage: 'group' | 'round_of_16' | 'quarter_final' | 'semi_final' | 'final';
  actualProgressingTeamId?: string | null;
}

interface ScoreBreakdown {
  exactScore: number;
  correctResult: number;
  correctTeamProgresses: number;
}

export interface ScoreResult {
  points: number;
  breakdown: ScoreBreakdown;
}

export function calculateMatchPoints(
  prediction: PredictionInput,
  match: MatchResult,
  config: ScoringConfig
): ScoreResult {
  const breakdown: ScoreBreakdown = {
    exactScore: 0,
    correctResult: 0,
    correctTeamProgresses: 0,
  };

  // Exact score (90 min result only — extra time / penalties don't count)
  if (
    prediction.homeScore === match.homeScore &&
    prediction.awayScore === match.awayScore
  ) {
    breakdown.exactScore = config.exact_score;
  }

  // Correct result (win / draw / loss direction)
  const actualResult = Math.sign(match.homeScore - match.awayScore);
  const predictedResult = Math.sign(prediction.homeScore - prediction.awayScore);
  if (actualResult === predictedResult) {
    breakdown.correctResult = config.correct_result;
  }

  // For knockout stages: correct progressing team (from ET or pens)
  if (match.stage !== 'group' && match.actualProgressingTeamId) {
    if (prediction.progressingTeamId === match.actualProgressingTeamId) {
      breakdown.correctTeamProgresses = config.correct_team_progresses;
    }
  }

  const points = breakdown.exactScore + breakdown.correctResult + breakdown.correctTeamProgresses;
  return { points, breakdown };
}
