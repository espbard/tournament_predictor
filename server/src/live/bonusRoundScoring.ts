import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withLiveScoringDefaults } from '@tournament-predictor/shared';
import { db } from '../db/client';
import {
  liveBonusRoundFixtures,
  liveBonusRoundPredictions,
  liveBonusRounds,
  liveCompetitions,
  liveFixtures,
} from '../db/liveSchema';
import { calculateBonusRoundPoints, isBonusRoundFixtureScorable } from './bonusRoundPoints';

// ── Bonus-round scoring ───────────────────────────────────────────────────────
//
// Writes points onto live_bonus_round_predictions. The rollup into member totals is the
// caller's job (recomputeLiveMemberTotals in scoringTrigger.ts), which keeps this module
// free of a circular import and lets one recompute cover several scoring passes.
//
// Driven by the source tournament's sync: when a Nations League fixture finishes, every
// competition with that fixture in a bonus round is scored. Note the source tournament
// itself has no competitions — that is why this cannot hang off scoreFixtures, which
// stops as soon as it finds none.

export interface BonusRoundScoringResult {
  scoredPredictions: number;
  affectedCompetitionIds: string[];
}

const EMPTY: BonusRoundScoringResult = { scoredPredictions: 0, affectedCompetitionIds: [] };

/**
 * Rescore every bonus-round prediction on the given fixtures, in every competition that
 * has them in a round. Safe to re-run: points are recomputed from scratch.
 *
 * A fixture that is not scorable (yet, or any more) has its predictions' points set back
 * to null, so "not scored" and "scored nothing" stay distinguishable.
 */
export async function scoreBonusRoundFixtures(fixtureIds: string[]): Promise<BonusRoundScoringResult> {
  if (fixtureIds.length === 0) return { ...EMPTY };

  const placements = await db
    .select({
      liveCompetitionId: liveBonusRoundFixtures.liveCompetitionId,
      liveFixtureId: liveBonusRoundFixtures.liveFixtureId,
      multiplier: liveBonusRoundFixtures.multiplier,
      scoringConfig: liveCompetitions.scoringConfig,
      status: liveFixtures.status,
      normalTimeHome: liveFixtures.normalTimeHome,
      normalTimeAway: liveFixtures.normalTimeAway,
      scoreOverrideHome: liveFixtures.scoreOverrideHome,
      scoreOverrideAway: liveFixtures.scoreOverrideAway,
    })
    .from(liveBonusRoundFixtures)
    .innerJoin(liveCompetitions, eq(liveCompetitions.id, liveBonusRoundFixtures.liveCompetitionId))
    .innerJoin(liveFixtures, eq(liveFixtures.id, liveBonusRoundFixtures.liveFixtureId))
    .where(inArray(liveBonusRoundFixtures.liveFixtureId, fixtureIds));

  return scorePlacements(placements);
}

/** Rescore every bonus-round prediction in one competition — after a config change, say. */
export async function recalculateBonusRoundsForCompetition(
  competitionId: string,
): Promise<BonusRoundScoringResult> {
  const placements = await db
    .select({
      liveCompetitionId: liveBonusRoundFixtures.liveCompetitionId,
      liveFixtureId: liveBonusRoundFixtures.liveFixtureId,
      multiplier: liveBonusRoundFixtures.multiplier,
      scoringConfig: liveCompetitions.scoringConfig,
      status: liveFixtures.status,
      normalTimeHome: liveFixtures.normalTimeHome,
      normalTimeAway: liveFixtures.normalTimeAway,
      scoreOverrideHome: liveFixtures.scoreOverrideHome,
      scoreOverrideAway: liveFixtures.scoreOverrideAway,
    })
    .from(liveBonusRoundFixtures)
    .innerJoin(liveCompetitions, eq(liveCompetitions.id, liveBonusRoundFixtures.liveCompetitionId))
    .innerJoin(liveFixtures, eq(liveFixtures.id, liveBonusRoundFixtures.liveFixtureId))
    .where(eq(liveBonusRoundFixtures.liveCompetitionId, competitionId));

  const result = await scorePlacements(placements);
  // The competition is affected even when it has no rounds left: a deleted round's
  // points have to come off the totals.
  return { ...result, affectedCompetitionIds: [competitionId] };
}

/**
 * The safety net, same idea as scoreUnscoredFixtures: any finished fixture of this
 * tournament with a bonus-round prediction that has no points yet.
 */
export async function scoreUnscoredBonusRoundFixtures(
  tournamentId: string,
): Promise<BonusRoundScoringResult> {
  const rows = await db
    .selectDistinct({ id: liveFixtures.id })
    .from(liveFixtures)
    .innerJoin(liveBonusRoundPredictions, eq(liveBonusRoundPredictions.liveFixtureId, liveFixtures.id))
    .where(
      and(
        eq(liveFixtures.liveTournamentId, tournamentId),
        eq(liveFixtures.status, 'finished'),
        isNull(liveBonusRoundPredictions.points),
      ),
    );
  if (rows.length === 0) return { ...EMPTY };
  return scoreBonusRoundFixtures(rows.map(r => r.id));
}

/** Competitions with any of these fixtures in a bonus round — whom to tell about them. */
export async function competitionsWithBonusFixtures(fixtureIds: string[]): Promise<string[]> {
  if (fixtureIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: liveBonusRoundFixtures.liveCompetitionId })
    .from(liveBonusRoundFixtures)
    .where(inArray(liveBonusRoundFixtures.liveFixtureId, fixtureIds));
  return rows.map(r => r.id);
}

/**
 * Points each member holds from bonus rounds still limited to test accounts.
 *
 * Those points are kept out of total_points so regular players never see a total they
 * cannot account for; the leaderboard adds them back for a test account's view only.
 */
export async function loadTestOnlyBonusRoundPoints(competitionId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      userId: liveBonusRoundPredictions.userId,
      points: sql<number>`coalesce(sum(${liveBonusRoundPredictions.points}), 0)::int`,
    })
    .from(liveBonusRoundPredictions)
    .innerJoin(
      liveBonusRoundFixtures,
      and(
        eq(liveBonusRoundFixtures.liveCompetitionId, liveBonusRoundPredictions.liveCompetitionId),
        eq(liveBonusRoundFixtures.liveFixtureId, liveBonusRoundPredictions.liveFixtureId),
      ),
    )
    .innerJoin(liveBonusRounds, eq(liveBonusRounds.id, liveBonusRoundFixtures.bonusRoundId))
    .where(
      and(
        eq(liveBonusRoundPredictions.liveCompetitionId, competitionId),
        eq(liveBonusRounds.visibility, 'test'),
      ),
    )
    .groupBy(liveBonusRoundPredictions.userId);
  return new Map(rows.map(r => [r.userId, Number(r.points)]));
}

// ── Internals ─────────────────────────────────────────────────────────────────

interface Placement {
  liveCompetitionId: string;
  liveFixtureId: string;
  multiplier: number;
  scoringConfig: unknown;
  status: (typeof liveFixtures.$inferSelect)['status'];
  normalTimeHome: number | null;
  normalTimeAway: number | null;
  scoreOverrideHome: number | null;
  scoreOverrideAway: number | null;
}

async function scorePlacements(placements: Placement[]): Promise<BonusRoundScoringResult> {
  if (placements.length === 0) return { ...EMPTY };

  const affected = new Set<string>();
  let scored = 0;

  for (const placement of placements) {
    const predictions = await db
      .select({
        id: liveBonusRoundPredictions.id,
        homeScore: liveBonusRoundPredictions.homeScore,
        awayScore: liveBonusRoundPredictions.awayScore,
      })
      .from(liveBonusRoundPredictions)
      .where(
        and(
          eq(liveBonusRoundPredictions.liveCompetitionId, placement.liveCompetitionId),
          eq(liveBonusRoundPredictions.liveFixtureId, placement.liveFixtureId),
        ),
      );
    if (predictions.length === 0) continue;

    const config = withLiveScoringDefaults(placement.scoringConfig as never);
    const scorable = isBonusRoundFixtureScorable(placement);

    for (const prediction of predictions) {
      const points = calculateBonusRoundPoints(prediction, placement, placement.multiplier, config);
      await db
        .update(liveBonusRoundPredictions)
        .set({
          points: scorable ? points.points : null,
          correctOutcomePoints: points.correctOutcomePoints,
          correctGoalDifferencePoints: points.correctGoalDifferencePoints,
          exactScorePoints: points.exactScorePoints,
          multiplierBonusPoints: points.multiplierBonusPoints,
          updatedAt: new Date(),
        })
        .where(eq(liveBonusRoundPredictions.id, prediction.id));
      if (scorable) scored++;
    }
    affected.add(placement.liveCompetitionId);
  }

  return { scoredPredictions: scored, affectedCompetitionIds: [...affected] };
}
