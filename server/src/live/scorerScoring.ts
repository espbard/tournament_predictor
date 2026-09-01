import type { LiveScorerPredictionPlayerResult, LiveScoringConfig } from '@tournament-predictor/shared';

// ── Top-scorer ranking scoring ────────────────────────────────────────────────
//
// Users order the admin's shortlist of players by how many goals they think each will
// finish the tournament on. Every player placed in exactly the right position is worth
// `scorer_exact_position` — 2 by default. There are no bands: unlike a league table, a
// top-scorer list has no meaningful sections, so a player is in the right place or is not.
//
// The whole difficulty is ties, and a top-scorer table is full of them. The final ranking
// is made strict — 1..N with no shared positions — by breaking a tie on goals with
// assists, and a tie on both with the player's name. That keeps every position winnable,
// which a shared-rank scheme does not: if three players tie on 9 goals, nobody could ever
// score positions 2 and 3.
//
// Pure, no database access, mirroring the shape of calculateTablePoints in
// server/src/live/tableScoring.ts.

/** What ranking needs to know about a player. */
export interface RankableLivePlayer {
  id: string;
  name: string;
  goals: number;
  assists: number;
}

/**
 * The final ranking, best first.
 *
 * Sorted by goals, then assists, then name. The name comparison is deliberately not
 * `localeCompare`: that is locale-dependent, and a ranking that came out differently on a
 * developer's machine than on the server would be a genuinely awful bug to chase. Plain
 * `<`/`>` on the lower-cased name is stable everywhere.
 */
export function rankLiveScorers(players: RankableLivePlayer[]): RankableLivePlayer[] {
  return [...players].sort((a, b) => {
    if (b.goals !== a.goals) return b.goals - a.goals;
    if (b.assists !== a.assists) return b.assists - a.assists;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    // Same goals, same assists, same name: fall back to the id so the order is total.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The same ranking as a player id → 1-based position map, which is what scoring reads. */
export function liveScorerPositions(players: RankableLivePlayer[]): Map<string, number> {
  const positions = new Map<string, number>();
  rankLiveScorers(players).forEach((player, index) => positions.set(player.id, index + 1));
  return positions;
}

export interface ScorerScoreResult {
  points: number;
  exactPositionPoints: number;
  /** Per-player detail, in predicted order. For showing a user how they did. */
  players: LiveScorerPredictionPlayerResult[];
}

const EMPTY: ScorerScoreResult = { points: 0, exactPositionPoints: 0, players: [] };

/**
 * Score one predicted ranking.
 *
 * `actualPositions` maps a player id to their final 1-based position, as
 * `liveScorerPositions` builds it. A predicted player with no entry there — one the admin
 * removed from the shortlist after the prediction was saved — simply scores nothing rather
 * than derailing the ranking around them, which is how calculateTablePoints treats a
 * withdrawn team.
 */
export function calculateScorerPoints(
  orderedPlayerIds: string[],
  actualPositions: Map<string, number>,
  config: LiveScoringConfig,
): ScorerScoreResult {
  if (orderedPlayerIds.length === 0) return { ...EMPTY, players: [] };

  const players: LiveScorerPredictionPlayerResult[] = [];
  let exactPositionPoints = 0;

  orderedPlayerIds.forEach((playerId, index) => {
    const predictedPosition = index + 1;
    const actualPosition = actualPositions.get(playerId) ?? null;
    const exactPosition = actualPosition !== null && actualPosition === predictedPosition;
    const points = exactPosition ? config.scorer_exact_position : 0;

    exactPositionPoints += points;
    players.push({ playerId, predictedPosition, actualPosition, exactPosition, points });
  });

  return { points: exactPositionPoints, exactPositionPoints, players };
}
