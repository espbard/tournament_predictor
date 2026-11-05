import { and, eq, sql } from 'drizzle-orm';
import { withLiveScoringDefaults } from '@tournament-predictor/shared';
import { db } from '../db/client';
import {
  liveBonusRoundFixtures,
  liveBonusRoundPredictions,
  liveBonusRounds,
  liveCompetitions,
} from '../db/liveSchema';
import { calculateBonusRoundPoints, isBonusFixtureScorable } from './bonusRoundPoints';

// ── Bonus-round scoring ───────────────────────────────────────────────────────
//
// Writes points onto live_bonus_round_predictions. Runs when an admin enters or changes a
// result (or a multiplier), and on a competition recalculation — there is no provider
// behind these matches, so nothing else ever changes them.
//
// The rollup into member totals is the caller's job (recomputeLiveMemberTotals in
// scoringTrigger.ts), which keeps this module free of a circular import.

export interface BonusRoundScoringResult {
  scoredPredictions: number;
}

/**
 * Rescore every prediction on one match. Safe to re-run: points are recomputed from
 * scratch, and a match without a result goes back to null — "not scored" stays
 * distinguishable from "scored nothing".
 */
export async function scoreBonusFixture(fixtureId: string): Promise<BonusRoundScoringResult> {
  const [row] = await db
    .select({ fixture: liveBonusRoundFixtures, scoringConfig: liveCompetitions.scoringConfig })
    .from(liveBonusRoundFixtures)
    .innerJoin(liveCompetitions, eq(liveCompetitions.id, liveBonusRoundFixtures.liveCompetitionId))
    .where(eq(liveBonusRoundFixtures.id, fixtureId));
  if (!row) return { scoredPredictions: 0 };
  return scoreFixtures([row.fixture], row.scoringConfig);
}

/** Rescore every bonus-round prediction in one competition — after a config change, say. */
export async function recalculateBonusRoundsForCompetition(
  competitionId: string,
): Promise<BonusRoundScoringResult> {
  const [competition] = await db
    .select({ scoringConfig: liveCompetitions.scoringConfig })
    .from(liveCompetitions)
    .where(eq(liveCompetitions.id, competitionId));
  if (!competition) return { scoredPredictions: 0 };

  const fixtures = await db
    .select()
    .from(liveBonusRoundFixtures)
    .where(eq(liveBonusRoundFixtures.liveCompetitionId, competitionId));
  return scoreFixtures(fixtures, competition.scoringConfig);
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
    .innerJoin(liveBonusRoundFixtures, eq(liveBonusRoundFixtures.id, liveBonusRoundPredictions.bonusFixtureId))
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

async function scoreFixtures(
  fixtures: Array<typeof liveBonusRoundFixtures.$inferSelect>,
  storedConfig: unknown,
): Promise<BonusRoundScoringResult> {
  const config = withLiveScoringDefaults(storedConfig as never);
  let scored = 0;

  for (const fixture of fixtures) {
    const predictions = await db
      .select({
        id: liveBonusRoundPredictions.id,
        homeScore: liveBonusRoundPredictions.homeScore,
        awayScore: liveBonusRoundPredictions.awayScore,
      })
      .from(liveBonusRoundPredictions)
      .where(eq(liveBonusRoundPredictions.bonusFixtureId, fixture.id));
    if (predictions.length === 0) continue;

    const scorable = isBonusFixtureScorable(fixture);
    for (const prediction of predictions) {
      const points = calculateBonusRoundPoints(prediction, fixture, config);
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
  }

  return { scoredPredictions: scored };
}
