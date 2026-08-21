import { and, eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_LIVE_SCORING_CONFIG, type LiveScoringConfig } from '@tournament-predictor/shared';
import { db } from '../db/client';
import {
  liveCompetitionMembers,
  liveCompetitions,
  liveFixtures,
  livePredictions,
} from '../db/liveSchema';
import { calculateLivePoints } from './scoring';
import { notifyLiveCompetitions } from './liveEvents';

// ── Scoring trigger ───────────────────────────────────────────────────────────
//
// Applies server/src/live/scoring.ts to stored predictions and keeps the denormalised
// totals on live_competition_members in step.
//
// Unlike the manual tournament type — where scoring runs inline inside
// PATCH /api/matches/:id when an admin types a result — this is driven by the sync tick,
// because results arrive from the provider rather than from a request.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §9.

const CHUNK_SIZE = 200;

async function chunked<T>(rows: T[], fn: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await fn(rows.slice(i, i + CHUNK_SIZE));
  }
}

export interface ScoreFixturesResult {
  /** Predictions whose points were written. */
  scoredPredictions: number;
  /** Competitions whose leaderboards moved, for the SSE push. */
  affectedCompetitionIds: string[];
}

/**
 * Recompute totals for the given competitions from their predictions.
 *
 * Done as one UPDATE ... FROM (SELECT ... SUM ...) per competition rather than a read,
 * sum and write-back loop, so a member's totals cannot drift if two ticks overlap.
 * Members with no scored predictions are reset to zero rather than left stale, which is
 * what makes a recalculation after a scoring-config change correct.
 */
async function recomputeMemberTotals(competitionIds: string[]): Promise<void> {
  if (competitionIds.length === 0) return;

  await chunked(competitionIds, async chunk => {
    await db.execute(sql`
      UPDATE live_competition_members AS m
      SET correct_outcome_points = COALESCE(t.outcome, 0),
          correct_goal_difference_points = COALESCE(t.gd, 0),
          exact_score_points = COALESCE(t.exact, 0),
          total_points = COALESCE(t.total, 0)
      FROM (
        SELECT m2.id AS member_id,
               SUM(p.correct_outcome_points)          AS outcome,
               SUM(p.correct_goal_difference_points)  AS gd,
               SUM(p.exact_score_points)              AS exact,
               SUM(p.points)                          AS total
        FROM live_competition_members m2
        LEFT JOIN live_predictions p
          ON p.live_competition_id = m2.live_competition_id
         AND p.user_id = m2.user_id
         AND p.points IS NOT NULL
        WHERE m2.live_competition_id IN ${chunk}
        GROUP BY m2.id
      ) AS t
      WHERE m.id = t.member_id
    `);
  });
}

/**
 * Score every prediction against the given fixtures.
 *
 * Called from the sync tick with the fixtures that just transitioned into `finished`.
 * Safe to re-run: points are recomputed from scratch rather than accumulated.
 */
export async function scoreFixtures(fixtureIds: string[]): Promise<ScoreFixturesResult> {
  const result: ScoreFixturesResult = { scoredPredictions: 0, affectedCompetitionIds: [] };
  if (fixtureIds.length === 0) return result;

  const fixtures = await db
    .select({
      id: liveFixtures.id,
      liveTournamentId: liveFixtures.liveTournamentId,
      status: liveFixtures.status,
      normalTimeHome: liveFixtures.normalTimeHome,
      normalTimeAway: liveFixtures.normalTimeAway,
    })
    .from(liveFixtures)
    .where(inArray(liveFixtures.id, fixtureIds));
  if (fixtures.length === 0) return result;

  // Scoring config lives per competition, so group the work by competition.
  const tournamentIds = [...new Set(fixtures.map(f => f.liveTournamentId))];
  const competitions = await db
    .select({
      id: liveCompetitions.id,
      liveTournamentId: liveCompetitions.liveTournamentId,
      scoringConfig: liveCompetitions.scoringConfig,
    })
    .from(liveCompetitions)
    .where(inArray(liveCompetitions.liveTournamentId, tournamentIds));
  if (competitions.length === 0) return result;

  const fixtureById = new Map(fixtures.map(f => [f.id, f]));
  const affected = new Set<string>();

  for (const competition of competitions) {
    const config: LiveScoringConfig = competition.scoringConfig ?? DEFAULT_LIVE_SCORING_CONFIG;
    const relevantFixtureIds = fixtures
      .filter(f => f.liveTournamentId === competition.liveTournamentId)
      .map(f => f.id);

    const predictions = await db
      .select({
        id: livePredictions.id,
        liveFixtureId: livePredictions.liveFixtureId,
        homeScore: livePredictions.homeScore,
        awayScore: livePredictions.awayScore,
      })
      .from(livePredictions)
      .where(
        and(
          eq(livePredictions.liveCompetitionId, competition.id),
          inArray(livePredictions.liveFixtureId, relevantFixtureIds),
        ),
      );
    if (predictions.length === 0) continue;

    for (const prediction of predictions) {
      const fixture = fixtureById.get(prediction.liveFixtureId);
      if (!fixture) continue;

      const points = calculateLivePoints(
        { homeScore: prediction.homeScore, awayScore: prediction.awayScore },
        fixture,
        config,
      );

      await db
        .update(livePredictions)
        .set({
          points: points.points,
          correctOutcomePoints: points.correctOutcomePoints,
          correctGoalDifferencePoints: points.correctGoalDifferencePoints,
          exactScorePoints: points.exactScorePoints,
          updatedAt: new Date(),
        })
        .where(eq(livePredictions.id, prediction.id));

      result.scoredPredictions++;
    }

    affected.add(competition.id);
  }

  result.affectedCompetitionIds = [...affected];
  await recomputeMemberTotals(result.affectedCompetitionIds);
  return result;
}

/**
 * Rebuild one competition's scores from scratch.
 *
 * Needed whenever scoringConfig changes, since stored points were computed under the old
 * values. Every prediction on a scorable fixture is recomputed; predictions on fixtures
 * that are not scorable have their points cleared back to null.
 */
export async function recalculateLiveCompetition(competitionId: string): Promise<ScoreFixturesResult> {
  const [competition] = await db
    .select({
      id: liveCompetitions.id,
      liveTournamentId: liveCompetitions.liveTournamentId,
      scoringConfig: liveCompetitions.scoringConfig,
    })
    .from(liveCompetitions)
    .where(eq(liveCompetitions.id, competitionId));
  if (!competition) return { scoredPredictions: 0, affectedCompetitionIds: [] };

  const config: LiveScoringConfig = competition.scoringConfig ?? DEFAULT_LIVE_SCORING_CONFIG;

  const rows = await db
    .select({
      predictionId: livePredictions.id,
      homeScore: livePredictions.homeScore,
      awayScore: livePredictions.awayScore,
      status: liveFixtures.status,
      normalTimeHome: liveFixtures.normalTimeHome,
      normalTimeAway: liveFixtures.normalTimeAway,
    })
    .from(livePredictions)
    .innerJoin(liveFixtures, eq(livePredictions.liveFixtureId, liveFixtures.id))
    .where(eq(livePredictions.liveCompetitionId, competition.id));

  let scored = 0;
  for (const row of rows) {
    const points = calculateLivePoints(
      { homeScore: row.homeScore, awayScore: row.awayScore },
      row,
      config,
    );
    // An unscorable fixture goes back to null rather than a stored zero, so the UI can
    // tell "not scored yet" apart from "scored, nothing earned".
    const scorable = row.status === 'finished' && row.normalTimeHome !== null;

    await db
      .update(livePredictions)
      .set({
        points: scorable ? points.points : null,
        correctOutcomePoints: points.correctOutcomePoints,
        correctGoalDifferencePoints: points.correctGoalDifferencePoints,
        exactScorePoints: points.exactScorePoints,
        updatedAt: new Date(),
      })
      .where(eq(livePredictions.id, row.predictionId));

    if (scorable) scored++;
  }

  await recomputeMemberTotals([competition.id]);
  return { scoredPredictions: scored, affectedCompetitionIds: [competition.id] };
}

/** Rebuild every competition attached to a tournament. */
export async function recalculateLiveTournament(tournamentId: string): Promise<ScoreFixturesResult> {
  const competitions = await db
    .select({ id: liveCompetitions.id })
    .from(liveCompetitions)
    .where(eq(liveCompetitions.liveTournamentId, tournamentId));

  let scored = 0;
  for (const competition of competitions) {
    const result = await recalculateLiveCompetition(competition.id);
    scored += result.scoredPredictions;
  }

  return { scoredPredictions: scored, affectedCompetitionIds: competitions.map(c => c.id) };
}

/**
 * The sync tick's hand-off: score what just finished, then tell watching clients.
 *
 * `changedFixtureIds` are fixtures whose score moved while in play — they award nothing
 * yet, but watchers still want to see the new scoreline.
 */
export async function applySyncResult(opts: {
  liveTournamentId: string;
  newlyFinishedFixtureIds: string[];
  changedFixtureIds: string[];
}): Promise<ScoreFixturesResult> {
  const result = await scoreFixtures(opts.newlyFinishedFixtureIds);

  if (result.affectedCompetitionIds.length > 0) {
    notifyLiveCompetitions(result.affectedCompetitionIds, 'leaderboard-updated');
  }

  if (opts.newlyFinishedFixtureIds.length > 0 || opts.changedFixtureIds.length > 0) {
    const competitions = await db
      .select({ id: liveCompetitions.id })
      .from(liveCompetitions)
      .where(eq(liveCompetitions.liveTournamentId, opts.liveTournamentId));
    notifyLiveCompetitions(
      competitions.map(c => c.id),
      'fixtures-updated',
    );
  }

  return result;
}
