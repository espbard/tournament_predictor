import { Router } from 'express';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  CreateLiveCompetitionSchema,
  JoinLiveCompetitionSchema,
  ListLiveFixturesQuerySchema,
  SaveLiveBonusAnswerSchema,
  SaveLivePredictionSchema,
  SaveLiveScorerPredictionSchema,
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
  seasonPredictionLock,
  tablePredictionLockAt,
  tablePredictionStage,
  withLiveScoringDefaults,
} from '@tournament-predictor/shared';
import type {
  CompetitionInvite,
  LeaderboardProgressionResponse,
} from '@tournament-predictor/shared';
import { db } from '../../db/client';
import {
  liveBonusAnswers,
  liveBonusQuestions,
  liveCompetitionMembers,
  liveCompetitions,
  liveFixtures,
  livePlayers,
  livePredictions,
  liveScorerPredictions,
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
import { buildLiveProgression, type LiveProgressionLang } from '../progression';
import { rankLiveScorers } from '../scorerScoring';
import { buildLiveUserStats, type LiveStatsLang } from '../userStats';
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

    // The tournament's status and its first kickoff ride along, so the competition list
    // can sort finished leagues last and say whether a league has started without
    // fetching a tournament and its fixtures per row.
    const base = {
      competition: liveCompetitions,
      tournamentStatus: liveTournaments.status,
      liveTournamentId: liveCompetitions.liveTournamentId,
    };

    const rows = user.isAdmin
      ? await db
          .select(base)
          .from(liveCompetitions)
          .leftJoin(liveTournaments, eq(liveCompetitions.liveTournamentId, liveTournaments.id))
          .orderBy(asc(liveCompetitions.createdAt))
      : await db
          .select(base)
          .from(liveCompetitionMembers)
          .innerJoin(
            liveCompetitions,
            eq(liveCompetitionMembers.liveCompetitionId, liveCompetitions.id),
          )
          .leftJoin(liveTournaments, eq(liveCompetitions.liveTournamentId, liveTournaments.id))
          .where(eq(liveCompetitionMembers.userId, user.id));

    const firstKickoffs = await firstKickoffByTournament([
      ...new Set(rows.map(r => r.liveTournamentId)),
    ]);

    return res.json(
      rows.map(r => ({
        ...r.competition,
        tournamentStatus: r.tournamentStatus,
        firstKickoffAt: firstKickoffs.get(r.liveTournamentId) ?? null,
      })),
    );
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * When each tournament's first predictable match kicks off.
 *
 * The starting stage only: everything below it is ingested but never predicted on, so a
 * summer qualifier must not make a league look under way in August. One query for the
 * whole list rather than one per competition.
 */
async function firstKickoffByTournament(
  tournamentIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (tournamentIds.length === 0) return out;

  const rows = await db
    .select({
      liveTournamentId: liveFixtures.liveTournamentId,
      firstKickoffAt: sql<string | null>`min(${liveFixtures.kickoffAt})`,
    })
    .from(liveFixtures)
    .innerJoin(
      liveTournaments,
      and(
        eq(liveTournaments.id, liveFixtures.liveTournamentId),
        eq(liveFixtures.stageKey, liveTournaments.startStageKey),
      ),
    )
    .where(inArray(liveFixtures.liveTournamentId, tournamentIds))
    .groupBy(liveFixtures.liveTournamentId);

  for (const row of rows) {
    out.set(
      row.liveTournamentId,
      row.firstKickoffAt ? new Date(row.firstKickoffAt).toISOString() : null,
    );
  }
  return out;
}

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
        multiplierBonusPoints: liveCompetitionMembers.multiplierBonusPoints,
        tablePoints: liveCompetitionMembers.tablePoints,
        scorerPoints: liveCompetitionMembers.scorerPoints,
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
            multiplierBonusPoints: row.multiplierBonusPoints,
            tablePoints: row.tablePoints,
            scorerPoints: row.scorerPoints,
            bonusPoints: row.bonusPoints,
          },
        };
      }),
    );
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Everything the points progression is made of, for one competition.
 *
 * Two routes want it: the progression endpoint returns it as the chart's payload, and the
 * user-stats deck's leader card walks the same milestones to find who has been top and
 * for how long. Loading it once, here, is what keeps the card, the chart and the
 * leaderboard telling the same story about who is winning.
 */
async function loadLiveProgression(
  competitionId: string,
  liveTournamentId: string,
  lang: LiveProgressionLang,
): Promise<LeaderboardProgressionResponse> {
  const [members, fixtures, teamRows, predictions, tablePoints, scorerPoints, bonusPoints, selections] =
    await Promise.all([
      db
        .select({
          userId: liveCompetitionMembers.userId,
          username: users.username,
          imageUrl: users.imageUrl,
          iconColor: users.iconColor,
        })
        .from(liveCompetitionMembers)
        .innerJoin(users, eq(liveCompetitionMembers.userId, users.id))
        .where(eq(liveCompetitionMembers.liveCompetitionId, competitionId))
        .orderBy(asc(users.username)),
      db
        .select({
          id: liveFixtures.id,
          kickoffAt: liveFixtures.kickoffAt,
          status: liveFixtures.status,
          stageKey: liveFixtures.stageKey,
          matchday: liveFixtures.matchday,
          homeTeamId: liveFixtures.homeTeamId,
          awayTeamId: liveFixtures.awayTeamId,
        })
        .from(liveFixtures)
        // Every fixture, not just the finished ones: a scored fixture the provider has
        // since moved back to postponed still holds points on the leaderboard, and
        // buildLiveProgression is the one place that rule lives.
        .where(eq(liveFixtures.liveTournamentId, liveTournamentId)),
      db
        .select({
          id: liveTeams.id,
          name: liveTeams.name,
          shortName: liveTeams.shortName,
          tla: liveTeams.tla,
        })
        .from(liveTeams)
        .where(eq(liveTeams.liveTournamentId, liveTournamentId)),
      db
        .select({
          userId: livePredictions.userId,
          liveFixtureId: livePredictions.liveFixtureId,
          points: livePredictions.points,
        })
        .from(livePredictions)
        .where(
          and(
            eq(livePredictions.liveCompetitionId, competitionId),
            isNotNull(livePredictions.points),
          ),
        ),
      db
        .select({ userId: liveTablePredictions.userId, points: liveTablePredictions.points })
        .from(liveTablePredictions)
        .where(eq(liveTablePredictions.liveCompetitionId, competitionId)),
      db
        .select({ userId: liveScorerPredictions.userId, points: liveScorerPredictions.points })
        .from(liveScorerPredictions)
        .where(eq(liveScorerPredictions.liveCompetitionId, competitionId)),
      db
        .select({ userId: liveBonusAnswers.userId, points: liveBonusAnswers.points })
        .from(liveBonusAnswers)
        .where(eq(liveBonusAnswers.liveCompetitionId, competitionId)),
      loadSelectionIndex(liveTournamentId),
    ]);

  return buildLiveProgression(
    {
      members,
      teams: teamRows,
      fixtures: fixtures.map(f => ({ ...f, isSelected: isLiveFixtureSelected(f, selections) })),
      predictions,
      tablePoints,
      scorerPoints,
      bonusPoints,
    },
    lang,
  );
}

/**
 * The points progression — every member's running total after each played fixture.
 *
 * Reads the stored per-prediction points rather than rescoring, so the end of the chart
 * always matches the leaderboard above it. The milestone rules live in
 * server/src/live/progression.ts; this route is only the queries that feed them.
 */
liveCompetitionsRouter.get(
  '/competitions/:id/leaderboard-progression',
  requireAuth,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!(await assertMember(id, res.locals.user))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }

      const [competition] = await db
        .select({ id: liveCompetitions.id, liveTournamentId: liveCompetitions.liveTournamentId })
        .from(liveCompetitions)
        .where(eq(liveCompetitions.id, id));
      if (!competition) return res.status(404).json({ error: 'Not found' });

      // Only the three season-long milestones are worded, so the language costs nothing
      // more than picking a label set — same convention as the user-stats route.
      const lang: LiveProgressionLang =
        req.query.lang === 'no' ? 'no' : req.query.lang === 'de' ? 'de' : 'en';

      return res.json(await loadLiveProgression(id, competition.liveTournamentId, lang));
    } catch (err) {
      return fail(res, err);
    }
  },
);

/**
 * User statistics — the same card deck the manual competition type has, built from live
 * data.
 *
 * Test accounts and admins only while the deck is shallow.
 */
liveCompetitionsRouter.get('/competitions/:id/user-stats', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    if (!user.isAdmin && !user.isTestAccount) {
      return res.status(403).json({ error: 'Not available' });
    }
    if (!(await assertMember(req.params.id, user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }
    const lang: LiveStatsLang =
      req.query.lang === 'no' ? 'no' : req.query.lang === 'de' ? 'de' : 'en';

    const [competition] = await db
      .select()
      .from(liveCompetitions)
      .where(eq(liveCompetitions.id, req.params.id));
    if (!competition) return res.status(404).json({ error: 'Not found' });

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    // A format with no table stage can still have a top-scorer ranking, so this narrows
    // the table half rather than ending the whole request.
    const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);

    const [tablePredictions, teams, scorerPredictions, players, scoredPredictions, progression] =
      await Promise.all([
        stage
          ? db
              .select({
                userId: liveTablePredictions.userId,
                orderedTeamIds: liveTablePredictions.orderedTeamIds,
              })
              .from(liveTablePredictions)
              // Read through the membership table rather than straight off the prediction
              // table: leaving a competition removes the membership row and leaves the
              // prediction behind, and someone who has left should not still get a vote.
              .innerJoin(
                liveCompetitionMembers,
                and(
                  eq(
                    liveCompetitionMembers.liveCompetitionId,
                    liveTablePredictions.liveCompetitionId,
                  ),
                  eq(liveCompetitionMembers.userId, liveTablePredictions.userId),
                ),
              )
              .where(
                and(
                  eq(liveTablePredictions.liveCompetitionId, competition.id),
                  eq(liveTablePredictions.stageKey, stage.key),
                ),
              )
          : [],
        db
          .select({ id: liveTeams.id, name: liveTeams.name, crestUrl: liveTeams.crestUrl })
          .from(liveTeams)
          .where(eq(liveTeams.liveTournamentId, tournament.id)),
        db
          .select({
            userId: liveScorerPredictions.userId,
            orderedPlayerIds: liveScorerPredictions.orderedPlayerIds,
          })
          .from(liveScorerPredictions)
          // Same membership join, for the same reason.
          .innerJoin(
            liveCompetitionMembers,
            and(
              eq(liveCompetitionMembers.liveCompetitionId, liveScorerPredictions.liveCompetitionId),
              eq(liveCompetitionMembers.userId, liveScorerPredictions.userId),
            ),
          )
          .where(eq(liveScorerPredictions.liveCompetitionId, competition.id)),
        // Every player, not just the shortlist: a ranking saved before the admin deselected
        // someone still holds that id, and the card should be able to name them.
        db
          .select({ id: livePlayers.id, name: livePlayers.name, imageUrl: livePlayers.imageUrl })
          .from(livePlayers)
          .where(eq(livePlayers.liveTournamentId, tournament.id)),
        // Every prediction that has been scored, with the result it was scored against.
        // `points IS NOT NULL` is the same "counts in the game" test the leaderboard and the
        // progression chart use — it is what the scoring trigger writes, so a fixture the
        // admin left out of its gameweek is already excluded, while one that scored and was
        // later moved back to postponed still counts, exactly as it does on the leaderboard.
        db
          .select({
            userId: livePredictions.userId,
            username: users.username,
            imageUrl: users.imageUrl,
            iconColor: users.iconColor,
            fixtureId: livePredictions.liveFixtureId,
            homeTeamId: liveFixtures.homeTeamId,
            awayTeamId: liveFixtures.awayTeamId,
            predictedHome: livePredictions.homeScore,
            predictedAway: livePredictions.awayScore,
            actualHome: liveFixtures.normalTimeHome,
            actualAway: liveFixtures.normalTimeAway,
            points: livePredictions.points,
          })
          .from(livePredictions)
          .innerJoin(liveFixtures, eq(liveFixtures.id, livePredictions.liveFixtureId))
          .innerJoin(users, eq(users.id, livePredictions.userId))
          // The same membership join the two rankings above use, for the same reason.
          .innerJoin(
            liveCompetitionMembers,
            and(
              eq(liveCompetitionMembers.liveCompetitionId, livePredictions.liveCompetitionId),
              eq(liveCompetitionMembers.userId, livePredictions.userId),
            ),
          )
          .where(
            and(
              eq(livePredictions.liveCompetitionId, competition.id),
              isNotNull(livePredictions.points),
              isNotNull(liveFixtures.normalTimeHome),
              isNotNull(liveFixtures.normalTimeAway),
            ),
          ),
        // The leader card walks the same milestones the chart is drawn from, so the card
        // and the leaderboard can never disagree about who is top.
        loadLiveProgression(competition.id, tournament.id, lang),
      ]);

    return res.json(
      buildLiveUserStats(
        {
          tablePredictions,
          teams,
          scorerPredictions,
          players,
          // The three isNotNull filters above are what make these assertions safe:
          // Drizzle types a nullable column as nullable whatever the WHERE clause says.
          scoredPredictions: scoredPredictions.map(p => ({
            ...p,
            actualHome: p.actualHome!,
            actualAway: p.actualAway!,
            points: p.points!,
          })),
          progression,
          scoringConfig: withLiveScoringDefaults(competition.scoringConfig),
          // Already on the row this route loaded, so the nationality card costs no query.
          scorerNationalities: tournament.scorerNationalities ?? null,
        },
        lang,
      ),
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
                multiplierBonusPoints: prediction.multiplierBonusPoints,
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
//
// One order for the whole stage, closing an hour before its first match — with one
// exception that runs through every route below. The deadline only closes a table that
// exists: a member who never submitted one can still enter, whenever they turn up, and
// that entry is final the moment it is saved. Locking them out instead would leave
// somebody who joined late stuck on the first-run gate of a competition they cannot play.

/**
 * Everything the table-prediction tab needs: the teams to order, the caller's saved
 * order, the deadline as it applies to them, and — once the stage has been played out —
 * how it scored.
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

    // Locked for this member only if they have a table to lock. Without one the deadline
    // has nothing to close and they may still enter — once.
    const kickoffs = stageFixtures.map(f => f.kickoffAt);
    const lock = seasonPredictionLock(kickoffs, !!prediction);

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
      lockedAt: lock.lockedAt ? lock.lockedAt.toISOString() : null,
      isLocked: lock.isLocked,
      // The deadline is behind us and this member never entered a table: they get one
      // submission, and the UI says so rather than showing a deadline in the past.
      isLateEntry: lock.isLateEntry,
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

    // Past the deadline this may still be somebody's first table — but only their first.
    // The write below is what settles that, atomically.
    const kickoffs = stageFixtures.map(f => f.kickoffAt);
    const deadlinePassed = isTablePredictionLocked(kickoffs);

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
    const target = [
      liveTablePredictions.liveCompetitionId,
      liveTablePredictions.userId,
      liveTablePredictions.stageKey,
    ];
    const values = {
      id: generateId(15),
      liveCompetitionId: competition.id,
      userId: user.id,
      stageKey: stage.key,
      orderedTeamIds: parsed.data.orderedTeamIds,
      createdAt: now,
      updatedAt: now,
    };

    // Before the deadline a save overwrites the previous one, as it always has. After it,
    // the insert may only create: `onConflictDoNothing` returns no row when a table is
    // already there, which is both the "you have had your one shot" answer and the thing
    // that stops two racing saves from both landing.
    const [saved] = deadlinePassed
      ? await db.insert(liveTablePredictions).values(values).onConflictDoNothing({ target }).returning()
      : await db
          .insert(liveTablePredictions)
          .values(values)
          .onConflictDoUpdate({
            target,
            set: { orderedTeamIds: parsed.data.orderedTeamIds, updatedAt: now },
          })
          .returning();

    if (!saved) {
      const lockAt = tablePredictionLockAt(kickoffs);
      return res.status(400).json({
        error: 'Table predictions for this competition are closed',
        lockedAt: lockAt ? lockAt.toISOString() : null,
      });
    }

    return res.json(saved);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Delete the caller's table prediction, putting them back in front of the first-run gate.
 *
 * Only while the table is still open. Once the deadline passes the prediction is what the
 * season is scored against, so there is nothing to withdraw. The deadline is the whole
 * test here, deliberately: a late entrant's one submission must not become editable by
 * withdrawing it and entering again. Nothing needs recomputing either — table points are
 * only awarded once the stage finishes, long after this deadline, so the member's stored
 * total is still zero.
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
// ── Top-scorer ranking ────────────────────────────────────────────────────────
//
// The tournament's second ranking prediction. Same shape as the table above — order a
// list, score the positions you got exactly right — but over the shortlist of players an
// admin curated, and settled on goals rather than results.
//
// It closes with the table prediction, an hour before the first match of the starting
// stage, because a ranking of who will end up top scorer means nothing once the goals
// have started going in — and, like the table, it stays open past that deadline for a
// member who never submitted one, for their single entry.

/** Everything the ranking tab needs: the shortlist, the saved order, the lock, the result. */
liveCompetitionsRouter.get('/competitions/:id/scorer-prediction', requireAuth, async (req, res) => {
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

    const players = await db
      .select()
      .from(livePlayers)
      .where(
        and(eq(livePlayers.liveTournamentId, tournament.id), eq(livePlayers.isSelected, true)),
      );

    // No shortlist, no ranking. An admin who has not picked anybody has not opened this
    // part of the game, and an empty ranking must never gate a member out of the league.
    if (players.length < 2) return res.json({ available: false });

    const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);
    const stageFixtures = stage
      ? await db
          .select({ kickoffAt: liveFixtures.kickoffAt })
          .from(liveFixtures)
          .where(
            and(
              eq(liveFixtures.liveTournamentId, tournament.id),
              eq(liveFixtures.stageKey, stage.key),
            ),
          )
      : [];

    const [prediction] = await db
      .select()
      .from(liveScorerPredictions)
      .where(
        and(
          eq(liveScorerPredictions.liveCompetitionId, competition.id),
          eq(liveScorerPredictions.userId, user.id),
        ),
      );

    // As with the table: a member who never ranked anybody has nothing for the deadline to
    // close, so it stays open for them until they do.
    const kickoffs = stageFixtures.map(f => f.kickoffAt);
    const lock = seasonPredictionLock(kickoffs, !!prediction);

    // The ranking as it stands today, by the same rule the final one is settled by. It
    // seeds a new prediction and, later, shows how the real thing is going.
    const currentOrder = rankLiveScorers(players).map(p => p.id);

    // The clubs, for their crests: a player row shows who they play for, and a player
    // carries only a team id.
    const teams = await db
      .select()
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id));

    return res.json({
      available: true,
      players,
      teams,
      prediction: prediction ?? null,
      lockedAt: lock.lockedAt ? lock.lockedAt.toISOString() : null,
      isLocked: lock.isLocked,
      // Past the deadline with no ranking of their own: one submission left.
      isLateEntry: lock.isLateEntry,
      currentOrder,
      // Points are only awarded once the tournament is completed, which is what the tab
      // tells the user while the season runs.
      isTournamentCompleted: tournament.status === 'completed',
      scoringConfig: withLiveScoringDefaults(competition.scoringConfig),
    });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Save the whole ranking.
 *
 * Validated as a complete permutation of the shortlist, exactly as the table is: a
 * partial or duplicated ranking would let somebody quietly stack the positions they are
 * confident about.
 */
liveCompetitionsRouter.put('/competitions/:id/scorer-prediction', requireAuth, async (req, res) => {
  try {
    const parsed = SaveLiveScorerPredictionSchema.safeParse(req.body);
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
    if (!(await assertMember(competition.id, user))) {
      return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, competition.liveTournamentId));
    if (!tournament) return res.status(404).json({ error: 'Live tournament not found' });

    const stage = tablePredictionStage(getLiveFormat(tournament.format), tournament.startStageKey);
    const kickoffs = stage
      ? (
          await db
            .select({ kickoffAt: liveFixtures.kickoffAt })
            .from(liveFixtures)
            .where(
              and(
                eq(liveFixtures.liveTournamentId, tournament.id),
                eq(liveFixtures.stageKey, stage.key),
              ),
            )
        ).map(f => f.kickoffAt)
      : [];

    // Past the deadline this may still be a first ranking, but never a second: the write
    // below settles that atomically, exactly as the table prediction does.
    const deadlinePassed = isTablePredictionLocked(kickoffs);

    const players = await db
      .select({ id: livePlayers.id })
      .from(livePlayers)
      .where(
        and(eq(livePlayers.liveTournamentId, tournament.id), eq(livePlayers.isSelected, true)),
      );
    if (players.length < 2) {
      return res.status(400).json({ error: 'This tournament has no top-scorer shortlist' });
    }

    // Shared with the table prediction: the same "every id exactly once" rule.
    const validation = validateTableOrder(
      parsed.data.orderedPlayerIds,
      players.map(p => p.id),
    );
    if (!validation.ok) {
      return res.status(400).json({ error: 'Invalid ranking', reason: validation.reason });
    }

    const now = new Date();
    const target = [liveScorerPredictions.liveCompetitionId, liveScorerPredictions.userId];
    const values = {
      id: generateId(15),
      liveCompetitionId: competition.id,
      userId: user.id,
      orderedPlayerIds: parsed.data.orderedPlayerIds,
      createdAt: now,
      updatedAt: now,
    };

    const [saved] = deadlinePassed
      ? await db.insert(liveScorerPredictions).values(values).onConflictDoNothing({ target }).returning()
      : await db
          .insert(liveScorerPredictions)
          .values(values)
          .onConflictDoUpdate({
            target,
            set: { orderedPlayerIds: parsed.data.orderedPlayerIds, updatedAt: now },
          })
          .returning();

    if (!saved) {
      const lockAt = tablePredictionLockAt(kickoffs);
      return res.status(400).json({
        error: 'The top-scorer ranking for this competition is closed',
        lockedAt: lockAt ? lockAt.toISOString() : null,
      });
    }

    return res.json(saved);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Another member's ranking.
 *
 * Only their order: the shortlist, the deadline and the scoring all belong to the
 * competition and the caller already has them from their own view.
 *
 * Deliberately not gated on the ranking having locked, unlike a fixture prediction: these
 * are season-long calls the league is meant to argue about. A member who has not ranked
 * yet can therefore see one before submitting theirs — the same trade the table prediction
 * already makes, and the price of letting a late joiner in at all.
 */
liveCompetitionsRouter.get(
  '/competitions/:id/scorer-prediction/:userId',
  requireAuth,
  async (req, res) => {
    try {
      const { id, userId } = req.params;
      if (!(await assertMember(id, res.locals.user))) {
        return res.status(403).json({ error: 'Not a member of this competition' });
      }

      const [prediction] = await db
        .select()
        .from(liveScorerPredictions)
        .where(
          and(
            eq(liveScorerPredictions.liveCompetitionId, id),
            eq(liveScorerPredictions.userId, userId),
          ),
        );
      return res.json(prediction ?? null);
    } catch (err) {
      return fail(res, err);
    }
  },
);

/**
 * Delete the caller's ranking, putting them back in front of the first-run gate.
 *
 * Only until the deadline, for the same reason the table prediction is: after it, the
 * ranking is what the tournament is scored against, and letting a late entrant withdraw
 * would turn their one submission into an editable one. Nothing needs recomputing —
 * ranking points are not awarded until the tournament completes, long after this deadline.
 */
liveCompetitionsRouter.delete(
  '/competitions/:id/scorer-prediction',
  requireAuth,
  async (req, res) => {
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
      const kickoffs = stage
        ? (
            await db
              .select({ kickoffAt: liveFixtures.kickoffAt })
              .from(liveFixtures)
              .where(
                and(
                  eq(liveFixtures.liveTournamentId, tournament.id),
                  eq(liveFixtures.stageKey, stage.key),
                ),
              )
          ).map(f => f.kickoffAt)
        : [];
      if (isTablePredictionLocked(kickoffs)) {
        return res.status(400).json({ error: 'The top-scorer ranking for this competition is closed' });
      }

      await db
        .delete(liveScorerPredictions)
        .where(
          and(
            eq(liveScorerPredictions.liveCompetitionId, competition.id),
            eq(liveScorerPredictions.userId, user.id),
          ),
        );

      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  },
);

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
          multiplierBonusPoints: livePredictions.multiplierBonusPoints,
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
                  multiplierBonusPoints: row.multiplierBonusPoints ?? 0,
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
