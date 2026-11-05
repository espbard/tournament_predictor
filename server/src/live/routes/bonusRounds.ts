import { Router } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  CreateLiveBonusFixtureSchema,
  CreateLiveBonusRoundSchema,
  SaveLiveBonusRoundPredictionSchema,
  UpdateLiveBonusFixtureSchema,
  UpdateLiveBonusRoundSchema,
  bonusFixtureStatus,
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
} from '../../db/liveSchema';
import { users } from '../../db/schema';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { canViewLiveCompetition, isLiveMember } from '../../lib/competitionAccess';
import { notifyLiveCompetitions } from '../liveEvents';
import { scoreBonusFixture } from '../bonusRoundScoring';
import { recomputeLiveMemberTotals } from '../scoringTrigger';

// ── Bonus rounds API ──────────────────────────────────────────────────────────
//
// Extra rounds of match predictions inside one live competition. The matches are set up
// by hand — two team names, a kickoff, later the 90-minute result — the way the manual
// tournament type works. See shared/src/live/bonusRounds.ts for the model and
// server/src/live/bonusRoundScoring.ts for the scoring.
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
type FixtureRow = typeof liveBonusRoundFixtures.$inferSelect;
type PredictionRow = typeof liveBonusRoundPredictions.$inferSelect;

const iso = (d: Date) => d.toISOString();

/**
 * A hand-entered match in the shape of the ordinary fixture view, so the same cards draw
 * it. The teams are only names, so they get synthetic ids and no crest.
 */
function fixtureView(f: FixtureRow, prediction: PredictionRow | null, now: Date): LiveBonusRoundFixtureView {
  const status = bonusFixtureStatus(f);
  const lockAt = fixtureLockAt(f.kickoffAt);
  const team = (side: 'home' | 'away', name: string) => ({
    id: `${f.id}:${side}`,
    liveTournamentId: '',
    providerTeamId: '',
    name,
    shortName: null,
    tla: null,
    crestUrl: null,
    groupName: null,
    qualificationStatus: 'qualified' as const,
  });
  return {
    id: f.id,
    liveTournamentId: '',
    providerFixtureId: f.id,
    homeTeamId: `${f.id}:home`,
    awayTeamId: `${f.id}:away`,
    homeTeam: team('home', f.homeTeamName),
    awayTeam: team('away', f.awayTeamName),
    kickoffAt: iso(f.kickoffAt),
    kickoffConfirmed: true,
    status,
    stageKey: null,
    providerStage: null,
    groupName: null,
    matchday: null,
    tieKey: null,
    legNumber: null,
    multiplier: f.multiplier,
    normalTimeHome: f.homeScore,
    normalTimeAway: f.awayScore,
    halfTimeHome: null,
    halfTimeAway: null,
    extraTimeHome: null,
    extraTimeAway: null,
    penaltiesHome: null,
    penaltiesAway: null,
    finalHome: f.homeScore,
    finalAway: f.awayScore,
    winner: null,
    minute: null,
    providerLastUpdated: null,
    updatedAt: iso(f.updatedAt),
    label: f.label,
    prediction: prediction
      ? ({
          homeScore: prediction.homeScore,
          awayScore: prediction.awayScore,
          points: prediction.points,
          correctOutcomePoints: prediction.correctOutcomePoints,
          correctGoalDifferencePoints: prediction.correctGoalDifferencePoints,
          exactScorePoints: prediction.exactScorePoints,
          multiplierBonusPoints: prediction.multiplierBonusPoints,
        } as LiveBonusRoundFixtureView['prediction'])
      : null,
    lockedAt: lockAt ? iso(lockAt) : null,
    isLocked: isFixtureLocked({ kickoffAt: f.kickoffAt, status }, now),
    isPredictable: true,
    isSelected: true,
  };
}

/** Rounds with their matches and one member's predictions. */
async function buildRoundViews(rounds: RoundRow[], predictorId: string | null): Promise<LiveBonusRoundView[]> {
  if (rounds.length === 0) return [];

  const fixtures = await db
    .select()
    .from(liveBonusRoundFixtures)
    .where(
      inArray(
        liveBonusRoundFixtures.bonusRoundId,
        rounds.map(r => r.id),
      ),
    )
    .orderBy(asc(liveBonusRoundFixtures.kickoffAt), asc(liveBonusRoundFixtures.createdAt));

  const predictions =
    predictorId && fixtures.length
      ? await db
          .select()
          .from(liveBonusRoundPredictions)
          .where(
            and(
              eq(liveBonusRoundPredictions.userId, predictorId),
              inArray(
                liveBonusRoundPredictions.bonusFixtureId,
                fixtures.map(f => f.id),
              ),
            ),
          )
      : [];
  const predictionByFixture = new Map(predictions.map(p => [p.bonusFixtureId, p]));

  const now = new Date();
  return rounds.map(round => {
    const own = fixtures.filter(f => f.bonusRoundId === round.id);
    return {
      id: round.id,
      liveCompetitionId: round.liveCompetitionId,
      name: round.name,
      afterStageKey: round.afterStageKey,
      afterMatchday: round.afterMatchday,
      visibility: round.visibility as LiveBonusRoundVisibility,
      createdAt: iso(round.createdAt),
      updatedAt: iso(round.updatedAt),
      fixtures: own.map(f => fixtureView(f, predictionByFixture.get(f.id) ?? null, now)),
      firstKickoffAt: own.length > 0 ? iso(own[0].kickoffAt) : null,
    };
  });
}

async function loadRound(roundId: string): Promise<RoundRow | null> {
  const [round] = await db.select().from(liveBonusRounds).where(eq(liveBonusRounds.id, roundId));
  return round ?? null;
}

async function loadFixture(fixtureId: string): Promise<FixtureRow | null> {
  const [fixture] = await db
    .select()
    .from(liveBonusRoundFixtures)
    .where(eq(liveBonusRoundFixtures.id, fixtureId));
  return fixture ?? null;
}

/** Points moved (or their visibility did): rebuild totals and tell anyone watching. */
async function afterScoresMoved(competitionId: string): Promise<void> {
  await recomputeLiveMemberTotals([competitionId]);
  notifyLiveCompetitions([competitionId], 'leaderboard-updated');
  notifyLiveCompetitions([competitionId], 'fixtures-updated');
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

/**
 * Another member's bonus rounds, for their read-only predictions page: every round the
 * caller may see, with that member's predictions on the matches that have locked.
 */
liveBonusRoundsRouter.get('/competitions/:id/bonus-rounds/user/:userId', requireAuth, async (req, res) => {
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
        fixtures: round.fixtures.map(f => (seesEverything || f.isLocked ? f : { ...f, prediction: null })),
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

    notifyLiveCompetitions([competition.id], 'fixtures-updated');
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
    if ((update.afterStageKey !== undefined ? update.afterStageKey : current.afterStageKey) === null) {
      update.afterMatchday = null;
    }

    const [updated] = await db
      .update(liveBonusRounds)
      .set(update)
      .where(eq(liveBonusRounds.id, current.id))
      .returning();

    // Going public (or back) moves the round's points into (or out of) the totals.
    if (parsed.data.visibility !== undefined && parsed.data.visibility !== current.visibility) {
      await afterScoresMoved(current.liveCompetitionId);
    } else {
      notifyLiveCompetitions([current.liveCompetitionId], 'fixtures-updated');
    }

    const [view] = await buildRoundViews([updated], res.locals.user.id);
    return res.json(view);
  } catch (err) {
    return fail(res, err);
  }
});

/** Deletes the round, its matches and every prediction made on them. */
liveBonusRoundsRouter.delete('/bonus-rounds/:roundId', requireAdmin, async (req, res) => {
  try {
    const round = await loadRound(req.params.roundId);
    if (!round) return res.status(404).json({ error: 'Not found' });
    await db.delete(liveBonusRounds).where(eq(liveBonusRounds.id, round.id));
    await afterScoresMoved(round.liveCompetitionId);
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Admin: matches ────────────────────────────────────────────────────────────

liveBonusRoundsRouter.post('/bonus-rounds/:roundId/fixtures', requireAdmin, async (req, res) => {
  try {
    const parsed = CreateLiveBonusFixtureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const round = await loadRound(req.params.roundId);
    if (!round) return res.status(404).json({ error: 'Not found' });

    const now = new Date();
    const [created] = await db
      .insert(liveBonusRoundFixtures)
      .values({
        id: generateId(15),
        bonusRoundId: round.id,
        liveCompetitionId: round.liveCompetitionId,
        homeTeamName: parsed.data.homeTeamName,
        awayTeamName: parsed.data.awayTeamName,
        label: parsed.data.label || null,
        kickoffAt: new Date(parsed.data.kickoffAt),
        multiplier: parsed.data.multiplier,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    notifyLiveCompetitions([round.liveCompetitionId], 'fixtures-updated');
    return res.status(201).json(created);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Edit a match, or enter its result. Setting both scores finishes the match and scores
 * every prediction on it; clearing both puts it back to unplayed. A changed multiplier
 * rescores too.
 */
liveBonusRoundsRouter.patch('/bonus-fixtures/:fixtureId', requireAdmin, async (req, res) => {
  try {
    const parsed = UpdateLiveBonusFixtureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const current = await loadFixture(req.params.fixtureId);
    if (!current) return res.status(404).json({ error: 'Not found' });

    const d = parsed.data;
    const update: Partial<FixtureRow> = { updatedAt: new Date() };
    if (d.homeTeamName !== undefined) update.homeTeamName = d.homeTeamName;
    if (d.awayTeamName !== undefined) update.awayTeamName = d.awayTeamName;
    if (d.label !== undefined) update.label = d.label || null;
    if (d.kickoffAt !== undefined) update.kickoffAt = new Date(d.kickoffAt);
    if (d.multiplier !== undefined) update.multiplier = d.multiplier;
    if (d.homeScore !== undefined) update.homeScore = d.homeScore;
    if (d.awayScore !== undefined) update.awayScore = d.awayScore;

    const [updated] = await db
      .update(liveBonusRoundFixtures)
      .set(update)
      .where(eq(liveBonusRoundFixtures.id, current.id))
      .returning();

    const pointsMayMove =
      d.homeScore !== undefined || d.awayScore !== undefined || d.multiplier !== undefined;
    if (pointsMayMove) {
      await scoreBonusFixture(current.id);
      await afterScoresMoved(current.liveCompetitionId);
    } else {
      notifyLiveCompetitions([current.liveCompetitionId], 'fixtures-updated');
    }
    return res.json(updated);
  } catch (err) {
    return fail(res, err);
  }
});

/** Deletes the match and every prediction made on it. */
liveBonusRoundsRouter.delete('/bonus-fixtures/:fixtureId', requireAdmin, async (req, res) => {
  try {
    const fixture = await loadFixture(req.params.fixtureId);
    if (!fixture) return res.status(404).json({ error: 'Not found' });
    await db.delete(liveBonusRoundFixtures).where(eq(liveBonusRoundFixtures.id, fixture.id));
    await afterScoresMoved(fixture.liveCompetitionId);
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Predictions ───────────────────────────────────────────────────────────────

/** A match and its round, if the match belongs to this competition. */
async function fixtureInCompetition(competitionId: string, fixtureId: string) {
  const [row] = await db
    .select({ fixture: liveBonusRoundFixtures, round: liveBonusRounds })
    .from(liveBonusRoundFixtures)
    .innerJoin(liveBonusRounds, eq(liveBonusRounds.id, liveBonusRoundFixtures.bonusRoundId))
    .where(
      and(
        eq(liveBonusRoundFixtures.id, fixtureId),
        eq(liveBonusRoundFixtures.liveCompetitionId, competitionId),
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

    const found = await fixtureInCompetition(competitionId, parsed.data.fixtureId);
    if (!found || !canSeeLiveBonusRound(user, found.round)) {
      return res.status(404).json({ error: 'Fixture not found' });
    }
    const { fixture } = found;

    if (isFixtureLocked({ kickoffAt: fixture.kickoffAt, status: bonusFixtureStatus(fixture) })) {
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
        bonusFixtureId: fixture.id,
        liveCompetitionId: competitionId,
        userId: user.id,
        homeScore: parsed.data.homeScore,
        awayScore: parsed.data.awayScore,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [liveBonusRoundPredictions.bonusFixtureId, liveBonusRoundPredictions.userId],
        set: { homeScore: parsed.data.homeScore, awayScore: parsed.data.awayScore, updatedAt: now },
      })
      .returning();
    return res.json(saved);
  } catch (err) {
    return fail(res, err);
  }
});

/** Every member's prediction for one bonus-round match — the "what everyone predicted" list. */
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
      const found = await fixtureInCompetition(id, fixtureId);
      if (!found || !canSeeLiveBonusRound(user, found.round)) {
        return res.status(404).json({ error: 'Fixture not found' });
      }
      const { fixture } = found;
      if (
        !canPreviewPredictions(user) &&
        !isFixtureLocked({ kickoffAt: fixture.kickoffAt, status: bonusFixtureStatus(fixture) })
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
            eq(liveBonusRoundPredictions.userId, liveCompetitionMembers.userId),
            eq(liveBonusRoundPredictions.bonusFixtureId, fixture.id),
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
