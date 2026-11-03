import {
  bandForPosition,
  type LiveScoringConfig,
  type LiveStageDef,
  type LiveTablePredictionTeamResult,
} from '@tournament-predictor/shared';

// ── League table prediction scoring ───────────────────────────────────────────
//
// Users order every team in a table stage from top to bottom. Once the stage has been
// played out, each team is compared against where it actually finished:
//
//   exact position                        table_exact_position  (2)
//   within one place of the prediction    table_near_position   (1)
//
// The two stack, so by default a team placed exactly right is worth 3, a team one place
// above or below where it was predicted 1, and anything further off 0. This applies the
// same to every format. Bands (where the format has them) are still reported per team for
// display, but no longer score: a band bonus handed out too many points on a big table.
//
// Pure, no database access — the caller supplies the actual finishing order.

export interface TableScoreResult {
  points: number;
  exactPositionPoints: number;
  nearPositionPoints: number;
  /** Per-team detail, in predicted order. For showing a user how they did. */
  teams: LiveTablePredictionTeamResult[];
}

const EMPTY: TableScoreResult = {
  points: 0,
  exactPositionPoints: 0,
  nearPositionPoints: 0,
  teams: [],
};

/**
 * Score one predicted table.
 *
 * `actualPositions` maps a team id to its final 1-based position. A predicted team with
 * no entry there — a team withdrawn from the competition, say — simply scores nothing
 * rather than derailing the rest of the table.
 */
export function calculateTablePoints(
  orderedTeamIds: string[],
  actualPositions: Map<string, number>,
  stage: LiveStageDef | null,
  config: LiveScoringConfig,
): TableScoreResult {
  if (orderedTeamIds.length === 0) return { ...EMPTY, teams: [] };

  const teams: LiveTablePredictionTeamResult[] = [];
  let exactPositionPoints = 0;
  let nearPositionPoints = 0;

  orderedTeamIds.forEach((teamId, index) => {
    const predictedPosition = index + 1;
    const actualPosition = actualPositions.get(teamId) ?? null;

    const predictedBand = bandForPosition(stage, predictedPosition);
    const actualBand = actualPosition === null ? null : bandForPosition(stage, actualPosition);

    const exactPosition = actualPosition !== null && actualPosition === predictedPosition;
    const nearPosition =
      actualPosition !== null && Math.abs(actualPosition - predictedPosition) <= 1;

    const exact = exactPosition ? config.table_exact_position : 0;
    const near = nearPosition ? config.table_near_position : 0;

    exactPositionPoints += exact;
    nearPositionPoints += near;

    teams.push({
      teamId,
      predictedPosition,
      actualPosition,
      exactPosition,
      nearPosition,
      predictedBand,
      actualBand,
      points: exact + near,
    });
  });

  return {
    points: exactPositionPoints + nearPositionPoints,
    exactPositionPoints,
    nearPositionPoints,
    teams,
  };
}

/**
 * Whether a table stage is finished enough to score.
 *
 * Every fixture must have reached a terminal state. A cancelled fixture counts as done —
 * it will never be played, so waiting for it would leave the table unscored forever. A
 * postponed one does not, because it is still expected to be played and could still move
 * the table.
 */
export function isTableStageComplete(
  fixtures: Array<{ status: string }>,
): boolean {
  if (fixtures.length === 0) return false;
  return fixtures.every(f => f.status === 'finished' || f.status === 'cancelled');
}

/**
 * Validate a submitted order against the tournament's actual teams.
 *
 * Every team must appear exactly once. Anything less would let a user quietly stack the
 * table — duplicating a team they are confident about, or omitting one they are not.
 */
export function validateTableOrder(
  orderedTeamIds: string[],
  validTeamIds: string[],
): { ok: true } | { ok: false; reason: 'unknown-team' | 'duplicate' | 'incomplete' } {
  const valid = new Set(validTeamIds);
  const seen = new Set<string>();

  for (const id of orderedTeamIds) {
    if (!valid.has(id)) return { ok: false, reason: 'unknown-team' };
    if (seen.has(id)) return { ok: false, reason: 'duplicate' };
    seen.add(id);
  }

  if (seen.size !== valid.size) return { ok: false, reason: 'incomplete' };
  return { ok: true };
}
