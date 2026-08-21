import { Router } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  CreateLiveCompetitionSchema,
  DEFAULT_LIVE_SCORING_CONFIG,
  JoinLiveCompetitionSchema,
  ListLiveFixturesQuerySchema,
  SaveLivePredictionSchema,
  UpdateLiveCompetitionSchema,
  fixtureLockAt,
  getLiveFormat,
  isFixtureLocked,
  isStageAtOrAfter,
} from '@tournament-predictor/shared';
import { db } from '../../db/client';
import {
  liveCompetitionMembers,
  liveCompetitions,
  liveFixtures,
  livePredictions,
  liveTeams,
  liveTournaments,
} from '../../db/liveSchema';
import { users } from '../../db/schema';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { subscribeLiveCompetition, unsubscribeLiveCompetition } from '../liveEvents';
import { recalculateLiveCompetition } from '../scoringTrigger';

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

    const user = res.locals.user;
    const [existing] = await db
      .select({ id: liveCompetitionMembers.id })
      .from(liveCompetitionMembers)
      .where(
        and(
          eq(liveCompetitionMembers.liveCompetitionId, competition.id),
          eq(liveCompetitionMembers.userId, user.id),
        ),
      );
    if (existing) return res.json(competition);

    await db.insert(liveCompetitionMembers).values({
      id: generateId(15),
      liveCompetitionId: competition.id,
      userId: user.id,
    });
    return res.status(201).json(competition);
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
        scoringConfig: parsed.data.scoringConfig ?? DEFAULT_LIVE_SCORING_CONFIG,
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
    if (parsed.data.scoringConfig !== undefined) update.scoringConfig = parsed.data.scoringConfig;
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
        };
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

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
