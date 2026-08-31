import { Router } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  CreateLiveCompetitionSchema,
  JoinLiveCompetitionSchema,
  ListLiveFixturesQuerySchema,
  SaveLiveBonusAnswerSchema,
  SaveLivePredictionSchema,
  SaveLiveTablePredictionSchema,
  UpdateLiveCompetitionSchema,
  bonusQuestionLockAt,
  checkLiveBonusAnswer,
  fixtureLockAt,
  getLiveFormat,
  isBonusQuestionLocked,
  isFixtureLocked,
  isLiveFixtureSelected,
  isStageAtOrAfter,
  isTablePredictionLocked,
  tablePredictionLockAt,
  tablePredictionStage,
  withLiveScoringDefaults,
} from '@tournament-predictor/shared';
import type { CompetitionInvite } from '@tournament-predictor/shared';
import { db } from '../../db/client';
import {
  liveBonusAnswers,
  liveBonusQuestions,
  liveCompetitionMembers,
  liveCompetitions,
  liveFixtures,
  livePredictions,
  liveStandings,
  liveTablePredictions,
  liveTeams,
  liveTournaments,
} from '../../db/liveSchema';
import { users } from '../../db/schema';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { subscribeLiveCompetition, unsubscribeLiveCompetition } from '../liveEvents';
import { loadLiveBonusAnswers } from '../bonusScoring';
import { redactLiveBonusAnswerPoints, redactLiveBonusQuestions } from '../bonusVisibility';
import { recalculateLiveCompetition } from '../scoringTrigger';
import { loadSelectionIndex } from '../selections';
import { validateTableOrder } from '../tableScoring';
import { joinLiveCompetition } from '../../lib/competitionJoin';
import { ensureLiveInviteToken, inviteTokenPath } from '../../lib/inviteLinks';

// ── Live competition API ──────────────────────────────────────────────────────
//
// Prediction leagues on a live tournament. The defining difference from the manual type
// is the deadline: there is no competition-wide `prediction_deadline` column, and a
// prediction can be created or changed until one hour before that specific fixture's
// kickoff. Nothing else ever locks a user out.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §8 and §10.

export const liveCompetitionsRouter = Router();

function fail(res: Parameters<typeof requireAuth>[1], err: unknown) {
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

function generateInviteCode(): string {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

/** Membership check. Admins are treated as members of every competition. */
async function assertMember(
  competitionId: string,
  user: { id: string; isAdmin: boolean },
): Promise<boolean> {
  if (user.isAdmin) return true;
  const [membership] = await db
    .select({ id: liveCompetitionMembers.id })
    .from(liveCompetitionMembers)
    .where(
      and(
        eq(liveCompetitionMembers.liveCompetitionId, competitionId),
        eq(liveCompetitionMembers.userId, user.id),
      ),
    );
  return !!membership;
}

// ── Competitions ──────────────────────────────────────────────────────────────

liveCompetitionsRouter.get('/competitions', requireAuth, async (_req, res) => {
  try {
    const user = res.locals.user;
    if (user.isAdmin) {
      const all = await db
        .select()
        .from(liveCompetitions)
        .orderBy(asc(liveCompetitions.createdAt));
      return res.json(all);
    }

    const rows = await db
      .select({ competition: liveCompetitions })
      .from(liveCompetitionMembers)
      .innerJoin(liveCompetitions, eq(liveCompetitionMembers.liveCompetitionId, liveCompetitions.id))
      .where(eq(liveCompetitionMembers.userId, user.id));
    return res.json(rows.map(r => r.competition));
  } catch (err) {
    return fail(res, err);
  }
});

// Defined before /competitions/:id so 'join' is not swallowed as an id.
liveCompetitionsRouter.post('/competitions/join', requireAuth, async (req, res) => {
  try {
    const parsed = JoinLiveCompetitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.inviteCode, parsed.data.inviteCode.trim()));
    if (!competition) return res.status(404).json({ error: 'Invalid invite code' });

    const result = await joinLiveCompetition(competition, res.locals.user.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(result.alreadyMember ? 200 : 201).json(competition);
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.post('/competitions', requireAdmin, async (req, res) => {
  try {
    const parsed = CreateLiveCompetitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const [tournament] = await db
      .select({ id: liveTournaments.id })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, parsed.data.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    let inviteCode = generateInviteCode();
    for (let i = 0; i < 10; i++) {
      const [clash] = await db
        .select({ id: liveCompetitions.id })
        .from(liveCompetitions)
        .where(eq(liveCompetitions.inviteCode, inviteCode));
      if (!clash) break;
      inviteCode = generateInviteCode();
    }

    const [created] = await db
      .insert(liveCompetitions)
      .values({
        id: generateId(15),
        liveTournamentId: tournament.id,
        name: parsed.data.name.trim(),
        imageUrl: parsed.data.imageUrl ?? null,
        inviteCode,
        // Any tier the caller omitted falls back to the default rather than undefined.
        scoringConfig: withLiveScoringDefaults(parsed.data.scoringConfig),
      })
      .returning();

    return res.status(201).json(created);
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.get('/competitions/:id', requireAuth, async (req, res) => {
  try {
    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });
    if (!(await assertMember(competition.id, res.locals.user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));

    const format = tournament ? getLiveFormat(tournament.format) : null;

    return res.json({
      ...competition,
      tournament: tournament ?? null,
      // The client renders its stage selector from this rather than a hardcoded list.
      stages: format?.stages ?? [],
      tableScope: format?.tableScope ?? 'single',
    });
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.patch('/competitions/:id', requireAdmin, async (req, res) => {
  try {
    const parsed = UpdateLiveCompetitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.imageUrl !== undefined) update.imageUrl = parsed.data.imageUrl;
    if (parsed.data.scoringConfig !== undefined) {
      update.scoringConfig = withLiveScoringDefaults(parsed.data.scoringConfig);
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const [row] = await db
      .update(liveCompetitions)
      .set(update)
      .where(eq(liveCompetitions.id, req.params.id))
      .returning();
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Stored points were computed under the old values, so they are now wrong.
    if (parsed.data.scoringConfig !== undefined) {
      await recalculateLiveCompetition(row.id);
    }

    return res.json(row);
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.delete('/competitions/:id', requireAdmin, async (req, res) => {
  try {
    const [row] = await db
      .delete(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id))
      .returning({ id: liveCompetitions.id });
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.post('/competitions/:id/recalculate', requireAdmin, async (req, res) => {
  try {
    const result = await recalculateLiveCompetition(req.params.id);
    return res.json(result);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Mint (or re-read) this competition's share link. Any member may invite; the token is
 * created on first use and then reused. Mirrors POST /api/competitions/:id/invite.
 */
liveCompetitionsRouter.post('/competitions/:id/invite', requireAuth, async (req, res) => {
  try {
    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });
    if (!(await assertMember(competition.id, res.locals.user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const token = await ensureLiveInviteToken(competition.id);
    if (!token) return res.status(404).json({ error: 'Not found' });

    const invite: CompetitionInvite = {
      token,
      path: inviteTokenPath(token),
      inviteCode: competition.inviteCode,
    };
    return res.json(invite);
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.delete('/competitions/:id/leave', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    await db
      .delete(liveCompetitionMembers)
      .where(
        and(
          eq(liveCompetitionMembers.liveCompetitionId, req.params.id),
          eq(liveCompetitionMembers.userId, user.id),
        ),
      );
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.get('/competitions/:id/members', requireAuth, async (req, res) => {
  try {
    if (!(await assertMember(req.params.id, res.locals.user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const rows = await db
      .select({
        userId: liveCompetitionMembers.userId,
        username: users.username,
        imageUrl: users.imageUrl,
        iconColor: users.iconColor,
        joinedAt: liveCompetitionMembers.joinedAt,
      })
      .from(liveCompetitionMembers)
      .innerJoin(users, eq(liveCompetitionMembers.userId, users.id))
      .where(eq(liveCompetitionMembers.liveCompetitionId, req.params.id))
      .orderBy(asc(users.username));
    return res.json(rows);
  } catch (err) {
    return fail(res, err);
  }
});

/** A straight read of the denormalised columns — three point sources, no computation. */
liveCompetitionsRouter.get('/competitions/:id/leaderboard', requireAuth, async (req, res) => {
  try {
    if (!(await assertMember(req.params.id, res.locals.user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const rows = await db
      .select({
        userId: liveCompetitionMembers.userId,
        username: users.username,
        imageUrl: users.imageUrl,
        iconColor: users.iconColor,
        totalPoints: liveCompetitionMembers.totalPoints,
        correctOutcomePoints: liveCompetitionMembers.correctOutcomePoints,
        correctGoalDifferencePoints: liveCompetitionMembers.correctGoalDifferencePoints,
        exactScorePoints: liveCompetitionMembers.exactScorePoints,
        tablePoints: liveCompetitionMembers.tablePoints,
        bonusPoints: liveCompetitionMembers.bonusPoints,
      })
      .from(liveCompetitionMembers)
      .innerJoin(users, eq(liveCompetitionMembers.userId, users.id))
      .where(eq(liveCompetitionMembers.liveCompetitionId, req.params.id))
      .orderBy(desc(liveCompetitionMembers.totalPoints), asc(users.username));

    // Standard competition ranking: equal totals share a rank, and the next rank skips.
    let previousPoints: number | null = null;
    let previousRank = 0;
    return res.json(
      rows.map((row, index) => {
        const rank = row.totalPoints === previousPoints ? previousRank : index + 1;
        previousPoints = row.totalPoints;
        previousRank = rank;
        return {
          userId: row.userId,
          username: row.username,
          imageUrl: row.imageUrl,
          iconColor: row.iconColor,
          totalPoints: row.totalPoints,
          rank,
          breakdown: {
            correctOutcomePoints: row.correctOutcomePoints,
            correctGoalDifferencePoints: row.correctGoalDifferencePoints,
            exactScorePoints: row.exactScorePoints,
            tablePoints: row.tablePoints,
            bonusPoints: row.bonusPoints,
          },
        };
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

liveCompetitionsRouter.get('/competitions/:id/events', requireAuth, async (req, res) => {
  const { id } = req.params;

  const [competition] = await db
    .select({ id: liveCompetitions.id })
    .from(liveCompetitions)
    .where(eq(liveCompetitions.id, id));
  if (!competition) return res.status(404).json({ error: 'Not found' });
  if (!(await assertMember(id, res.locals.user))) {
    return res.status(403).json({ error: 'Not a member of this competition' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const ping = setInterval(() => res.write(': ping\n\n'), 30_000);
  subscribeLiveCompetition(id, res);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribeLiveCompetition(id, res);
  });
});

// ── The main read model ───────────────────────────────────────────────────────

/**
 * Fixtures for a stage or matchday, with the caller's own prediction, the lock state and
 * any points awarded — everything the fixtures view needs, in one request.
 */
liveCompetitionsRouter.get('/competitions/:id/fixtures', requireAuth, async (req, res) => {
  try {
    const parsed = ListLiveFixturesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    }

    const user = res.locals.user;
    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });
    if (!(await assertMember(competition.id, user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const filters = [eq(liveFixtures.liveTournamentId, tournament.id)];
    if (parsed.data.stageKey) filters.push(eq(liveFixtures.stageKey, parsed.data.stageKey));
    if (parsed.data.matchday) filters.push(eq(liveFixtures.matchday, parsed.data.matchday));
    if (parsed.data.status) filters.push(eq(liveFixtures.status, parsed.data.status));

    const fixtures = await db
      .select()
      .from(liveFixtures)
      .where(and(...filters))
      .orderBy(asc(liveFixtures.kickoffAt), asc(liveFixtures.providerFixtureId));

    const teamIds = [
      ...new Set(
        fixtures.flatMap(f => [f.homeTeamId, f.awayTeamId]).filter((id): id is string => !!id),
      ),
    ];
    const teams = teamIds.length
      ? await db.select().from(liveTeams).where(inArray(liveTeams.id, teamIds))
      : [];
    const teamById = new Map(teams.map(t => [t.id, t]));

    const fixtureIds = fixtures.map(f => f.id);
    const predictions = fixtureIds.length
      ? await db
          .select()
          .from(livePredictions)
          .where(
            and(
              eq(livePredictions.liveCompetitionId, competition.id),
              eq(livePredictions.userId, user.id),
              inArray(livePredictions.liveFixtureId, fixtureIds),
            ),
          )
      : [];
    const predictionByFixtureId = new Map(predictions.map(p => [p.liveFixtureId, p]));

    const format = getLiveFormat(tournament.format);
    const selections = await loadSelectionIndex(tournament.id);
    const now = new Date();

    return res.json(
      fixtures.map(f => {
        const prediction = predictionByFixtureId.get(f.id) ?? null;
        const lockAt = fixtureLockAt(f.kickoffAt);
        return {
          ...f,
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
              }
            : null,
          lockedAt: lockAt ? lockAt.toISOString() : null,
          isLocked: isFixtureLocked({ kickoffAt: f.kickoffAt, status: f.status }, now),
          isPredictable: isStageAtOrAfter(format, f.stageKey, tournament.startStageKey),
          // False only where an admin has narrowed this gameweek to a set of matches
          // that leaves this one out.
          isSelected: isLiveFixtureSelected(f, selections),
        };
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

// ── League table prediction ───────────────────────────────────────────────────

/**
 * Everything the table-prediction tab needs: the teams to order, the caller's saved
 * order, the deadline, and — once the stage has been played out — how it scored.
 */
liveCompetitionsRouter.get('/competitions/:id/table-prediction', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });
    if (!(await assertMember(competition.id, user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);
    // A format with no table stage simply has no table to predict.
    if (!stage) return res.json({ available: false });

    const teams = await db
      .select()
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id))
      .orderBy(asc(liveTeams.name));

    const stageFixtures = await db
      .select({ kickoffAt: liveFixtures.kickoffAt, status: liveFixtures.status })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, tournament.id),
          eq(liveFixtures.stageKey, stage.key),
        ),
      );

    const kickoffs = stageFixtures.map(f => f.kickoffAt);
    const lockAt = tablePredictionLockAt(kickoffs);

    const [prediction] = await db
      .select()
      .from(liveTablePredictions)
      .where(
        and(
          eq(liveTablePredictions.liveCompetitionId, competition.id),
          eq(liveTablePredictions.userId, user.id),
          eq(liveTablePredictions.stageKey, stage.key),
        ),
      );

    // The live table, so the UI can offer it as a starting order and show the result.
    const standings = await db
      .select({ teamId: liveStandings.teamId, position: liveStandings.position })
      .from(liveStandings)
      .where(
        and(
          eq(liveStandings.liveTournamentId, tournament.id),
          eq(liveStandings.stageKey, stage.key),
        ),
      )
      .orderBy(asc(liveStandings.position));

    return res.json({
      available: true,
      stageKey: stage.key,
      stageLabelKey: stage.labelKey,
      bands: stage.bands ?? [],
      teams,
      prediction: prediction ?? null,
      lockedAt: lockAt ? lockAt.toISOString() : null,
      isLocked: isTablePredictionLocked(kickoffs),
      // Standings order, top first — the natural starting point for a new prediction.
      currentOrder: standings.map(s => s.teamId),
      scoringConfig: withLiveScoringDefaults(competition.scoringConfig),
    });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Save the whole predicted table.
 *
 * The order must be a complete permutation of the tournament's teams — validated
 * server-side, since a partial or duplicated table would quietly distort scoring.
 */
liveCompetitionsRouter.put('/competitions/:id/table-prediction', requireAuth, async (req, res) => {
  try {
    const parsed = SaveLiveTablePredictionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const user = res.locals.user;
    if (user.isLeaderboardUser) {
      return res.status(403).json({ error: 'This account cannot make predictions' });
    }

    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });

    const [membership] = await db
      .select({ id: liveCompetitionMembers.id })
      .from(liveCompetitionMembers)
      .where(
        and(
          eq(liveCompetitionMembers.liveCompetitionId, competition.id),
          eq(liveCompetitionMembers.userId, user.id),
        ),
      );
    if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);
    if (!stage || stage.key !== parsed.data.stageKey) {
      return res.status(400).json({ error: 'That stage does not take a table prediction' });
    }

    const stageFixtures = await db
      .select({ kickoffAt: liveFixtures.kickoffAt })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, tournament.id),
          eq(liveFixtures.stageKey, stage.key),
        ),
      );

    const kickoffs = stageFixtures.map(f => f.kickoffAt);
    if (isTablePredictionLocked(kickoffs)) {
      const lockAt = tablePredictionLockAt(kickoffs);
      return res.status(400).json({
        error: 'Table predictions for this competition are closed',
        lockedAt: lockAt ? lockAt.toISOString() : null,
      });
    }

    const teams = await db
      .select({ id: liveTeams.id })
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id));

    const validation = validateTableOrder(
      parsed.data.orderedTeamIds,
      teams.map(t => t.id),
    );
    if (!validation.ok) {
      return res.status(400).json({ error: 'Invalid table order', reason: validation.reason });
    }

    const now = new Date();
    const [saved] = await db
      .insert(liveTablePredictions)
      .values({
        id: generateId(15),
        liveCompetitionId: competition.id,
        userId: user.id,
        stageKey: stage.key,
        orderedTeamIds: parsed.data.orderedTeamIds,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          liveTablePredictions.liveCompetitionId,
          liveTablePredictions.userId,
          liveTablePredictions.stageKey,
        ],
        set: { orderedTeamIds: parsed.data.orderedTeamIds, updatedAt: now },
      })
      .returning();

    return res.json(saved);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Delete the caller's table prediction, putting them back in front of the first-run gate.
 *
 * Only while the table is still open. Once it locks the prediction is what the season is
 * scored against, so there is nothing to withdraw — the same instant the save route stops
 * accepting changes. Nothing needs recomputing either: table points are only awarded once
 * the stage finishes, long after this deadline, so the member's stored total is still zero.
 */
liveCompetitionsRouter.delete('/competitions/:id/table-prediction', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;

    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });

    const [membership] = await db
      .select({ id: liveCompetitionMembers.id })
      .from(liveCompetitionMembers)
      .where(
        and(
          eq(liveCompetitionMembers.liveCompetitionId, competition.id),
          eq(liveCompetitionMembers.userId, user.id),
        ),
      );
    if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);
    if (!stage) return res.status(400).json({ error: 'That stage does not take a table prediction' });

    const stageFixtures = await db
      .select({ kickoffAt: liveFixtures.kickoffAt })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, tournament.id),
          eq(liveFixtures.stageKey, stage.key),
        ),
      );

    const kickoffs = stageFixtures.map(f => f.kickoffAt);
    if (isTablePredictionLocked(kickoffs)) {
      const lockAt = tablePredictionLockAt(kickoffs);
      return res.status(400).json({
        error: 'Table predictions for this competition are closed',
        lockedAt: lockAt ? lockAt.toISOString() : null,
      });
    }

    const deleted = await db
      .delete(liveTablePredictions)
      .where(
        and(
          eq(liveTablePredictions.liveCompetitionId, competition.id),
          eq(liveTablePredictions.userId, user.id),
          eq(liveTablePredictions.stageKey, stage.key),
        ),
      )
      .returning({ id: liveTablePredictions.id });

    return res.json({ deleted: deleted.length });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Another member's table prediction.
 *
 * Visible to any member of the league from the moment it is submitted, deliberately: this
 * is a season-long call people want to argue about before the season rather than after it.
 * Copying an order is the accepted cost — unlike a per-fixture prediction, which stays
 * closed until its own kickoff.
 */
liveCompetitionsRouter.get(
  '/competitions/:id/table-prediction/:userId',
  requireAuth,
  async (req, res) => {
    try {
      const { id, userId } = req.params;
      if (!(await assertMember(id, res.locals.user))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }

      const [competition] = await db
        .select()
        .from(liveCompetitions)
        .where(eq(liveCompetitions.id, id));
      if (!competition) return res.status(404).json({ error: 'Not found' });

      const [tournament] = await db
        .select()
        .from(liveTournaments)
        .where(eq(liveTournaments.id, competition.liveTournamentId));
      if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

      const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);
      if (!stage) return res.json(null);

      const [prediction] = await db
        .select()
        .from(liveTablePredictions)
        .where(
          and(
            eq(liveTablePredictions.liveCompetitionId, id),
            eq(liveTablePredictions.userId, userId),
            eq(liveTablePredictions.stageKey, stage.key),
          ),
        );
      return res.json(prediction ?? null);
    } catch (err) {
      return fail(res, err);
    }
  },
);

// ── Predictions ───────────────────────────────────────────────────────────────

/**
 * Upsert one prediction.
 *
 * This is the only place the deadline is enforced, and the per-fixture lock is the whole
 * point of the type — so unlike the manual tournament routes there is deliberately no
 * bypass here for comparison-user bot accounts.
 */
liveCompetitionsRouter.put('/competitions/:id/predictions', requireAuth, async (req, res) => {
  try {
    const parsed = SaveLivePredictionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const user = res.locals.user;
    // Read-only accounts that exist purely to appear on a leaderboard cannot predict.
    if (user.isLeaderboardUser) {
      return res.status(403).json({ error: 'This account cannot make predictions' });
    }

    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });

    const [membership] = await db
      .select({ id: liveCompetitionMembers.id })
      .from(liveCompetitionMembers)
      .where(
        and(
          eq(liveCompetitionMembers.liveCompetitionId, competition.id),
          eq(liveCompetitionMembers.userId, user.id),
        ),
      );
    if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });

    const [fixture] = await db
      .select()
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.id, parsed.data.fixtureId),
          eq(liveFixtures.liveTournamentId, competition.liveTournamentId),
        ),
      );
    if (!fixture) return res.status(404).json({ error: 'Fixture not found' });

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    // Fixtures below the tournament's starting stage are ingested but never predictable.
    const format = getLiveFormat(tournament.format);
    if (!isStageAtOrAfter(format, fixture.stageKey, tournament.startStageKey)) {
      return res.status(400).json({ error: 'This fixture is not part of the prediction game' });
    }

    // Nor is one the admin left out of its gameweek's selected matches.
    const selections = await loadSelectionIndex(tournament.id);
    if (!isLiveFixtureSelected(fixture, selections)) {
      return res.status(400).json({ error: 'This match is not one of the selected matches' });
    }

    if (isFixtureLocked({ kickoffAt: fixture.kickoffAt, status: fixture.status })) {
      const lockAt = fixtureLockAt(fixture.kickoffAt);
      return res.status(400).json({
        error: 'Predictions for this fixture are closed',
        lockedAt: lockAt ? lockAt.toISOString() : null,
      });
    }

    const now = new Date();
    const [saved] = await db
      .insert(livePredictions)
      .values({
        id: generateId(15),
        liveCompetitionId: competition.id,
        userId: user.id,
        liveFixtureId: fixture.id,
        homeScore: parsed.data.homeScore,
        awayScore: parsed.data.awayScore,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          livePredictions.liveCompetitionId,
          livePredictions.userId,
          livePredictions.liveFixtureId,
        ],
        set: {
          homeScore: parsed.data.homeScore,
          awayScore: parsed.data.awayScore,
          updatedAt: now,
        },
      })
      .returning();

    return res.json(saved);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Another member's predictions — but only for fixtures that are already locked, so
 * nobody can copy a prediction while it still matters.
 */
liveCompetitionsRouter.get(
  '/competitions/:id/predictions/:userId',
  requireAuth,
  async (req, res) => {
    try {
      const { id, userId } = req.params;
      if (!(await assertMember(id, res.locals.user))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }

      const rows = await db
        .select({
          prediction: livePredictions,
          kickoffAt: liveFixtures.kickoffAt,
          status: liveFixtures.status,
        })
        .from(livePredictions)
        .innerJoin(liveFixtures, eq(livePredictions.liveFixtureId, liveFixtures.id))
        .where(
          and(eq(livePredictions.liveCompetitionId, id), eq(livePredictions.userId, userId)),
        );

      const now = new Date();
      return res.json(
        rows
          .filter(r => isFixtureLocked({ kickoffAt: r.kickoffAt, status: r.status }, now))
          .map(r => r.prediction),
      );
    } catch (err) {
      return fail(res, err);
    }
  },
);

/**
 * Every member's prediction for one fixture, with the points it earned.
 *
 * Feeds the "what everyone predicted" dropdown under a played match. Members who never
 * predicted are returned too, with a null prediction — in a small league, who sat a match
 * out is as much a part of the picture as who got it right. Read-only accounts that exist
 * purely to appear on a leaderboard are the exception: they are refused predictions
 * outright, so listing them as never having made one would be noise.
 *
 * Gated on the fixture's own lock, the same rule the per-user routes above follow: until
 * kickoff − 60 min this would be a way to copy somebody else's prediction.
 */
liveCompetitionsRouter.get(
  '/competitions/:id/fixtures/:fixtureId/predictions',
  requireAuth,
  async (req, res) => {
    try {
      const { id, fixtureId } = req.params;
      if (!(await assertMember(id, res.locals.user))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }

      const [competition] = await db
        .select()
        .from(liveCompetitions)
        .where(eq(liveCompetitions.id, id));
      if (!competition) return res.status(404).json({ error: 'Not found' });

      const [fixture] = await db
        .select()
        .from(liveFixtures)
        .where(
          and(
            eq(liveFixtures.id, fixtureId),
            eq(liveFixtures.liveTournamentId, competition.liveTournamentId),
          ),
        );
      if (!fixture) return res.status(404).json({ error: 'Fixture not found' });

      if (!isFixtureLocked({ kickoffAt: fixture.kickoffAt, status: fixture.status })) {
        return res.status(403).json({ error: 'Not visible until the match has locked' });
      }

      const rows = await db
        .select({
          userId: liveCompetitionMembers.userId,
          username: users.username,
          imageUrl: users.imageUrl,
          iconColor: users.iconColor,
          homeScore: livePredictions.homeScore,
          awayScore: livePredictions.awayScore,
          points: livePredictions.points,
          correctOutcomePoints: livePredictions.correctOutcomePoints,
          correctGoalDifferencePoints: livePredictions.correctGoalDifferencePoints,
          exactScorePoints: livePredictions.exactScorePoints,
        })
        .from(liveCompetitionMembers)
        .innerJoin(users, eq(liveCompetitionMembers.userId, users.id))
        .leftJoin(
          livePredictions,
          and(
            eq(livePredictions.liveCompetitionId, liveCompetitionMembers.liveCompetitionId),
            eq(livePredictions.userId, liveCompetitionMembers.userId),
            eq(livePredictions.liveFixtureId, fixture.id),
          ),
        )
        .where(
          and(
            eq(liveCompetitionMembers.liveCompetitionId, id),
            eq(users.isLeaderboardUser, false),
          ),
        )
        .orderBy(asc(users.username));

      // Best first, then alphabetical; whoever did not predict goes to the bottom. Points
      // are null while a locked match is still being played, which ranks everyone level
      // and leaves the alphabetical order to decide.
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
                },
        })),
      );
    } catch (err) {
      return fail(res, err);
    }
  },
);

// ── Bonus questions ───────────────────────────────────────────────────────────
//
// Questions belong to the tournament (see routes/tournaments.ts); answers belong here.
//
// A live competition has no competition-wide deadline, so a question closes at its own
// `lockAt` when an admin set one, and otherwise an hour before the first match of the
// tournament's starting stage — the same instant the table prediction locks. Points stay
// invisible, and unawarded, until the tournament is marked completed.

/** Kickoffs of the stage a season-long prediction is measured against. */
async function tablePredictionStageKickoffs(tournament: {
  id: string;
  format: string;
  startStageKey: string;
}): Promise<Array<Date | null>> {
  const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);
  const rows = await db
    .select({ kickoffAt: liveFixtures.kickoffAt })
    .from(liveFixtures)
    .where(
      stage
        ? and(
            eq(liveFixtures.liveTournamentId, tournament.id),
            eq(liveFixtures.stageKey, stage.key),
          )
        : // A format with no table stage still has a first predictable match to measure from.
          and(
            eq(liveFixtures.liveTournamentId, tournament.id),
            eq(liveFixtures.stageKey, tournament.startStageKey),
          ),
    );
  return rows.map(r => r.kickoffAt);
}

/** The questions, each with the deadline that actually applies to it. */
liveCompetitionsRouter.get('/competitions/:id/bonus-questions', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });
    if (!(await assertMember(competition.id, user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const questions = await db
      .select()
      .from(liveBonusQuestions)
      .where(eq(liveBonusQuestions.liveTournamentId, tournament.id))
      .orderBy(asc(liveBonusQuestions.createdAt));

    const kickoffs = await tablePredictionStageKickoffs(tournament);
    const now = new Date();

    return res.json(
      redactLiveBonusQuestions(questions, user.isAdmin, tournament.status === 'completed').map(
        q => {
          const lockedAt = bonusQuestionLockAt(q.lockAt, kickoffs);
          return {
            ...q,
            lockedAt: lockedAt ? lockedAt.toISOString() : null,
            isLocked: isBonusQuestionLocked(q.lockAt, kickoffs, now),
          };
        },
      ),
    );
  } catch (err) {
    return fail(res, err);
  }
});

/** The caller's own answers. Points are redacted until the tournament is completed. */
liveCompetitionsRouter.get('/competitions/:id/bonus-answers', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    if (!(await assertMember(req.params.id, user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const answers = await loadLiveBonusAnswers(req.params.id, user.id);
    return res.json(
      redactLiveBonusAnswerPoints(answers, user.isAdmin, await isTournamentCompletedFor(req.params.id)),
    );
  } catch (err) {
    return fail(res, err);
  }
});

async function isTournamentCompletedFor(competitionId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: liveTournaments.status })
    .from(liveCompetitions)
    .innerJoin(liveTournaments, eq(liveTournaments.id, liveCompetitions.liveTournamentId))
    .where(eq(liveCompetitions.id, competitionId));
  return row?.status === 'completed';
}

/**
 * Another member's answers.
 *
 * Open to the league as soon as they are given, on the same reasoning as the table
 * prediction above: these are season-long calls, and seeing them is most of the fun.
 * Points stay redacted until the tournament is completed, which is a separate rule and
 * applies to a member's own answers too.
 */
liveCompetitionsRouter.get(
  '/competitions/:id/bonus-answers/:userId',
  requireAuth,
  async (req, res) => {
    try {
      const viewer = res.locals.user;
      const { id, userId } = req.params;
      if (!(await assertMember(id, viewer))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }

      const [competition] = await db
        .select()
        .from(liveCompetitions)
        .where(eq(liveCompetitions.id, id));
      if (!competition) return res.status(404).json({ error: 'Not found' });

      const [tournament] = await db
        .select()
        .from(liveTournaments)
        .where(eq(liveTournaments.id, competition.liveTournamentId));
      if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

      const answers = await loadLiveBonusAnswers(id, userId);
      return res.json(
        redactLiveBonusAnswerPoints(answers, viewer.isAdmin, tournament.status === 'completed'),
      );
    } catch (err) {
      return fail(res, err);
    }
  },
);

/**
 * Clear the caller's bonus answers — every one whose question is still open.
 *
 * A question that has already locked keeps its answer: the live type closes each question
 * on its own schedule, and once one is closed its answer is as final as a played fixture's
 * prediction. Deleting those would be a way to walk back an answer after the fact.
 */
liveCompetitionsRouter.delete('/competitions/:id/bonus-answers', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;

    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });

    const [membership] = await db
      .select({ id: liveCompetitionMembers.id })
      .from(liveCompetitionMembers)
      .where(
        and(
          eq(liveCompetitionMembers.liveCompetitionId, competition.id),
          eq(liveCompetitionMembers.userId, user.id),
        ),
      );
    if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const questions = await db
      .select({ id: liveBonusQuestions.id, lockAt: liveBonusQuestions.lockAt })
      .from(liveBonusQuestions)
      .where(eq(liveBonusQuestions.liveTournamentId, tournament.id));

    const kickoffs = await tablePredictionStageKickoffs(tournament);
    const openQuestionIds = questions
      .filter(q => !isBonusQuestionLocked(q.lockAt, kickoffs))
      .map(q => q.id);
    if (openQuestionIds.length === 0) return res.json({ deleted: 0 });

    const deleted = await db
      .delete(liveBonusAnswers)
      .where(
        and(
          eq(liveBonusAnswers.liveCompetitionId, competition.id),
          eq(liveBonusAnswers.userId, user.id),
          inArray(liveBonusAnswers.questionId, openQuestionIds),
        ),
      )
      .returning({ id: liveBonusAnswers.id });

    return res.json({ deleted: deleted.length });
  } catch (err) {
    return fail(res, err);
  }
});

/** Upsert one answer. This is the only place the bonus deadline is enforced. */
liveCompetitionsRouter.put('/competitions/:id/bonus-answers', requireAuth, async (req, res) => {
  try {
    const parsed = SaveLiveBonusAnswerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const user = res.locals.user;
    if (user.isLeaderboardUser) {
      return res.status(403).json({ error: 'This account cannot make predictions' });
    }

    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });

    const [membership] = await db
      .select({ id: liveCompetitionMembers.id })
      .from(liveCompetitionMembers)
      .where(
        and(
          eq(liveCompetitionMembers.liveCompetitionId, competition.id),
          eq(liveCompetitionMembers.userId, user.id),
        ),
      );
    if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const [question] = await db
      .select()
      .from(liveBonusQuestions)
      .where(
        and(
          eq(liveBonusQuestions.id, parsed.data.questionId),
          eq(liveBonusQuestions.liveTournamentId, tournament.id),
        ),
      );
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const kickoffs = await tablePredictionStageKickoffs(tournament);
    if (isBonusQuestionLocked(question.lockAt, kickoffs)) {
      const lockedAt = bonusQuestionLockAt(question.lockAt, kickoffs);
      return res.status(400).json({
        error: 'This bonus question is closed',
        lockedAt: lockedAt ? lockedAt.toISOString() : null,
      });
    }

    // A team question with no list of its own is answered from the tournament's teams, so
    // the check needs them; every other kind resolves its options without a query.
    const teamNames =
      question.answerType === 'team' && !question.options?.length
        ? (
            await db
              .select({ name: liveTeams.name })
              .from(liveTeams)
              .where(eq(liveTeams.liveTournamentId, tournament.id))
          ).map(t => t.name)
        : [];

    const checked = checkLiveBonusAnswer(question, parsed.data.answer, teamNames);
    if (!checked.ok) {
      return res.status(400).json({
        error: 'That answer is not allowed for this question',
        reason: checked.reason,
        minValue: question.minValue,
        maxValue: question.maxValue,
      });
    }

    const now = new Date();
    const [saved] = await db
      .insert(liveBonusAnswers)
      .values({
        id: generateId(15),
        questionId: question.id,
        liveCompetitionId: competition.id,
        userId: user.id,
        answer: checked.value,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          liveBonusAnswers.questionId,
          liveBonusAnswers.liveCompetitionId,
          liveBonusAnswers.userId,
        ],
        set: { answer: checked.value, updatedAt: now },
      })
      .returning();

    // Nothing to score: points wait for the tournament to be marked completed.
    return res.json(redactLiveBonusAnswerPoints([saved], user.isAdmin, tournament.status === 'completed')[0]);
  } catch (err) {
    return fail(res, err);
  }
});
