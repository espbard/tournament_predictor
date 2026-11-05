import { Router } from 'express';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  CreateLiveBonusRoundSchema,
  SaveLiveBonusRoundPredictionSchema,
  SetLiveBonusRoundFixturesSchema,
  SetLiveFixtureScoreOverrideSchema,
  UpdateLiveBonusRoundSchema,
  bonusRoundScore,
  canSeeLiveBonusRound,
  fixtureLockAt,
  isFixtureLocked,
  type LiveBonusRoundFixtureView,
  type LiveBonusRoundView,
  type LiveBonusRoundVisibility,
} from '@tournament-predictor/shared';
import { db } from '../../db/client';
import {
  liveBonusRoundFixtures,
  liveBonusRoundPredictions,
  liveBonusRounds,
  liveCompetitionMembers,
  liveCompetitions,
  liveFixtures,
  liveTeams,
  liveTournaments,
} from '../../db/liveSchema';
import { users } from '../../db/schema';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { canViewLiveCompetition, isLiveMember } from '../../lib/competitionAccess';
import { notifyLiveCompetitions } from '../liveEvents';
import {
  competitionsWithBonusFixtures,
  recalculateBonusRoundsForCompetition,
  scoreBonusRoundFixtures,
} from '../bonusRoundScoring';
import { recomputeLiveMemberTotals } from '../scoringTrigger';

// ── Bonus rounds API ──────────────────────────────────────────────────────────
//
// Extra rounds of match predictions inside one live competition, built from fixtures of
// bonus-source tournaments (the Nations League). See shared/src/live/bonusRounds.ts for
// the model and server/src/live/bonusRoundScoring.ts for the scoring.
//
// Visibility is enforced here, on every read and write: a round still set to 'test' is
// visible to test accounts and admins only, and to everybody else it simply does not
// exist — an empty list, a 404 — so nothing about it leaks into a regular player's page.

export const liveBonusRoundsRouter = Router();

type Viewer = { id: string; isAdmin: boolean; isTestAccount: boolean; isLeaderboardUser: boolean };

function fail(res: Parameters<typeof requireAuth>[1], err: unknown) {
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

/** Same rule as the competition routes: test accounts may read predictions before the lock. */
function canPreviewPredictions(user: Viewer): boolean {
  return user.isTestAccount;
}

type RoundRow = typeof liveBonusRounds.$inferSelect;

/** The round with its fixtures, as the fixtures tab renders it, for one viewer. */
async function buildRoundViews(rounds: RoundRow[], viewerId: string | null): Promise<LiveBonusRoundView[]> {
  if (rounds.length === 0) return [];

  const placements = await db
    .select({
      bonusRoundId: liveBonusRoundFixtures.bonusRoundId,
      liveCompetitionId: liveBonusRoundFixtures.liveCompetitionId,
      multiplier: liveBonusRoundFixtures.multiplier,
      fixture: liveFixtures,
      sourceTournamentName: liveTournaments.name,
    })
    .from(liveBonusRoundFixtures)
    .innerJoin(liveFixtures, eq(liveFixtures.id, liveBonusRoundFixtures.liveFixtureId))
    .innerJoin(liveTournaments, eq(liveTournaments.id, liveFixtures.liveTournamentId))
    .where(
      inArray(
        liveBonusRoundFixtures.bonusRoundId,
        rounds.map(r => r.id),
      ),
    )
    .orderBy(asc(liveFixtures.kickoffAt), asc(liveFixtures.providerFixtureId));

  const teamIds = [
    ...new Set(
      placements
        .flatMap(p => [p.fixture.homeTeamId, p.fixture.awayTeamId])
        .filter((id): id is string => !!id),
    ),
  ];
  const teams = teamIds.length ? await db.select().from(liveTeams).where(inArray(liveTeams.id, teamIds)) : [];
  const teamById = new Map(teams.map(t => [t.id, t]));

  const fixtureIds = placements.map(p => p.fixture.id);
  const competitionIds = [...new Set(rounds.map(r => r.liveCompetitionId))];
  const predictions =
    viewerId && fixtureIds.length
      ? await db
          .select()
          .from(liveBonusRoundPredictions)
          .where(
            and(
              inArray(liveBonusRoundPredictions.liveCompetitionId, competitionIds),
              eq(liveBonusRoundPredictions.userId, viewerId),
              inArray(liveBonusRoundPredictions.liveFixtureId, fixtureIds),
            ),
          )
      : [];
  const predictionByKey = new Map(predictions.map(p => [`${p.liveCompetitionId}#${p.liveFixtureId}`, p]));

  const now = new Date();
  const fixturesByRound = new Map<string, LiveBonusRoundFixtureView[]>();
  for (const placement of placements) {
    const f = placement.fixture;
    const score = bonusRoundScore(f);
    const prediction = predictionByKey.get(`${placement.liveCompetitionId}#${f.id}`) ?? null;
    const lockAt = fixtureLockAt(f.kickoffAt);
    const view = {
      ...f,
      // The round's multiplier and the round's score, so the ordinary cards draw it.
      multiplier: placement.multiplier,
      normalTimeHome: score.home,
      normalTimeAway: score.away,
      scoreOverridden: score.overridden,
      sourceTournamentId: f.liveTournamentId,
      sourceTournamentName: placement.sourceTournamentName,
      homeTeam: f.homeTeamId ? teamById.get(f.homeTeamId) ?? null : null,
      awayTeam: f.awayTeamId ? teamById.get(f.awayTeamId) ?? null : null,
      prediction: prediction
        ? {
            homeScore: prediction.homeScore,
            awayScore: prediction.awayScore,
            points: prediction.points,
            correctOutcomePoints: prediction.correctOutcomePoints,
            correctGoalDifferencePoints: prediction.correctGoalDifferencePoints,
            exactScorePoints: prediction.exactScorePoints,
            multiplierBonusPoints: prediction.multiplierBonusPoints,
          }
        : null,
      lockedAt: lockAt ? lockAt.toISOString() : null,
      isLocked: isFixtureLocked({ kickoffAt: f.kickoffAt, status: f.status }, now),
      isPredictable: true,
      isSelected: true,
    } as unknown as LiveBonusRoundFixtureView;
    const bucket = fixturesByRound.get(placement.bonusRoundId) ?? [];
    bucket.push(view);
    fixturesByRound.set(placement.bonusRoundId, bucket);
  }

  // Rows carry Dates until they are serialised; the view promises ISO strings.
  const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));

  return rounds.map(round => {
    const fixtures = fixturesByRound.get(round.id) ?? [];
    const firstKickoff = fixtures
      .map(f => toIso(f.kickoffAt))
      .filter((k): k is string => !!k)
      .sort()[0];
    return {
      ...round,
      createdAt: toIso(round.createdAt) as string,
      updatedAt: toIso(round.updatedAt) as string,
      visibility: round.visibility as LiveBonusRoundVisibility,
      fixtures,
      firstKickoffAt: firstKickoff ?? null,
    };
  });
}

async function loadRound(roundId: string): Promise<RoundRow | null> {
  const [round] = await db.select().from(liveBonusRounds).where(eq(liveBonusRounds.id, roundId));
  return round ?? null;
}

/** Points moved (or their visibility did): rebuild totals and tell anyone watching. */
async function afterScoresMoved(competitionIds: string[], fixturesToo = false): Promise<void> {
  if (competitionIds.length === 0) return;
  await recomputeLiveMemberTotals(competitionIds);
  notifyLiveCompetitions(competitionIds, 'leaderboard-updated');
  if (fixturesToo) notifyLiveCompetitions(competitionIds, 'fixtures-updated');
}

// ── Reading ───────────────────────────────────────────────────────────────────

liveBonusRoundsRouter.get('/competitions/:id/bonus-rounds', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user as Viewer;
    if (!(await canViewLiveCompetition(req.params.id, user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }
    const rounds = (
      await db
        .select()
        .from(liveBonusRounds)
        .where(eq(liveBonusRounds.liveCompetitionId, req.params.id))
        .orderBy(asc(liveBonusRounds.createdAt))
    ).filter(r => canSeeLiveBonusRound(user, r));

    return res.json(await buildRoundViews(rounds, user.id));
  } catch (err) {
    return fail(res, err);
  }
});

/** Bonus-source tournaments, for the admin's fixture picker. */
liveBonusRoundsRouter.get('/bonus-sources', requireAdmin, async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: liveTournaments.id,
        name: liveTournaments.name,
        status: liveTournaments.status,
        lastSyncError: liveTournaments.lastSyncError,
      })
      .from(liveTournaments)
      .where(eq(liveTournaments.isBonusSource, true))
      .orderBy(asc(liveTournaments.name));
    return res.json(rows);
  } catch (err) {
    return fail(res, err);
  }
});

/** Every fixture of one bonus source, with its teams, for the picker. */
liveBonusRoundsRouter.get('/bonus-sources/:tournamentId/fixtures', requireAdmin, async (req, res) => {
  try {
    const [tournament] = await db
      .select({ id: liveTournaments.id, isBonusSource: liveTournaments.isBonusSource })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.tournamentId));
    if (!tournament?.isBonusSource) return res.status(404).json({ error: 'Not a bonus source' });

    const fixtures = await db
      .select()
      .from(liveFixtures)
      .where(eq(liveFixtures.liveTournamentId, tournament.id))
      .orderBy(asc(liveFixtures.kickoffAt), asc(liveFixtures.providerFixtureId));
    const teams = await db.select().from(liveTeams).where(eq(liveTeams.liveTournamentId, tournament.id));
    const teamById = new Map(teams.map(t => [t.id, t]));

    return res.json(
      fixtures.map(f => ({
        ...f,
        homeTeam: f.homeTeamId ? teamById.get(f.homeTeamId) ?? null : null,
        awayTeam: f.awayTeamId ? teamById.get(f.awayTeamId) ?? null : null,
      })),
    );
  } catch (err) {
    return fail(res, err);
  }
});

// ── Admin: rounds ─────────────────────────────────────────────────────────────

liveBonusRoundsRouter.post('/competitions/:id/bonus-rounds', requireAdmin, async (req, res) => {
  try {
    const parsed = CreateLiveBonusRoundSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const [competition] = await db
      .select({ id: liveCompetitions.id })
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });

    const now = new Date();
    const [created] = await db
      .insert(liveBonusRounds)
      .values({
        id: generateId(15),
        liveCompetitionId: competition.id,
        name: parsed.data.name,
        afterStageKey: parsed.data.afterStageKey,
        // A matchday means nothing without the stage it belongs to.
        afterMatchday: parsed.data.afterStageKey === null ? null : parsed.data.afterMatchday,
        visibility: parsed.data.visibility ?? 'test',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [view] = await buildRoundViews([created], res.locals.user.id);
    return res.status(201).json(view);
  } catch (err) {
    return fail(res, err);
  }
});

liveBonusRoundsRouter.patch('/bonus-rounds/:roundId', requireAdmin, async (req, res) => {
  try {
    const parsed = UpdateLiveBonusRoundSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const current = await loadRound(req.params.roundId);
    if (!current) return res.status(404).json({ error: 'Not found' });

    const update: Partial<RoundRow> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.afterStageKey !== undefined) update.afterStageKey = parsed.data.afterStageKey;
    if (parsed.data.afterMatchday !== undefined) update.afterMatchday = parsed.data.afterMatchday;
    if (parsed.data.visibility !== undefined) update.visibility = parsed.data.visibility;
    if ((update.afterStageKey ?? current.afterStageKey) === null) update.afterMatchday = null;

    const [updated] = await db
      .update(liveBonusRounds)
      .set(update)
      .where(eq(liveBonusRounds.id, current.id))
      .returning();

    // Going public (or back) moves the round's points into (or out of) the totals.
    if (parsed.data.visibility !== undefined && parsed.data.visibility !== current.visibility) {
      await afterScoresMoved([current.liveCompetitionId], true);
    } else {
      notifyLiveCompetitions([current.liveCompetitionId], 'fixtures-updated');
    }

    const [view] = await buildRoundViews([updated], res.locals.user.id);
    return res.json(view);
  } catch (err) {
    return fail(res, err);
  }
});

liveBonusRoundsRouter.delete('/bonus-rounds/:roundId', requireAdmin, async (req, res) => {
  try {
    const round = await loadRound(req.params.roundId);
    if (!round) return res.status(404).json({ error: 'Not found' });

    await db.transaction(async tx => {
      const placed = await tx
        .select({ liveFixtureId: liveBonusRoundFixtures.liveFixtureId })
        .from(liveBonusRoundFixtures)
        .where(eq(liveBonusRoundFixtures.bonusRoundId, round.id));
      if (placed.length > 0) {
        await tx.delete(liveBonusRoundPredictions).where(
          and(
            eq(liveBonusRoundPredictions.liveCompetitionId, round.liveCompetitionId),
            inArray(
              liveBonusRoundPredictions.liveFixtureId,
              placed.map(p => p.liveFixtureId),
            ),
          ),
        );
      }
      await tx.delete(liveBonusRounds).where(eq(liveBonusRounds.id, round.id));
    });

    await afterScoresMoved([round.liveCompetitionId], true);
    return res.status(204).end();
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Replace a round's fixtures, each with its multiplier.
 *
 * Only fixtures of bonus-source tournaments, and none already in another round of the
 * same competition. Dropping a fixture deletes the predictions made on it here, so that
 * is refused with 409 unless `force` is set.
 */
liveBonusRoundsRouter.put('/bonus-rounds/:roundId/fixtures', requireAdmin, async (req, res) => {
  try {
    const parsed = SetLiveBonusRoundFixturesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const round = await loadRound(req.params.roundId);
    if (!round) return res.status(404).json({ error: 'Not found' });

    const wanted = new Map<string, number>();
    for (const f of parsed.data.fixtures) wanted.set(f.fixtureId, f.multiplier);
    const wantedIds = [...wanted.keys()];

    if (wantedIds.length > 0) {
      const found = await db
        .select({ id: liveFixtures.id, isBonusSource: liveTournaments.isBonusSource })
        .from(liveFixtures)
        .innerJoin(liveTournaments, eq(liveTournaments.id, liveFixtures.liveTournamentId))
        .where(inArray(liveFixtures.id, wantedIds));
      const valid = new Set(found.filter(f => f.isBonusSource).map(f => f.id));
      const invalid = wantedIds.filter(id => !valid.has(id));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: 'Only matches from a bonus-source tournament can go in a bonus round',
          fixtureIds: invalid,
        });
      }

      const elsewhere = await db
        .select({ liveFixtureId: liveBonusRoundFixtures.liveFixtureId })
        .from(liveBonusRoundFixtures)
        .where(
          and(
            eq(liveBonusRoundFixtures.liveCompetitionId, round.liveCompetitionId),
            inArray(liveBonusRoundFixtures.liveFixtureId, wantedIds),
            notInArray(liveBonusRoundFixtures.bonusRoundId, [round.id]),
          ),
        );
      if (elsewhere.length > 0) {
        return res.status(409).json({
          error: 'Some matches are already in another bonus round of this competition',
          fixtureIds: elsewhere.map(e => e.liveFixtureId),
        });
      }
    }

    const current = await db
      .select({ liveFixtureId: liveBonusRoundFixtures.liveFixtureId })
      .from(liveBonusRoundFixtures)
      .where(eq(liveBonusRoundFixtures.bonusRoundId, round.id));
    const removed = current.map(c => c.liveFixtureId).filter(id => !wanted.has(id));

    if (removed.length > 0 && !parsed.data.force) {
      const predicted = await db
        .select({ liveFixtureId: liveBonusRoundPredictions.liveFixtureId })
        .from(liveBonusRoundPredictions)
        .where(
          and(
            eq(liveBonusRoundPredictions.liveCompetitionId, round.liveCompetitionId),
            inArray(liveBonusRoundPredictions.liveFixtureId, removed),
          ),
        );
      if (predicted.length > 0) {
        return res.status(409).json({
          error:
            `${predicted.length} prediction(s) have been made on the matches being removed. ` +
            'Removing them deletes those predictions.',
          predictionsAffected: predicted.length,
          needsForce: true,
        });
      }
    }

    await db.transaction(async tx => {
      if (removed.length > 0) {
        await tx.delete(liveBonusRoundPredictions).where(
          and(
            eq(liveBonusRoundPredictions.liveCompetitionId, round.liveCompetitionId),
            inArray(liveBonusRoundPredictions.liveFixtureId, removed),
          ),
        );
      }
      await tx.delete(liveBonusRoundFixtures).where(eq(liveBonusRoundFixtures.bonusRoundId, round.id));
      if (wantedIds.length > 0) {
        await tx.insert(liveBonusRoundFixtures).values(
          wantedIds.map(fixtureId => ({
            bonusRoundId: round.id,
            liveCompetitionId: round.liveCompetitionId,
            liveFixtureId: fixtureId,
            multiplier: wanted.get(fixtureId) ?? 1,
          })),
        );
      }
      await tx.update(liveBonusRounds).set({ updatedAt: new Date() }).where(eq(liveBonusRounds.id, round.id));
    });

    // A changed multiplier moves points already awarded.
    await recalculateBonusRoundsForCompetition(round.liveCompetitionId);
    await afterScoresMoved([round.liveCompetitionId], true);

    const [view] = await buildRoundViews([(await loadRound(round.id))!], res.locals.user.id);
    return res.json(view);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Set (or clear) the normal-time score a bonus round scores this fixture on.
 *
 * For a bigballsdata fixture that went to extra time, whose one score cannot be told
 * apart from the 90-minute one. Rescores every competition that has the fixture.
 */
liveBonusRoundsRouter.put('/bonus-fixtures/:fixtureId/score-override', requireAdmin, async (req, res) => {
  try {
    const parsed = SetLiveFixtureScoreOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const { homeScore, awayScore } = parsed.data;
    if ((homeScore === null) !== (awayScore === null)) {
      return res.status(400).json({ error: 'Set both scores, or clear both' });
    }

    const [updated] = await db
      .update(liveFixtures)
      .set({ scoreOverrideHome: homeScore, scoreOverrideAway: awayScore })
      .where(eq(liveFixtures.id, req.params.fixtureId))
      .returning({ id: liveFixtures.id });
    if (!updated) return res.status(404).json({ error: 'Fixture not found' });

    const scored = await scoreBonusRoundFixtures([updated.id]);
    const competitionIds = [
      ...new Set([...scored.affectedCompetitionIds, ...(await competitionsWithBonusFixtures([updated.id]))]),
    ];
    await afterScoresMoved(competitionIds, true);
    return res.json({ ok: true, rescoredPredictions: scored.scoredPredictions });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Predictions ───────────────────────────────────────────────────────────────

/** The round holding a fixture in a competition, if any. */
async function roundForFixture(competitionId: string, fixtureId: string) {
  const [row] = await db
    .select({ round: liveBonusRounds, multiplier: liveBonusRoundFixtures.multiplier })
    .from(liveBonusRoundFixtures)
    .innerJoin(liveBonusRounds, eq(liveBonusRounds.id, liveBonusRoundFixtures.bonusRoundId))
    .where(
      and(
        eq(liveBonusRoundFixtures.liveCompetitionId, competitionId),
        eq(liveBonusRoundFixtures.liveFixtureId, fixtureId),
      ),
    );
  return row ?? null;
}

liveBonusRoundsRouter.put('/competitions/:id/bonus-predictions', requireAuth, async (req, res) => {
  try {
    const parsed = SaveLiveBonusRoundPredictionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const user = res.locals.user as Viewer;
    if (user.isLeaderboardUser) {
      return res.status(403).json({ error: 'This account cannot make predictions' });
    }
    const competitionId = req.params.id;
    if (!(await isLiveMember(competitionId, user.id))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const placement = await roundForFixture(competitionId, parsed.data.fixtureId);
    if (!placement || !canSeeLiveBonusRound(user, placement.round)) {
      return res.status(404).json({ error: 'Fixture not found' });
    }

    const [fixture] = await db.select().from(liveFixtures).where(eq(liveFixtures.id, parsed.data.fixtureId));
    if (!fixture) return res.status(404).json({ error: 'Fixture not found' });

    if (isFixtureLocked({ kickoffAt: fixture.kickoffAt, status: fixture.status })) {
      const lockAt = fixtureLockAt(fixture.kickoffAt);
      return res.status(400).json({
        error: 'Predictions for this fixture are closed',
        lockedAt: lockAt ? lockAt.toISOString() : null,
      });
    }

    const now = new Date();
    const [saved] = await db
      .insert(liveBonusRoundPredictions)
      .values({
        id: generateId(15),
        liveCompetitionId: competitionId,
        userId: user.id,
        liveFixtureId: fixture.id,
        homeScore: parsed.data.homeScore,
        awayScore: parsed.data.awayScore,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          liveBonusRoundPredictions.liveCompetitionId,
          liveBonusRoundPredictions.userId,
          liveBonusRoundPredictions.liveFixtureId,
        ],
        set: { homeScore: parsed.data.homeScore, awayScore: parsed.data.awayScore, updatedAt: now },
      })
      .returning();
    return res.json(saved);
  } catch (err) {
    return fail(res, err);
  }
});

/** Every member's prediction for one bonus-round fixture — the "what everyone predicted" list. */
liveBonusRoundsRouter.get(
  '/competitions/:id/bonus-fixtures/:fixtureId/predictions',
  requireAuth,
  async (req, res) => {
    try {
      const user = res.locals.user as Viewer;
      const { id, fixtureId } = req.params;
      if (!(await canViewLiveCompetition(id, user))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }
      const placement = await roundForFixture(id, fixtureId);
      if (!placement || !canSeeLiveBonusRound(user, placement.round)) {
        return res.status(404).json({ error: 'Fixture not found' });
      }
      const [fixture] = await db.select().from(liveFixtures).where(eq(liveFixtures.id, fixtureId));
      if (!fixture) return res.status(404).json({ error: 'Fixture not found' });
      if (
        !canPreviewPredictions(user) &&
        !isFixtureLocked({ kickoffAt: fixture.kickoffAt, status: fixture.status })
      ) {
        return res.status(403).json({ error: 'Not visible until the match has locked' });
      }

      const rows = await db
        .select({
          userId: liveCompetitionMembers.userId,
          username: users.username,
          imageUrl: users.imageUrl,
          iconColor: users.iconColor,
          homeScore: liveBonusRoundPredictions.homeScore,
          awayScore: liveBonusRoundPredictions.awayScore,
          points: liveBonusRoundPredictions.points,
          correctOutcomePoints: liveBonusRoundPredictions.correctOutcomePoints,
          correctGoalDifferencePoints: liveBonusRoundPredictions.correctGoalDifferencePoints,
          exactScorePoints: liveBonusRoundPredictions.exactScorePoints,
          multiplierBonusPoints: liveBonusRoundPredictions.multiplierBonusPoints,
        })
        .from(liveCompetitionMembers)
        .innerJoin(users, eq(liveCompetitionMembers.userId, users.id))
        .leftJoin(
          liveBonusRoundPredictions,
          and(
            eq(liveBonusRoundPredictions.liveCompetitionId, liveCompetitionMembers.liveCompetitionId),
            eq(liveBonusRoundPredictions.userId, liveCompetitionMembers.userId),
            eq(liveBonusRoundPredictions.liveFixtureId, fixture.id),
          ),
        )
        .where(and(eq(liveCompetitionMembers.liveCompetitionId, id), eq(users.isLeaderboardUser, false)))
        .orderBy(asc(users.username));

      const ordered = [...rows].sort((a, b) => {
        const aHas = a.homeScore !== null;
        const bHas = b.homeScore !== null;
        if (aHas !== bHas) return aHas ? -1 : 1;
        const byPoints = (b.points ?? 0) - (a.points ?? 0);
        return byPoints !== 0 ? byPoints : a.username.localeCompare(b.username);
      });

      return res.json(
        ordered.map(row => ({
          userId: row.userId,
          username: row.username,
          imageUrl: row.imageUrl,
          iconColor: row.iconColor,
          prediction:
            row.homeScore === null || row.awayScore === null
              ? null
              : {
                  homeScore: row.homeScore,
                  awayScore: row.awayScore,
                  points: row.points,
                  correctOutcomePoints: row.correctOutcomePoints ?? 0,
                  correctGoalDifferencePoints: row.correctGoalDifferencePoints ?? 0,
                  exactScorePoints: row.exactScorePoints ?? 0,
                  multiplierBonusPoints: row.multiplierBonusPoints ?? 0,
                },
        })),
      );
    } catch (err) {
      return fail(res, err);
    }
  },
);

/**
 * Another member's bonus rounds, for their read-only predictions page: every round the
 * caller may see, with that member's predictions on the fixtures that have locked.
 */
liveBonusRoundsRouter.get(
  '/competitions/:id/bonus-rounds/user/:userId',
  requireAuth,
  async (req, res) => {
    try {
      const user = res.locals.user as Viewer;
      const { id, userId } = req.params;
      if (!(await canViewLiveCompetition(id, user))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }
      const rounds = (
        await db
          .select()
          .from(liveBonusRounds)
          .where(eq(liveBonusRounds.liveCompetitionId, id))
          .orderBy(asc(liveBonusRounds.createdAt))
      ).filter(r => canSeeLiveBonusRound(user, r));

      const views = await buildRoundViews(rounds, userId);
      // Their own page shows everything; anyone else's only what has locked.
      const seesEverything = userId === user.id || canPreviewPredictions(user);
      return res.json(
        views.map(round => ({
          ...round,
          fixtures: round.fixtures.map(f =>
            seesEverything || f.isLocked ? f : { ...f, prediction: null },
          ),
        })),
      );
    } catch (err) {
      return fail(res, err);
    }
  },
);
