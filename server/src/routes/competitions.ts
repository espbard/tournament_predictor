import { Router } from 'express';
import { eq, and, inArray, or, ilike, desc } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client.js';
import { competitions, competitionMembers, users, tournaments, predictions, matches, teams, groups, bracketPredictions, bonusQuestions, bonusAnswers, players } from '../db/schema.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { CreateCompetitionSchema, CreatePredictionSchema, SaveBracketPredictionsSchema, DEFAULT_SCORING_CONFIG, SaveBonusAnswerSchema, resolveFirstRoundSlots } from '@tournament-predictor/shared';
import type { UserStatCardData, ScoringConfig, KnockoutConfig, BracketPredictions } from '@tournament-predictor/shared';
import { recalculateAllScoresForTournament } from '../lib/scoringTrigger.js';
import { computeGroupStandings, calculateMatchPoints, getUserPredictedTeamForKnockoutSlot, type KnockoutMatchSlot } from '../lib/scoring.js';
import { subscribeLeaderboard, unsubscribeLeaderboard } from '../lib/leaderboardEvents.js';

const router = Router();

function generateInviteCode(): string {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

type Lang = 'en' | 'no';

function formatUserList(names: string[], lang: Lang): string {
  const bolded = names.map(n => `**${n}**`);
  const and = lang === 'no' ? 'og' : 'and';
  if (bolded.length === 1) return bolded[0];
  if (bolded.length === 2) return `${bolded[0]} ${and} ${bolded[1]}`;
  return `${bolded.slice(0, -1).join(', ')}, ${and} ${bolded[bolded.length - 1]}`;
}

function describeOutcome(
  homeTeamName: string,
  awayTeamName: string,
  homeScore: number,
  awayScore: number,
  lang: Lang
): string {
  if (lang === 'no') {
    if (homeScore > awayScore) return `at ${homeTeamName} slo ${awayTeamName}`;
    if (awayScore > homeScore) return `at ${awayTeamName} slo ${homeTeamName}`;
    return `uavgjort mellom ${homeTeamName} og ${awayTeamName}`;
  }
  if (homeScore > awayScore) return `${homeTeamName} to beat ${awayTeamName}`;
  if (awayScore > homeScore) return `${awayTeamName} to beat ${homeTeamName}`;
  return `${homeTeamName} to draw against ${awayTeamName}`;
}

router.get('/', requireAuth, async (_req, res) => {
  try {
    const user = res.locals.user;
    if (user.isAdmin) {
      const all = await db.select().from(competitions);
      return res.json(all);
    }
    const rows = await db
      .select({ competition: competitions })
      .from(competitionMembers)
      .innerJoin(competitions, eq(competitionMembers.competitionId, competitions.id))
      .where(eq(competitionMembers.userId, user.id));
    return res.json(rows.map(r => r.competition));
  } catch {
    res.status(500).json({ error: 'Failed to fetch competitions' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const result = CreateCompetitionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { tournamentId, name, imageUrl, predictionDeadline } = result.data;

    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    let inviteCode = generateInviteCode();
    for (let i = 0; i < 10; i++) {
      const [existing] = await db.select().from(competitions).where(eq(competitions.inviteCode, inviteCode));
      if (!existing) break;
      inviteCode = generateInviteCode();
    }

    const id = generateId(15);
    await db.insert(competitions).values({
      id,
      tournamentId,
      name,
      imageUrl: imageUrl ?? null,
      inviteCode,
      scoringConfig: DEFAULT_SCORING_CONFIG,
      predictionDeadline: predictionDeadline ? new Date(predictionDeadline) : null,
    });

    // Auto-add comparison users to competitions for "Fotball-VM 2026"
    if (tournament.name === 'Fotball-VM 2026') {
      const comparisonUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isComparisonUser, true));
      for (const cu of comparisonUsers) {
        await db.insert(competitionMembers).values({ competitionId: id, userId: cu.id });
      }
    }

    const [created] = await db.select().from(competitions).where(eq(competitions.id, id));
    res.status(201).json(created);
  } catch (err) {
    console.error('Create competition error:', err);
    res.status(500).json({ error: 'Failed to create competition' });
  }
});

// Must be defined before /:id to avoid route conflict
router.post('/join', requireAuth, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode || typeof inviteCode !== 'string') {
      return res.status(400).json({ error: 'Invite code is required' });
    }

    const [competition] = await db
      .select()
      .from(competitions)
      .where(eq(competitions.inviteCode, inviteCode.trim()));
    if (!competition) return res.status(404).json({ error: 'Invalid invite code' });

    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, competition.tournamentId));

    const userId: string = res.locals.user.id;

    // Read isLateAddition directly from DB to avoid stale session values
    const [dbUser] = await db
      .select({ isLateAddition: users.isLateAddition })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const isLateAdditionJoin = (dbUser?.isLateAddition ?? false) && tournament?.status === 'active';

    if (tournament && tournament.status === 'completed') {
      return res.status(403).json({ error: 'This competition is no longer open for new members' });
    }

    if (isLateAdditionJoin && !competition.allowLateAdditions) {
      return res.status(403).json({ error: 'This competition does not allow late additions' });
    }

    if (!isLateAdditionJoin && tournament && tournament.status !== 'upcoming') {
      return res.status(403).json({ error: 'This competition is no longer open for new members' });
    }

    if (!isLateAdditionJoin && competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
      return res.status(403).json({ error: 'The prediction deadline for this competition has passed' });
    }

    const [existing] = await db
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, competition.id), eq(competitionMembers.userId, userId)));
    if (existing) return res.status(409).json({ error: 'Already a member of this competition' });

    if (isLateAdditionJoin) {
      // Find last-place score among active users (those with predictions in the 5 most recent completed matches)
      const memberScores = await db
        .select({
          userId: competitionMembers.userId,
          exactScorePoints: competitionMembers.exactScorePoints,
          correctResultPoints: competitionMembers.correctResultPoints,
          correctTeamProgressesPoints: competitionMembers.correctTeamProgressesPoints,
          correctGroupPositionPoints: competitionMembers.correctGroupPositionPoints,
          correctTeamInKnockoutTiePoints: competitionMembers.correctTeamInKnockoutTiePoints,
          correctTeamInFinalPoints: competitionMembers.correctTeamInFinalPoints,
          correctWinnerPoints: competitionMembers.correctWinnerPoints,
          bonusQuestionPoints: competitionMembers.bonusQuestionPoints,
          lateAdditionPoints: competitionMembers.lateAdditionPoints,
          isLeaderboardUser: users.isLeaderboardUser,
          isComparisonUser: users.isComparisonUser,
        })
        .from(competitionMembers)
        .innerJoin(users, eq(competitionMembers.userId, users.id))
        .where(eq(competitionMembers.competitionId, competition.id));

      const recentCompletedMatches = await db
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.status, 'completed')))
        .orderBy(desc(matches.scheduledAt))
        .limit(5);

      let activeUserIds: Set<string> | null = null;
      if (recentCompletedMatches.length >= 5) {
        const recentMatchIds = recentCompletedMatches.map(m => m.id);
        const recentPredRows = await db
          .select({ userId: predictions.userId })
          .from(predictions)
          .where(and(eq(predictions.competitionId, competition.id), inArray(predictions.matchId, recentMatchIds)));
        activeUserIds = new Set(recentPredRows.map(p => p.userId));
      }

      const regularMembers = memberScores.filter(m => !m.isLeaderboardUser && !m.isComparisonUser);
      const candidateMembers = activeUserIds != null
        ? regularMembers.filter(m => activeUserIds!.has(m.userId))
        : regularMembers;
      const pool = candidateMembers.length > 0 ? candidateMembers : regularMembers;

      const totals = pool.map(m =>
        m.exactScorePoints + m.correctResultPoints + m.correctTeamProgressesPoints +
        m.correctGroupPositionPoints + m.correctTeamInKnockoutTiePoints +
        m.correctTeamInFinalPoints + m.correctWinnerPoints + m.bonusQuestionPoints +
        m.lateAdditionPoints,
      );
      const lastPlaceScore = totals.length > 0 ? Math.min(...totals) : 0;
      const windowEndsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const joinTime = new Date();

      await db.insert(competitionMembers).values({
        competitionId: competition.id,
        userId,
        lateAdditionPoints: lastPlaceScore,
        lateAdditionWindowEndsAt: windowEndsAt,
      });

      // Create replacement predictions for completed group matches before join time,
      // copying from the lowest-ranked member who predicted each specific match.
      const completedGroupMatches = await db
        .select({ id: matches.id, scheduledAt: matches.scheduledAt })
        .from(matches)
        .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed')));

      // All completed group matches happened before the user joined; include those
      // without a scheduledAt too since they're provably already played.
      const matchesBefore = completedGroupMatches.filter(
        m => m.scheduledAt == null || m.scheduledAt < joinTime,
      );

      if (matchesBefore.length > 0) {
        const matchIdsBefore = matchesBefore.map(m => m.id);

        const existingPreds = await db
          .select({ userId: predictions.userId, matchId: predictions.matchId, homeScore: predictions.homeScore, awayScore: predictions.awayScore })
          .from(predictions)
          .where(and(eq(predictions.competitionId, competition.id), inArray(predictions.matchId, matchIdsBefore), eq(predictions.isReplacement, false)));

        // Score map: userId → total score (regular non-leaderboard non-comparison members only).
        // Comparison/leaderboard users are not included here; if a match was only predicted by
        // those users their predictions still serve as fallback (see lowestScore init below).
        const scoreByUser = new Map<string, number>();
        for (const m of memberScores) {
          if (!m.isLeaderboardUser && !m.isComparisonUser) {
            scoreByUser.set(m.userId,
              m.exactScorePoints + m.correctResultPoints + m.correctTeamProgressesPoints +
              m.correctGroupPositionPoints + m.correctTeamInKnockoutTiePoints +
              m.correctTeamInFinalPoints + m.correctWinnerPoints + m.bonusQuestionPoints +
              m.lateAdditionPoints,
            );
          }
        }

        const predsByMatch = new Map<string, typeof existingPreds>();
        for (const p of existingPreds) {
          if (!predsByMatch.has(p.matchId)) predsByMatch.set(p.matchId, []);
          predsByMatch.get(p.matchId)!.push(p);
        }

        const replacements: Array<typeof predictions.$inferInsert> = [];
        for (const match of matchesBefore) {
          const matchPreds = predsByMatch.get(match.id) ?? [];
          if (matchPreds.length === 0) continue;

          // Pick the predictor with the lowest competition score among regular members.
          // Initialize lowestScore as null so the first prediction is always accepted as a
          // baseline — this handles the case where all predictors are comparison/leaderboard
          // users (scoreByUser returns Infinity for them, and Infinity < Infinity is false).
          let lowestScore: number | null = null;
          let lowestPred: typeof matchPreds[number] | null = null;
          for (const p of matchPreds) {
            const score = scoreByUser.get(p.userId) ?? Infinity;
            if (lowestScore === null || score < lowestScore) {
              lowestScore = score;
              lowestPred = p;
            }
          }
          if (!lowestPred) continue;

          replacements.push({
            id: generateId(15),
            competitionId: competition.id,
            userId,
            matchId: match.id,
            homeScore: lowestPred.homeScore,
            awayScore: lowestPred.awayScore,
            progressingTeamId: null,
            isReplacement: true,
          });
        }

        if (replacements.length > 0) {
          await db.insert(predictions).values(replacements);
        }
      }
    } else {
      await db.insert(competitionMembers).values({
        competitionId: competition.id,
        userId,
      });
    }

    res.json(competition);
  } catch (err) {
    console.error('Join competition error:', err);
    res.status(500).json({ error: 'Failed to join competition' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    const user = res.locals.user;
    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    res.json(competition);
  } catch (err) {
    console.error('Get competition error:', err);
    res.status(500).json({ error: 'Failed to fetch competition' });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    const { name, imageUrl, predictionDeadline, allowLateAdditions } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl ?? null;
    if (predictionDeadline !== undefined) {
      updates.predictionDeadline = predictionDeadline ? new Date(predictionDeadline) : null;
    }
    if (allowLateAdditions !== undefined) updates.allowLateAdditions = Boolean(allowLateAdditions);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await db.update(competitions).set(updates).where(eq(competitions.id, id));
    const [updated] = await db.select().from(competitions).where(eq(competitions.id, id));
    res.json(updated);
  } catch (err) {
    console.error('Update competition error:', err);
    res.status(500).json({ error: 'Failed to update competition' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    await db.delete(competitions).where(eq(competitions.id, id));
    res.status(204).send();
  } catch (err) {
    console.error('Delete competition error:', err);
    res.status(500).json({ error: 'Failed to delete competition' });
  }
});

router.delete('/:id/leave', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId: string = res.locals.user.id;

    const [membership] = await db
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, userId)));
    if (!membership) return res.status(404).json({ error: 'Not a member of this competition' });

    await db
      .delete(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, userId)));

    res.status(204).send();
  } catch (err) {
    console.error('Leave competition error:', err);
    res.status(500).json({ error: 'Failed to leave competition' });
  }
});

router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    const user = res.locals.user;
    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const members = await db
      .select({
        id: users.id,
        username: users.username,
        imageUrl: users.imageUrl,
        joinedAt: competitionMembers.joinedAt,
      })
      .from(competitionMembers)
      .innerJoin(users, eq(competitionMembers.userId, users.id))
      .where(eq(competitionMembers.competitionId, id));

    res.json(members);
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

router.get('/:id/leaderboard', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;
    const includeComparison = req.query.includeComparison === 'true';

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const baseConditions = includeComparison
      ? and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false))
      : and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false));

    const rows = await db
      .select({
        userId: users.id,
        username: users.username,
        imageUrl: users.imageUrl,
        isComparisonUser: users.isComparisonUser,
        isLateAddition: users.isLateAddition,
        exactScorePoints: competitionMembers.exactScorePoints,
        correctResultPoints: competitionMembers.correctResultPoints,
        correctTeamProgressesPoints: competitionMembers.correctTeamProgressesPoints,
        correctGroupPositionPoints: competitionMembers.correctGroupPositionPoints,
        correctTeamInKnockoutTiePoints: competitionMembers.correctTeamInKnockoutTiePoints,
        correctTeamInFinalPoints: competitionMembers.correctTeamInFinalPoints,
        correctWinnerPoints: competitionMembers.correctWinnerPoints,
        bonusQuestionPoints: competitionMembers.bonusQuestionPoints,
        lateAdditionPoints: competitionMembers.lateAdditionPoints,
        joinedAt: competitionMembers.joinedAt,
        lateAdditionWindowEndsAt: competitionMembers.lateAdditionWindowEndsAt,
      })
      .from(competitionMembers)
      .innerJoin(users, eq(competitionMembers.userId, users.id))
      .where(baseConditions);

    const rowsWithTotal = rows.map(row => ({
      ...row,
      totalPoints:
        row.exactScorePoints +
        row.correctResultPoints +
        row.correctTeamProgressesPoints +
        row.correctGroupPositionPoints +
        row.correctTeamInKnockoutTiePoints +
        row.correctTeamInFinalPoints +
        row.correctWinnerPoints +
        row.bonusQuestionPoints +
        row.lateAdditionPoints,
    }));
    rowsWithTotal.sort((a, b) => b.totalPoints - a.totalPoints);

    const allCompletedMatchesSorted = await db
      .select({ id: matches.id, scheduledAt: matches.scheduledAt })
      .from(matches)
      .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.status, 'completed')))
      .orderBy(desc(matches.scheduledAt));

    const globalRecentMatchIds = allCompletedMatchesSorted.slice(0, 5).map(m => m.id);
    const allCompletedMatchIds = allCompletedMatchesSorted.map(m => m.id);
    const userPredMatchIds = new Map<string, Set<string>>();
    if (allCompletedMatchIds.length > 0) {
      const allPredRows = await db
        .select({ userId: predictions.userId, matchId: predictions.matchId })
        .from(predictions)
        .where(and(eq(predictions.competitionId, id), inArray(predictions.matchId, allCompletedMatchIds)));
      for (const p of allPredRows) {
        if (!userPredMatchIds.has(p.userId)) userPredMatchIds.set(p.userId, new Set());
        userPredMatchIds.get(p.userId)!.add(p.matchId);
      }
    }

    let rank = 1;
    const leaderboard = rowsWithTotal.map((row, i) => {
      if (i > 0 && row.totalPoints < rowsWithTotal[i - 1].totalPoints) rank = i + 1;
      return {
        userId: row.userId,
        username: row.username,
        imageUrl: row.imageUrl,
        isComparisonUser: row.isComparisonUser,
        isLateAddition: row.isLateAddition,
        lateAdditionWindowEndsAt: row.lateAdditionWindowEndsAt ? row.lateAdditionWindowEndsAt.toISOString() : null,
        totalPoints: row.totalPoints,
        rank,
        breakdown: {
          exactScorePoints: row.exactScorePoints,
          correctResultPoints: row.correctResultPoints,
          correctTeamProgressesPoints: row.correctTeamProgressesPoints,
          correctGroupPositionPoints: row.correctGroupPositionPoints,
          correctTeamInKnockoutTiePoints: row.correctTeamInKnockoutTiePoints,
          correctTeamInFinalPoints: row.correctTeamInFinalPoints,
          correctWinnerPoints: row.correctWinnerPoints,
          bonusQuestionPoints: row.bonusQuestionPoints,
          lateAdditionPoints: row.lateAdditionPoints,
        },
        inactive: (() => {
          const userPreds = userPredMatchIds.get(row.userId) ?? new Set<string>();
          if (row.lateAdditionWindowEndsAt != null) {
            // Late addition user: only count matches scheduled after they joined
            const postJoinMatches = allCompletedMatchesSorted
              .filter(m => m.scheduledAt != null && m.scheduledAt >= row.joinedAt)
              .slice(0, 5);
            return postJoinMatches.length >= 5 && postJoinMatches.every(m => !userPreds.has(m.id));
          }
          return globalRecentMatchIds.length >= 5 && globalRecentMatchIds.every(mid => !userPreds.has(mid));
        })(),
      };
    });

    res.json(leaderboard);
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

router.get('/:id/all-match-predictions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;
    const includeComparison = req.query.includeComparison === 'true';

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const scoringConfig = competition.scoringConfig as ScoringConfig;

    const groupRows = await db
      .select({
        matchId: predictions.matchId,
        userId: predictions.userId,
        username: users.username,
        imageUrl: users.imageUrl,
        isComparisonUser: users.isComparisonUser,
        homeScore: predictions.homeScore,
        awayScore: predictions.awayScore,
        progressingTeamId: predictions.progressingTeamId,
        points: predictions.points,
        isReplacement: predictions.isReplacement,
        actualHomeScore: matches.homeScore,
        actualAwayScore: matches.awayScore,
        matchStage: matches.stage,
        actualProgressingTeamId: matches.progressingTeamId,
      })
      .from(predictions)
      .innerJoin(users, eq(predictions.userId, users.id))
      .innerJoin(matches, eq(predictions.matchId, matches.id))
      .innerJoin(
        competitionMembers,
        and(
          eq(competitionMembers.competitionId, id),
          eq(competitionMembers.userId, predictions.userId)
        )
      )
      .where(
        includeComparison
          ? and(eq(predictions.competitionId, id), eq(matches.status, 'completed'), eq(users.isLeaderboardUser, false))
          : and(eq(predictions.competitionId, id), eq(matches.status, 'completed'), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false))
      );

    type PredBreakdown = {
      exactScore: number; correctResult: number; correctTeamProgresses: number;
      correctTeamInKnockoutTie: number; correctTeamInFinal: number; correctWinner: number;
    };

    const result: Array<{
      matchId: string;
      userId: string;
      username: string;
      imageUrl: string | null;
      isComparisonUser: boolean;
      homeScore: number;
      awayScore: number;
      progressingTeamId: string | null;
      points: number | null;
      isReplacement: boolean;
      breakdown: PredBreakdown;
      flipped?: boolean;
      predHomeTeamId?: string | null;
      predAwayTeamId?: string | null;
      predHomeTeamImageUrl?: string | null;
      predAwayTeamImageUrl?: string | null;
    }> = groupRows.map(row => {
      const bd: PredBreakdown = { exactScore: 0, correctResult: 0, correctTeamProgresses: 0, correctTeamInKnockoutTie: 0, correctTeamInFinal: 0, correctWinner: 0 };
      if (!row.isReplacement && row.actualHomeScore !== null && row.actualAwayScore !== null) {
        const r = calculateMatchPoints(
          { homeScore: row.homeScore, awayScore: row.awayScore, progressingTeamId: row.progressingTeamId },
          { homeScore: row.actualHomeScore, awayScore: row.actualAwayScore, stage: row.matchStage, actualProgressingTeamId: row.actualProgressingTeamId },
          scoringConfig,
        );
        bd.exactScore = r.breakdown.exactScore;
        bd.correctResult = r.breakdown.correctResult;
        bd.correctTeamProgresses = r.breakdown.correctTeamProgresses;
      }
      return { matchId: row.matchId, userId: row.userId, username: row.username, imageUrl: row.imageUrl, isComparisonUser: row.isComparisonUser, homeScore: row.homeScore, awayScore: row.awayScore, progressingTeamId: row.progressingTeamId, points: row.points, isReplacement: row.isReplacement, breakdown: bd };
    });

    // Knockout predictions come from bracketPredictions (not the predictions table).
    // Fetch ALL knockout matches (including not-yet-played) so bracket key indices
    // (round_of_16_0, etc.) stay consistent with how the scoring logic assigns them.
    const KNOCKOUT_STAGE_LIST = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final'] as const;
    const allKoMatches = await db
      .select({ id: matches.id, stage: matches.stage, scheduledAt: matches.scheduledAt, status: matches.status, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId, homeScore: matches.homeScore, awayScore: matches.awayScore, progressingTeamId: matches.progressingTeamId })
      .from(matches)
      .where(and(
        eq(matches.tournamentId, competition.tournamentId),
        inArray(matches.stage, [...KNOCKOUT_STAGE_LIST]),
      ));

    allKoMatches.sort((a, b) => {
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });

    // Map bracket key → matchId (and full data) for completed matches only
    const bracketKeyToMatchId = new Map<string, string>();
    const matchIdToKoData = new Map<string, typeof allKoMatches[number]>();
    const stageIdx = new Map<string, number>();
    for (const m of allKoMatches) {
      const i = stageIdx.get(m.stage) ?? 0;
      if (m.status === 'completed') {
        bracketKeyToMatchId.set(`${m.stage}_${i}`, m.id);
        matchIdToKoData.set(m.id, m);
      }
      stageIdx.set(m.stage, i + 1);
    }

    if (bracketKeyToMatchId.size > 0) {
      // Batch-fetch everything needed for predicted-team resolution alongside bpRows/members
      const [bpRows, memberUsersWithChoices, [tournamentRow], teamInfoRows, completedGroupMatchRows] = await Promise.all([
        db.select({ userId: bracketPredictions.userId, predictions: bracketPredictions.predictions })
          .from(bracketPredictions).where(eq(bracketPredictions.competitionId, id)),
        db.select({
          userId: competitionMembers.userId,
          username: users.username,
          imageUrl: users.imageUrl,
          isLeaderboardUser: users.isLeaderboardUser,
          isComparisonUser: users.isComparisonUser,
          groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices,
          luckyLoserChoices: competitionMembers.luckyLoserChoices,
        }).from(competitionMembers).innerJoin(users, eq(users.id, competitionMembers.userId)).where(eq(competitionMembers.competitionId, id)),
        db.select({ knockoutConfig: tournaments.knockoutConfig }).from(tournaments).where(eq(tournaments.id, competition.tournamentId)),
        db.select({ id: teams.id, imageUrl: teams.imageUrl, groupName: groups.name })
          .from(teams).leftJoin(groups, eq(groups.id, teams.groupId)).where(eq(teams.tournamentId, competition.tournamentId)),
        db.select({ id: matches.id, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId })
          .from(matches).where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed'))),
      ]);

      const userInfoMap = new Map(
        memberUsersWithChoices.filter(u => !u.isLeaderboardUser && (includeComparison || !u.isComparisonUser)).map(u => [u.userId, u])
      );

      const koCfg = tournamentRow?.knockoutConfig as KnockoutConfig | null;
      const teamImageMap = new Map(teamInfoRows.map(t => [t.id, t.imageUrl ?? null]));
      const teamGroupMap = new Map<string, string>();
      for (const t of teamInfoRows) { if (t.groupName) teamGroupMap.set(t.id, t.groupName); }

      const groupMatchIds = completedGroupMatchRows.map(m => m.id);
      const allGroupPreds = groupMatchIds.length > 0
        ? await db.select({ userId: predictions.userId, matchId: predictions.matchId, homeScore: predictions.homeScore, awayScore: predictions.awayScore })
            .from(predictions).where(and(eq(predictions.competitionId, id), inArray(predictions.matchId, groupMatchIds)))
        : [];
      const groupPredsByUser = new Map<string, typeof allGroupPreds>();
      for (const p of allGroupPreds) {
        if (!groupPredsByUser.has(p.userId)) groupPredsByUser.set(p.userId, []);
        groupPredsByUser.get(p.userId)!.push(p);
      }

      // matchesByStageActual: used as baseline for trajectory tracing (non-first-round)
      const matchesByStageActual = new Map<string, KnockoutMatchSlot[]>();
      for (const m of allKoMatches) {
        if (!matchesByStageActual.has(m.stage)) matchesByStageActual.set(m.stage, []);
        matchesByStageActual.get(m.stage)!.push({ id: m.id, stage: m.stage, homeTeamId: m.homeTeamId ?? null, awayTeamId: m.awayTeamId ?? null });
      }

      for (const bp of bpRows) {
        const userInfo = userInfoMap.get(bp.userId);
        if (!userInfo) continue;
        const bpPreds = bp.predictions as BracketPredictions;

        // Resolve per-user predicted first-round teams from their group predictions
        let firstRoundPredTeams: Record<string, { predHomeId: string | null; predAwayId: string | null }> = {};
        let matchesByStageForPred: Map<string, KnockoutMatchSlot[]> = matchesByStageActual;

        if (koCfg) {
          const { firstRound, bracketSlots, directQualifiers } = koCfg;
          const userGroupPredMap = new Map((groupPredsByUser.get(bp.userId) ?? []).map(p => [p.matchId, p]));
          const simulatedMatches = completedGroupMatchRows
            .filter(m => m.homeTeamId && m.awayTeamId)
            .flatMap(m => {
              const p = userGroupPredMap.get(m.id);
              return p ? [{ homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId!, homeScore: p.homeScore, awayScore: p.awayScore }] : [];
            });
          const predictedStandings = computeGroupStandings(simulatedMatches, teamGroupMap, (userInfo.groupDisciplinaryChoices ?? {}) as Record<string, string[]>);
          const allFirstRoundMatches = allKoMatches.filter(m => m.stage === firstRound);
          const resolvedSlots = resolveFirstRoundSlots(bracketSlots, predictedStandings, directQualifiers, allFirstRoundMatches.length, (userInfo.luckyLoserChoices ?? {}) as Record<string, string[]>);
          allFirstRoundMatches.forEach((m, i) => {
            firstRoundPredTeams[`${firstRound}_${i}`] = { predHomeId: resolvedSlots[`m${i + 1}_home`] ?? null, predAwayId: resolvedSlots[`m${i + 1}_away`] ?? null };
          });

          // Build matchesByStage where first-round slots use predicted teams so that
          // later-round trajectory tracing via getUserPredictedTeamForKnockoutSlot
          // correctly propagates predicted (not actual) first-round occupants.
          const modMatchesByStage = new Map<string, KnockoutMatchSlot[]>();
          const stageIdxCounter = new Map<string, number>();
          for (const m of allKoMatches) {
            if (!modMatchesByStage.has(m.stage)) modMatchesByStage.set(m.stage, []);
            const idx = stageIdxCounter.get(m.stage) ?? 0;
            stageIdxCounter.set(m.stage, idx + 1);
            const slot = m.stage === firstRound ? firstRoundPredTeams[`${firstRound}_${idx}`] : null;
            modMatchesByStage.get(m.stage)!.push({
              id: m.id, stage: m.stage,
              homeTeamId: slot ? slot.predHomeId : (m.homeTeamId ?? null),
              awayTeamId: slot ? slot.predAwayId : (m.awayTeamId ?? null),
            });
          }
          matchesByStageForPred = modMatchesByStage;
        }

        for (const [bracketKey, matchId] of bracketKeyToMatchId) {
          const pred = bpPreds[bracketKey];
          if (!pred) continue;

          let predHomeTeamId: string | null = null;
          let predAwayTeamId: string | null = null;

          if (koCfg) {
            const { firstRound } = koCfg;
            const lastUnderscore = bracketKey.lastIndexOf('_');
            const bracketStage = bracketKey.slice(0, lastUnderscore);
            const matchIdx = parseInt(bracketKey.slice(lastUnderscore + 1), 10);
            if (bracketStage === firstRound) {
              predHomeTeamId = firstRoundPredTeams[bracketKey]?.predHomeId ?? null;
              predAwayTeamId = firstRoundPredTeams[bracketKey]?.predAwayId ?? null;
            } else {
              predHomeTeamId = getUserPredictedTeamForKnockoutSlot(bracketStage, matchIdx, 'home', firstRound, matchesByStageForPred, bpPreds);
              predAwayTeamId = getUserPredictedTeamForKnockoutSlot(bracketStage, matchIdx, 'away', firstRound, matchesByStageForPred, bpPreds);
            }
          }

          // Calculate points using the same logic as the scoring engine
          const koMatchData = matchIdToKoData.get(matchId);
          let koPoints = 0;
          const koBd: PredBreakdown = { exactScore: 0, correctResult: 0, correctTeamProgresses: 0, correctTeamInKnockoutTie: 0, correctTeamInFinal: 0, correctWinner: 0 };
          if (koMatchData && koMatchData.homeScore !== null && koMatchData.awayScore !== null) {
            const shouldFlip = pred.flipped ?? false;
            const scoredMatch = {
              homeScore: shouldFlip ? koMatchData.awayScore : koMatchData.homeScore,
              awayScore: shouldFlip ? koMatchData.homeScore : koMatchData.awayScore,
              stage: koMatchData.stage,
              actualProgressingTeamId: koMatchData.progressingTeamId,
            };
            const basicResult = calculateMatchPoints(
              { homeScore: pred.homeScore, awayScore: pred.awayScore, progressingTeamId: pred.progressingTeamId ?? null },
              scoredMatch, scoringConfig,
            );
            koPoints = basicResult.points;
            koBd.exactScore = basicResult.breakdown.exactScore;
            koBd.correctResult = basicResult.breakdown.correctResult;
            koBd.correctTeamProgresses = basicResult.breakdown.correctTeamProgresses;

            // correct_team_in_knockout_tie / correct_team_in_final / correct_winner
            if (koCfg && koMatchData.stage !== koCfg.firstRound && koMatchData.stage !== 'bronze_final') {
              let userPredictedWinner: string | null = null;
              if (koMatchData.stage === 'final') {
                if (pred.progressingTeamId) {
                  userPredictedWinner = pred.progressingTeamId;
                } else if (!shouldFlip) {
                  if (pred.homeScore > pred.awayScore) userPredictedWinner = predHomeTeamId;
                  else if (pred.awayScore > pred.homeScore) userPredictedWinner = predAwayTeamId;
                } else {
                  if (pred.homeScore > pred.awayScore) userPredictedWinner = predAwayTeamId;
                  else if (pred.awayScore > pred.homeScore) userPredictedWinner = predHomeTeamId;
                }
              }
              for (const actualTeamId of [koMatchData.homeTeamId, koMatchData.awayTeamId]) {
                if (!actualTeamId) continue;
                if (predHomeTeamId !== actualTeamId && predAwayTeamId !== actualTeamId) continue;
                if (koMatchData.stage === 'final') {
                  if (actualTeamId === koMatchData.progressingTeamId && actualTeamId === userPredictedWinner) {
                    koPoints += scoringConfig.correct_winner;
                    koBd.correctWinner += scoringConfig.correct_winner;
                  } else {
                    koPoints += scoringConfig.correct_team_in_final;
                    koBd.correctTeamInFinal += scoringConfig.correct_team_in_final;
                  }
                } else {
                  koPoints += scoringConfig.correct_team_in_knockout_tie;
                  koBd.correctTeamInKnockoutTie += scoringConfig.correct_team_in_knockout_tie;
                }
              }
            }

            // First-round: award correct_team_in_knockout_tie when the user correctly
            // predicted which group-stage teams would qualify into the draw.
            if (koCfg && koMatchData.stage === koCfg.firstRound) {
              for (const actualTeamId of [koMatchData.homeTeamId, koMatchData.awayTeamId]) {
                if (!actualTeamId) continue;
                if (predHomeTeamId !== actualTeamId && predAwayTeamId !== actualTeamId) continue;
                koPoints += scoringConfig.correct_team_in_knockout_tie;
                koBd.correctTeamInKnockoutTie += scoringConfig.correct_team_in_knockout_tie;
              }
            }
          }

          result.push({
            matchId,
            userId: bp.userId,
            username: userInfo.username,
            imageUrl: userInfo.imageUrl,
            isComparisonUser: userInfo.isComparisonUser,
            homeScore: pred.homeScore,
            awayScore: pred.awayScore,
            progressingTeamId: pred.progressingTeamId ?? null,
            points: koPoints,
            breakdown: koBd,
            flipped: pred.flipped ?? false,
            predHomeTeamId,
            predAwayTeamId,
            predHomeTeamImageUrl: predHomeTeamId ? (teamImageMap.get(predHomeTeamId) ?? null) : null,
            predAwayTeamImageUrl: predAwayTeamId ? (teamImageMap.get(predAwayTeamId) ?? null) : null,
          });
        }
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Get all match predictions error:', err);
    res.status(500).json({ error: 'Failed to fetch match predictions' });
  }
});

router.get('/:id/user-stats', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const lang: Lang = req.query.lang === 'no' ? 'no' : 'en';
    const user = res.locals.user;

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });
    const scoringConfig = competition.scoringConfig as ScoringConfig;

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const rows = await db
      .select({
        userId: predictions.userId,
        username: users.username,
        imageUrl: users.imageUrl,
        isLateAddition: users.isLateAddition,
        matchId: predictions.matchId,
        predHomeScore: predictions.homeScore,
        predAwayScore: predictions.awayScore,
        actualHomeScore: matches.homeScore,
        actualAwayScore: matches.awayScore,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
        scheduledAt: matches.scheduledAt,
        points: predictions.points,
      })
      .from(predictions)
      .innerJoin(users, eq(predictions.userId, users.id))
      .innerJoin(matches, eq(predictions.matchId, matches.id))
      .where(
        and(
          eq(predictions.competitionId, id),
          eq(matches.status, 'completed'),
          eq(users.isLeaderboardUser, false),
          eq(users.isComparisonUser, false),
          eq(predictions.isReplacement, false)
        )
      );

    // Determine inactive users (no predictions in the 5 most recent completed matches)
    const recentForStatCards = await db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.status, 'completed')))
      .orderBy(desc(matches.scheduledAt))
      .limit(5);

    let activeStatUserIds: Set<string> | null = null;
    if (recentForStatCards.length >= 5) {
      const recentIdsForStatCards = recentForStatCards.map(m => m.id);
      const recentStatPreds = await db
        .select({ userId: predictions.userId })
        .from(predictions)
        .where(and(eq(predictions.competitionId, id), inArray(predictions.matchId, recentIdsForStatCards)));
      activeStatUserIds = new Set(recentStatPreds.map(r => r.userId));
    }

    const activeRows = activeStatUserIds ? rows.filter(r => activeStatUserIds!.has(r.userId)) : rows;

    const oneGoalAwayCounts = new Map<string, { username: string; imageUrl: string | null; count: number }>();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      const goalsAway =
        Math.abs(row.predHomeScore - row.actualHomeScore) + Math.abs(row.predAwayScore - row.actualAwayScore);
      if (goalsAway !== 1) continue;
      const entry = oneGoalAwayCounts.get(row.userId) ?? { username: row.username, imageUrl: row.imageUrl, count: 0 };
      entry.count += 1;
      oneGoalAwayCounts.set(row.userId, entry);
    }

    const distinctUnluckyCounts = [...new Set([...oneGoalAwayCounts.values()].map(e => e.count))].sort(
      (a, b) => b - a
    );
    const topUnluckyCount = distinctUnluckyCounts[0];
    const nextUnluckyCount = distinctUnluckyCounts[1];

    const groupByCount = (count: number | undefined) =>
      count === undefined
        ? []
        : [...oneGoalAwayCounts.entries()]
            .filter(([, entry]) => entry.count === count)
            .map(([userId, entry]) => ({ userId, ...entry }))
            .sort((a, b) => a.username.localeCompare(b.username));

    const unluckyGroup = groupByCount(topUnluckyCount);
    const nextUnluckyGroup = groupByCount(nextUnluckyCount);

    // ── Hit or Miss: highest exact-score-to-correct-result ratio ──
    const userResultStats = new Map<
      string,
      { username: string; imageUrl: string | null; correctResults: number; exactScores: number }
    >();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      const predictedResult = Math.sign(row.predHomeScore - row.predAwayScore);
      const actualResult = Math.sign(row.actualHomeScore - row.actualAwayScore);
      if (predictedResult !== actualResult) continue;
      const entry =
        userResultStats.get(row.userId) ??
        { username: row.username, imageUrl: row.imageUrl, correctResults: 0, exactScores: 0 };
      entry.correctResults += 1;
      if (row.predHomeScore === row.actualHomeScore && row.predAwayScore === row.actualAwayScore) {
        entry.exactScores += 1;
      }
      userResultStats.set(row.userId, entry);
    }

    const compareExactRatio = (
      a: { exactScores: number; correctResults: number },
      b: { exactScores: number; correctResults: number }
    ) => a.exactScores * b.correctResults - b.exactScores * a.correctResults;

    const hitOrMissCandidates = [...userResultStats.entries()]
      .map(([userId, entry]) => ({ userId, ...entry }))
      .filter(candidate => candidate.exactScores >= 2);

    let hitOrMissGroup: typeof hitOrMissCandidates = [];
    if (hitOrMissCandidates.length > 0) {
      const bestRatio = hitOrMissCandidates.reduce((best, candidate) =>
        compareExactRatio(candidate, best) > 0 ? candidate : best
      );
      const ratioTied = hitOrMissCandidates.filter(candidate => compareExactRatio(candidate, bestRatio) === 0);
      const maxExactScores = Math.max(...ratioTied.map(candidate => candidate.exactScores));
      hitOrMissGroup = ratioTied
        .filter(candidate => candidate.exactScores === maxExactScores)
        .sort((a, b) => a.username.localeCompare(b.username));
    }

    // ── Close But No Cigar: widest gap between correct results and exact scores ──
    const computeResultExactGap = (entry: { correctResults: number; exactScores: number }) =>
      entry.correctResults - entry.exactScores;

    const closeButNoCigarCandidates = [...userResultStats.entries()]
      .map(([userId, entry]) => ({ userId, ...entry }))
      .filter(candidate => candidate.correctResults > 0);

    let closeButNoCigarGroup: typeof closeButNoCigarCandidates = [];
    if (closeButNoCigarCandidates.length > 0) {
      const widestGap = Math.max(...closeButNoCigarCandidates.map(computeResultExactGap));
      const gapTied = closeButNoCigarCandidates.filter(candidate => computeResultExactGap(candidate) === widestGap);
      const lowestRatio = gapTied.reduce((best, candidate) =>
        compareExactRatio(candidate, best) < 0 ? candidate : best
      );
      closeButNoCigarGroup = gapTied
        .filter(candidate => compareExactRatio(candidate, lowestRatio) === 0)
        .sort((a, b) => a.username.localeCompare(b.username));
    }

    // ── Best/Worst form: points earned across the most recent completed matches ──
    const completedMatches = await db
      .select({ id: matches.id, scheduledAt: matches.scheduledAt })
      .from(matches)
      .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.status, 'completed')));
    const completedMatchesByRecency = [...completedMatches].sort(
      (a, b) => (b.scheduledAt?.getTime() ?? 0) - (a.scheduledAt?.getTime() ?? 0)
    );
    const last5MatchIds = new Set(completedMatchesByRecency.slice(0, 5).map(m => m.id));

    const userInfo = new Map<string, { username: string; imageUrl: string | null }>();
    const isLateAdditionByUser = new Map<string, boolean>();
    const pointsByUserMatch = new Map<string, number>();
    const predCountByUser = new Map<string, number>();
    for (const row of activeRows) {
      userInfo.set(row.userId, { username: row.username, imageUrl: row.imageUrl });
      isLateAdditionByUser.set(row.userId, row.isLateAddition);
      pointsByUserMatch.set(`${row.userId}|${row.matchId}`, row.points ?? 0);
      predCountByUser.set(row.userId, (predCountByUser.get(row.userId) ?? 0) + 1);
    }

    const completedMatchCountInCompetition = new Set(activeRows.map(r => r.matchId)).size;
    const usersWithAllPredictions = new Set(
      [...predCountByUser.entries()]
        .filter(([, count]) => count === completedMatchCountInCompetition)
        .map(([userId]) => userId)
    );

    // Late addition users must have at least 5 real (non-replacement) predictions with results
    // before being eligible for best/worst form cards
    const formEligibleUserIds = new Set<string>(
      [...userInfo.keys()].filter(userId => {
        if (!isLateAdditionByUser.get(userId)) return true;
        return (predCountByUser.get(userId) ?? 0) >= 5;
      })
    );

    const recentPointsByUser = new Map<string, number>();
    for (const row of activeRows) {
      if (!last5MatchIds.has(row.matchId)) continue;
      if (!formEligibleUserIds.has(row.userId)) continue;
      recentPointsByUser.set(row.userId, (recentPointsByUser.get(row.userId) ?? 0) + (row.points ?? 0));
    }

    let bestFormGroup: { userId: string; username: string; imageUrl: string | null; points: number }[] = [];
    if (recentPointsByUser.size > 0) {
      const maxRecentPoints = Math.max(...recentPointsByUser.values());
      bestFormGroup = [...recentPointsByUser.entries()]
        .filter(([, points]) => points === maxRecentPoints)
        .map(([userId, points]) => ({ userId, points, ...userInfo.get(userId)! }))
        .sort((a, b) => a.username.localeCompare(b.username));
    }

    let worstFormGroup: { userId: string; username: string; imageUrl: string | null; drought: number }[] = [];
    if (completedMatchesByRecency.length > 0) {
      const droughtByUser = new Map<string, number>();
      for (const userId of userInfo.keys()) {
        if (!usersWithAllPredictions.has(userId)) continue;
        if (!formEligibleUserIds.has(userId)) continue;
        let drought = 0;
        for (const match of completedMatchesByRecency) {
          const points = pointsByUserMatch.get(`${userId}|${match.id}`) ?? 0;
          if (points > 0) break;
          drought += 1;
        }
        droughtByUser.set(userId, drought);
      }
      const maxDrought = Math.max(...droughtByUser.values());
      if (maxDrought > 1) {
        worstFormGroup = [...droughtByUser.entries()]
          .filter(([, drought]) => drought === maxDrought)
          .map(([userId, drought]) => ({ userId, drought, ...userInfo.get(userId)! }))
          .sort((a, b) => a.username.localeCompare(b.username));
      }
    }

    // ── The Leader: how many consecutive recent matches the current leader(s) have topped the table ──
    const completedMatchesByOldest = [...completedMatchesByRecency].reverse();
    const cumulativePointsByUser = new Map<string, number>();
    for (const userId of userInfo.keys()) cumulativePointsByUser.set(userId, 0);

    const leadingSetsByMatch: Set<string>[] = [];
    for (const match of completedMatchesByOldest) {
      for (const userId of userInfo.keys()) {
        const points = pointsByUserMatch.get(`${userId}|${match.id}`) ?? 0;
        cumulativePointsByUser.set(userId, (cumulativePointsByUser.get(userId) ?? 0) + points);
      }
      const maxPoints = Math.max(...cumulativePointsByUser.values());
      leadingSetsByMatch.push(
        new Set([...cumulativePointsByUser.entries()].filter(([, p]) => p === maxPoints).map(([userId]) => userId))
      );
    }

    let kingGroup: { userId: string; username: string; imageUrl: string | null; streak: number }[] = [];
    if (leadingSetsByMatch.length > 0) {
      const streakFor = (userId: string) => {
        let streak = 0;
        for (let i = leadingSetsByMatch.length - 1; i >= 0; i--) {
          if (!leadingSetsByMatch[i].has(userId)) break;
          streak += 1;
        }
        return streak;
      };
      const currentLeaders = leadingSetsByMatch[leadingSetsByMatch.length - 1];
      const leaderStreaks = [...currentLeaders].map(userId => ({ userId, streak: streakFor(userId) }));
      if (leaderStreaks.length > 0) {
        const maxStreak = Math.max(...leaderStreaks.map(l => l.streak));
        kingGroup = leaderStreaks
          .filter(l => l.streak === maxStreak)
          .map(l => ({ userId: l.userId, streak: l.streak, ...userInfo.get(l.userId)! }))
          .sort((a, b) => a.username.localeCompare(b.username));
      }
    }

    let theLeaderCard: UserStatCardData | null = null;
    let bottomOfTheLeagueCard: UserStatCardData | null = null;
    let groupStageGuruCard: UserStatCardData | null = null;
    let thePatriotCard: UserStatCardData | null = null;
    let theOptimistCard: UserStatCardData | null = null;
    let bestPredictionCard: UserStatCardData | null = null;
    let worstPredictionCard: UserStatCardData | null = null;
    let bestFormCard: UserStatCardData | null = null;
    let worstFormCard: UserStatCardData | null = null;
    let unluckyCard: UserStatCardData | null = null;
    let hitOrMissCard: UserStatCardData | null = null;
    let closeButNoCigarCard: UserStatCardData | null = null;
    let mostContrastingPredictionCard: UserStatCardData | null = null;
    let mostUnexpectedResultCard: UserStatCardData | null = null;
    let mostPredictableResultCard: UserStatCardData | null = null;
    let brautometerCard: UserStatCardData | null = null;
    let swingAndAMissCard: UserStatCardData | null = null;
    let traitorCard: UserStatCardData | null = null;

    if (kingGroup.length > 0) {
      const gameCount = kingGroup[0].streak;
      theLeaderCard = {
        id: 'theLeader',
        title: lang === 'no' ? 'Kongen på haugen' : 'The Leader',
        statistic:
          lang === 'no'
            ? `${formatUserList(kingGroup.map(u => u.username), lang)} har regjert på toppen i ${gameCount} kamp${gameCount === 1 ? '' : 'er'}!`
            : `${formatUserList(kingGroup.map(u => u.username), lang)} ${kingGroup.length === 1 ? 'has' : 'have'} reigned supreme for the last ${gameCount} game${gameCount === 1 ? '' : 's'}!`,
        subjects: kingGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
        linkType: 'leaderboard',
      };
    }

    // ── Bottom of the league: lowest total points vs. the leader ──
    const memberRows = await db
      .select({
        userId: users.id,
        username: users.username,
        imageUrl: users.imageUrl,
        exactScorePoints: competitionMembers.exactScorePoints,
        correctResultPoints: competitionMembers.correctResultPoints,
        correctTeamProgressesPoints: competitionMembers.correctTeamProgressesPoints,
        correctGroupPositionPoints: competitionMembers.correctGroupPositionPoints,
        correctTeamInKnockoutTiePoints: competitionMembers.correctTeamInKnockoutTiePoints,
        correctTeamInFinalPoints: competitionMembers.correctTeamInFinalPoints,
        correctWinnerPoints: competitionMembers.correctWinnerPoints,
        bonusQuestionPoints: competitionMembers.bonusQuestionPoints,
        lateAdditionPoints: competitionMembers.lateAdditionPoints,
      })
      .from(competitionMembers)
      .innerJoin(users, eq(competitionMembers.userId, users.id))
      .where(and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false)));

    const memberTotals = memberRows
      .filter(m => !activeStatUserIds || activeStatUserIds.has(m.userId))
      .map(row => ({
        userId: row.userId,
        username: row.username,
        imageUrl: row.imageUrl,
        totalPoints:
          row.exactScorePoints +
          row.correctResultPoints +
          row.correctTeamProgressesPoints +
          row.correctGroupPositionPoints +
          row.correctTeamInKnockoutTiePoints +
          row.correctTeamInFinalPoints +
          row.correctWinnerPoints +
          row.bonusQuestionPoints +
          row.lateAdditionPoints,
      }));

    if (memberTotals.length >= 3) {
      const minPoints = Math.min(...memberTotals.map(m => m.totalPoints));
      const maxPoints = Math.max(...memberTotals.map(m => m.totalPoints));
      const bottomGroup = memberTotals
        .filter(m => m.totalPoints === minPoints)
        .sort((a, b) => a.username.localeCompare(b.username));
      const topGroup = memberTotals
        .filter(m => m.totalPoints === maxPoints)
        .sort((a, b) => a.username.localeCompare(b.username));
      const gap = maxPoints - minPoints;

      bottomOfTheLeagueCard = {
        id: 'bottomOfTheLeague',
        title: lang === 'no' ? 'Kan Bare Bli Bedre' : 'Bottom of the league',
        statistic:
          lang === 'no'
            ? `${formatUserList(bottomGroup.map(u => u.username), lang)} er sist på tabellen med bare ${minPoints} poeng! ${gap} poeng bak ${formatUserList(topGroup.map(u => u.username), lang)} på topp!`
            : `${formatUserList(bottomGroup.map(u => u.username), lang)} ${bottomGroup.length === 1 ? 'is' : 'are'} bottom of the table with only ${minPoints} point${minPoints === 1 ? '' : 's'}! ${gap} point${gap === 1 ? '' : 's'} behind ${formatUserList(topGroup.map(u => u.username), lang)} in first place!`,
        subjects: bottomGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
        linkType: 'leaderboard',
      };
    }

    // ── Group Stage Guru: accuracy of each user's predicted final group standings ──
    const tournamentGroupMatches = await db
      .select({
        id: matches.id,
        status: matches.status,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
        homeScore: matches.homeScore,
        awayScore: matches.awayScore,
      })
      .from(matches)
      .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.stage, 'group')));

    const groupStageComplete =
      tournamentGroupMatches.length > 0 && tournamentGroupMatches.every(m => m.status === 'completed');

    if (groupStageComplete) {
      const groupRows = await db.select().from(groups).where(eq(groups.tournamentId, competition.tournamentId));
      const groupNameMap = new Map(groupRows.map(g => [g.id, g.name]));
      const groupTeamRows = await db
        .select({ id: teams.id, groupId: teams.groupId })
        .from(teams)
        .where(eq(teams.tournamentId, competition.tournamentId));
      const teamGroupMap = new Map<string, string>();
      for (const t of groupTeamRows) {
        if (t.groupId) {
          const gName = groupNameMap.get(t.groupId);
          if (gName) teamGroupMap.set(t.id, gName);
        }
      }

      const [tournamentRow] = await db.select().from(tournaments).where(eq(tournaments.id, competition.tournamentId));
      const tournamentKnockoutConfig = tournamentRow?.knockoutConfig as KnockoutConfig | null;
      const tournamentGroupDisciplinaryChoices = tournamentKnockoutConfig?.groupDisciplinaryChoices ?? {};

      const actualStandings = computeGroupStandings(tournamentGroupMatches, teamGroupMap, tournamentGroupDisciplinaryChoices);
      const totalTeamCount = [...actualStandings.values()].reduce((sum, teamList) => sum + teamList.length, 0);

      if (totalTeamCount > 0) {
        const groupMatchIds = tournamentGroupMatches.map(m => m.id);
        const memberPredRows = await db
          .select({
            userId: predictions.userId,
            matchId: predictions.matchId,
            predHomeScore: predictions.homeScore,
            predAwayScore: predictions.awayScore,
          })
          .from(predictions)
          .where(and(eq(predictions.competitionId, id), inArray(predictions.matchId, groupMatchIds)));

        const predsByUser = new Map<string, typeof memberPredRows>();
        for (const p of memberPredRows) {
          if (!predsByUser.has(p.userId)) predsByUser.set(p.userId, []);
          predsByUser.get(p.userId)!.push(p);
        }

        const allMemberChoiceRows = await db
          .select({
            userId: competitionMembers.userId,
            username: users.username,
            imageUrl: users.imageUrl,
            groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices,
          })
          .from(competitionMembers)
          .innerJoin(users, eq(competitionMembers.userId, users.id))
          .where(and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false)));

        const memberChoiceRows = activeStatUserIds
          ? allMemberChoiceRows.filter(m => activeStatUserIds!.has(m.userId))
          : allMemberChoiceRows;

        const memberInfoByUserId = new Map(
          memberChoiceRows.map(m => [m.userId, { userId: m.userId, username: m.username, imageUrl: m.imageUrl }])
        );

        const correctCountByUser = new Map<string, number>();
        for (const { userId, groupDisciplinaryChoices } of memberChoiceRows) {
          const predMap = new Map((predsByUser.get(userId) ?? []).map(p => [p.matchId, p]));
          const simulatedMatches = tournamentGroupMatches
            .filter(m => m.homeTeamId && m.awayTeamId)
            .flatMap(m => {
              const pred = predMap.get(m.id);
              if (!pred) return [];
              return [{ homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId!, homeScore: pred.predHomeScore, awayScore: pred.predAwayScore }];
            });
          const predictedStandings = computeGroupStandings(simulatedMatches, teamGroupMap, groupDisciplinaryChoices ?? {});

          let correct = 0;
          for (const [group, actualTeams] of actualStandings) {
            const predictedTeams = predictedStandings.get(group) ?? [];
            for (let i = 0; i < actualTeams.length; i++) {
              if (predictedTeams[i]?.teamId === actualTeams[i].teamId) correct += 1;
            }
          }
          correctCountByUser.set(userId, correct);
        }

        if (correctCountByUser.size > 0) {
          const maxCorrect = Math.max(...correctCountByUser.values());
          const minCorrect = Math.min(...correctCountByUser.values());
          const bestGroup = [...correctCountByUser.entries()]
            .filter(([, count]) => count === maxCorrect)
            .map(([userId]) => memberInfoByUserId.get(userId)!)
            .sort((a, b) => a.username.localeCompare(b.username));

          let worstSentence = '';
          if (minCorrect < maxCorrect) {
            const worstGroup = [...correctCountByUser.entries()]
              .filter(([, count]) => count === minCorrect)
              .map(([userId]) => memberInfoByUserId.get(userId)!)
              .sort((a, b) => a.username.localeCompare(b.username));
            worstSentence =
              lang === 'no'
                ? ` ${formatUserList(worstGroup.map(u => u.username), lang)} hadde færrest riktige, med bare ${minCorrect}.`
                : ` ${formatUserList(worstGroup.map(u => u.username), lang)} had the fewest correct, with only ${minCorrect}.`;
          }

          groupStageGuruCard = {
            id: 'groupStageGuru',
            title: lang === 'no' ? 'Gruppespill-Geni' : 'Group Stage Guru',
            statistic:
              (lang === 'no'
                ? `${formatUserList(bestGroup.map(u => u.username), lang)} tippet ${maxCorrect} av ${totalTeamCount} lag i riktig posisjon i gruppespillet!`
                : `${formatUserList(bestGroup.map(u => u.username), lang)} predicted ${maxCorrect} out of ${totalTeamCount} teams in their correct final group position!`) +
              worstSentence,
            subjects: bestGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
            linkType: 'user',
          };
        }
      }
    }

    // ── The Patriot: most optimistic predictions for Norway's games ──
    const tournamentTeamsForPatriot = await db
      .select({ id: teams.id, name: teams.name, imageUrl: teams.imageUrl })
      .from(teams)
      .where(eq(teams.tournamentId, competition.tournamentId));
    const norwayTeam = tournamentTeamsForPatriot.find(t => ['norway', 'norge'].includes(t.name.trim().toLowerCase()));

    if (norwayTeam) {
      const norwayMatches = await db
        .select({ id: matches.id, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId })
        .from(matches)
        .where(
          and(
            eq(matches.tournamentId, competition.tournamentId),
            eq(matches.status, 'completed'),
            or(eq(matches.homeTeamId, norwayTeam.id), eq(matches.awayTeamId, norwayTeam.id))
          )
        );

      if (norwayMatches.length > 0) {
        const norwayMatchIds = new Set(norwayMatches.map(m => m.id));
        const norwayHomeByMatch = new Map(norwayMatches.map(m => [m.id, m.homeTeamId === norwayTeam.id]));

        const patriotStatsByUser = new Map<
          string,
          { username: string; imageUrl: string | null; wins: number; gf: number; ga: number }
        >();
        for (const row of activeRows) {
          if (!norwayMatchIds.has(row.matchId)) continue;
          const norwayIsHome = norwayHomeByMatch.get(row.matchId);
          const predNorwayGoals = norwayIsHome ? row.predHomeScore : row.predAwayScore;
          const predOpponentGoals = norwayIsHome ? row.predAwayScore : row.predHomeScore;
          const entry =
            patriotStatsByUser.get(row.userId) ?? { username: row.username, imageUrl: row.imageUrl, wins: 0, gf: 0, ga: 0 };
          if (predNorwayGoals > predOpponentGoals) entry.wins += 1;
          entry.gf += predNorwayGoals;
          entry.ga += predOpponentGoals;
          patriotStatsByUser.set(row.userId, entry);
        }

        if (patriotStatsByUser.size > 0) {
          let patriotGroup = [...patriotStatsByUser.entries()].map(([userId, entry]) => ({
            userId,
            ...entry,
            gd: entry.gf - entry.ga,
          }));
          const maxWins = Math.max(...patriotGroup.map(p => p.wins));
          patriotGroup = patriotGroup.filter(p => p.wins === maxWins);
          const maxGd = Math.max(...patriotGroup.map(p => p.gd));
          patriotGroup = patriotGroup.filter(p => p.gd === maxGd);
          const maxGf = Math.max(...patriotGroup.map(p => p.gf));
          patriotGroup = patriotGroup.filter(p => p.gf === maxGf);
          patriotGroup.sort((a, b) => a.username.localeCompare(b.username));

          const winner = patriotGroup[0];
          const concededClause =
            winner.ga > 0
              ? lang === 'no'
                ? `sluppet inn bare ${winner.ga}!`
                : `conceded only ${winner.ga}!`
              : lang === 'no'
                ? 'uten å slippe inn ett eneste mål!'
                : 'without conceding a single goal!';

          thePatriotCard = {
            id: 'thePatriot',
            title: lang === 'no' ? 'Patrioten 🇳🇴' : 'The Patriot 🇳🇴',
            statistic:
              lang === 'no'
                ? `${formatUserList(patriotGroup.map(u => u.username), lang)} er den største patrioten! De har tippet at Norge har vunnet ${winner.wins} av sine ${norwayMatches.length} kamper så langt! Og at de har scoret hele ${winner.gf} mål og ${concededClause}`
                : `${formatUserList(patriotGroup.map(u => u.username), lang)} ${patriotGroup.length === 1 ? 'is the biggest patriot' : 'are the biggest patriots'}! They've predicted that Norway has won ${winner.wins} of their ${norwayMatches.length} games so far! And that they've scored a whopping ${winner.gf} goals and ${concededClause}`,
            subjects: patriotGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
            linkType: 'user',
            overlayImageUrl: norwayTeam.imageUrl ?? null,
          };
        }
      }
    }

    // ── Best/worst prediction: per-match outcome stats ──
    interface MatchStat {
      matchId: string;
      homeTeamId: string | null;
      awayTeamId: string | null;
      homeScore: number;
      awayScore: number;
      scheduledAt: Date | null;
      perfectScorers: { userId: string; username: string; imageUrl: string | null }[];
      resultCount: number;
      wrongPredictors: { userId: string; username: string; imageUrl: string | null; predHomeScore: number; predAwayScore: number }[];
      predictorPoints: { userId: string; username: string; imageUrl: string | null; points: number | null }[];
      predictions: { userId: string; username: string; imageUrl: string | null; predHomeScore: number; predAwayScore: number }[];
    }
    const matchStats = new Map<string, MatchStat>();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      let stat = matchStats.get(row.matchId);
      if (!stat) {
        stat = {
          matchId: row.matchId,
          homeTeamId: row.homeTeamId,
          awayTeamId: row.awayTeamId,
          homeScore: row.actualHomeScore,
          awayScore: row.actualAwayScore,
          scheduledAt: row.scheduledAt,
          perfectScorers: [],
          resultCount: 0,
          wrongPredictors: [],
          predictorPoints: [],
          predictions: [],
        };
        matchStats.set(row.matchId, stat);
      }
      stat.predictorPoints.push({ userId: row.userId, username: row.username, imageUrl: row.imageUrl, points: row.points });
      stat.predictions.push({
        userId: row.userId,
        username: row.username,
        imageUrl: row.imageUrl,
        predHomeScore: row.predHomeScore,
        predAwayScore: row.predAwayScore,
      });
      if (row.predHomeScore === row.actualHomeScore && row.predAwayScore === row.actualAwayScore) {
        stat.perfectScorers.push({ userId: row.userId, username: row.username, imageUrl: row.imageUrl });
      }
      const predictedResult = Math.sign(row.predHomeScore - row.predAwayScore);
      const actualResult = Math.sign(row.actualHomeScore - row.actualAwayScore);
      if (predictedResult === actualResult) {
        stat.resultCount += 1;
      } else {
        stat.wrongPredictors.push({
          userId: row.userId,
          username: row.username,
          imageUrl: row.imageUrl,
          predHomeScore: row.predHomeScore,
          predAwayScore: row.predAwayScore,
        });
      }
    }

    // ── The Optimist: highest vs. lowest total predicted goals across played matches ──
    const actualTotalGoals = [...matchStats.values()].reduce((sum, m) => sum + m.homeScore + m.awayScore, 0);
    const predictedGoalsByUser = new Map<string, number>();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      if (!usersWithAllPredictions.has(row.userId)) continue;
      predictedGoalsByUser.set(
        row.userId,
        (predictedGoalsByUser.get(row.userId) ?? 0) + row.predHomeScore + row.predAwayScore
      );
    }

    if (predictedGoalsByUser.size > 0) {
      const maxPredicted = Math.max(...predictedGoalsByUser.values());
      if (maxPredicted > actualTotalGoals) {
        const minPredicted = Math.min(...predictedGoalsByUser.values());
        const highestPredictorGroup = [...predictedGoalsByUser.entries()]
          .filter(([, total]) => total === maxPredicted)
          .map(([userId]) => ({ userId, ...userInfo.get(userId)! }))
          .sort((a, b) => a.username.localeCompare(b.username));
        const lowestPredictorGroup = [...predictedGoalsByUser.entries()]
          .filter(([, total]) => total === minPredicted)
          .map(([userId]) => ({ userId, ...userInfo.get(userId)! }))
          .sort((a, b) => a.username.localeCompare(b.username));

        const lowestSentence =
          minPredicted < actualTotalGoals
            ? lang === 'no'
              ? ` ${formatUserList(lowestPredictorGroup.map(u => u.username), lang)} har i midlertiden tippet at det bare skulle vært scoret ${minPredicted} mål så langt.`
              : ` Meanwhile ${formatUserList(lowestPredictorGroup.map(u => u.username), lang)} ${lowestPredictorGroup.length === 1 ? 'has' : 'have'} predicted that only ${minPredicted} ${minPredicted === 1 ? 'goal' : 'goals'} should've been scored by now.`
            : '';

        theOptimistCard = {
          id: 'theOptimist',
          title: lang === 'no' ? 'Optimisten' : 'The Optimist',
          statistic:
            (lang === 'no'
              ? `${formatUserList(highestPredictorGroup.map(u => u.username), lang)} har tippet at det totalt skulle vært scoret ${maxPredicted} mål på dette tidspunktet! Bare ${actualTotalGoals} mål har faktisk blitt scoret.`
              : `${formatUserList(highestPredictorGroup.map(u => u.username), lang)} ${highestPredictorGroup.length === 1 ? 'has' : 'have'} predicted that a total of ${maxPredicted} ${maxPredicted === 1 ? 'goal' : 'goals'} should have been scored by this point! Only ${actualTotalGoals} ${actualTotalGoals === 1 ? 'goal' : 'goals'} ${actualTotalGoals === 1 ? 'has' : 'have'} actually been scored.`) +
            lowestSentence,
          subjects: highestPredictorGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
          linkType: 'user',
        };
      }
    }

    let bestPredictionMatch: MatchStat | null = null;
    for (const stat of matchStats.values()) {
      if (stat.perfectScorers.length !== 1) continue;
      if (
        !bestPredictionMatch ||
        stat.resultCount < bestPredictionMatch.resultCount ||
        (stat.resultCount === bestPredictionMatch.resultCount &&
          (stat.scheduledAt?.getTime() ?? 0) < (bestPredictionMatch.scheduledAt?.getTime() ?? 0))
      ) {
        bestPredictionMatch = stat;
      }
    }

    let worstPredictionMatch: MatchStat | null = null;
    for (const stat of matchStats.values()) {
      if (stat.wrongPredictors.length === 0) continue;
      if (
        !worstPredictionMatch ||
        stat.wrongPredictors.length < worstPredictionMatch.wrongPredictors.length ||
        (stat.wrongPredictors.length === worstPredictionMatch.wrongPredictors.length &&
          (stat.scheduledAt?.getTime() ?? 0) < (worstPredictionMatch.scheduledAt?.getTime() ?? 0))
      ) {
        worstPredictionMatch = stat;
      }
    }

    let unexpectedMatch: MatchStat | null = null;
    let unexpectedMaxDeviation = -Infinity;
    for (const stat of matchStats.values()) {
      if (stat.resultCount !== 0 || stat.wrongPredictors.length === 0) continue;
      const actualDiff = stat.homeScore - stat.awayScore;
      const maxDeviation = Math.max(
        ...stat.wrongPredictors.map(p => Math.abs(p.predHomeScore - p.predAwayScore - actualDiff))
      );
      if (
        !unexpectedMatch ||
        maxDeviation > unexpectedMaxDeviation ||
        (maxDeviation === unexpectedMaxDeviation &&
          (stat.scheduledAt?.getTime() ?? 0) < (unexpectedMatch.scheduledAt?.getTime() ?? 0))
      ) {
        unexpectedMatch = stat;
        unexpectedMaxDeviation = maxDeviation;
      }
    }

    // Total points awarded across all predictors for this match from the correct-result and
    // exact-score categories only (resultCount already includes perfect scorers as a subset).
    const predictablePoints = (stat: MatchStat) =>
      stat.resultCount * scoringConfig.correct_result + stat.perfectScorers.length * scoringConfig.exact_score;

    let mostPredictableMatch: MatchStat | null = null;
    for (const stat of matchStats.values()) {
      if (stat.resultCount === 0) continue;
      if (stat.predictorPoints.length === 0 || stat.predictorPoints.some(p => p.points === null)) continue;
      if (
        !mostPredictableMatch ||
        predictablePoints(stat) > predictablePoints(mostPredictableMatch) ||
        (predictablePoints(stat) === predictablePoints(mostPredictableMatch) &&
          (stat.scheduledAt?.getTime() ?? 0) < (mostPredictableMatch.scheduledAt?.getTime() ?? 0))
      ) {
        mostPredictableMatch = stat;
      }
    }

    // ── Most contrasting prediction: biggest gap between two users' predicted goal differences ──
    let contrastMatch: MatchStat | null = null;
    let contrastGap = -Infinity;
    for (const stat of matchStats.values()) {
      if (stat.predictions.length < 2) continue;
      const diffs = stat.predictions.map(p => p.predHomeScore - p.predAwayScore);
      const gap = Math.max(...diffs) - Math.min(...diffs);
      if (gap <= 0) continue;
      if (
        !contrastMatch ||
        gap > contrastGap ||
        (gap === contrastGap && (stat.scheduledAt?.getTime() ?? 0) < (contrastMatch.scheduledAt?.getTime() ?? 0))
      ) {
        contrastMatch = stat;
        contrastGap = gap;
      }
    }

    // ── Swing and a Miss: prediction furthest from actual goal difference ──
    interface SwingAndAMissData {
      matchId: string;
      homeTeamId: string | null;
      awayTeamId: string | null;
      homeScore: number;
      awayScore: number;
      predHomeScore: number;
      predAwayScore: number;
      deviation: number;
      users: { userId: string; username: string; imageUrl: string | null }[];
    }

    const swingPredictionGroups = new Map<string, SwingAndAMissData>();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      const actualGD = row.actualHomeScore - row.actualAwayScore;
      const predGD = row.predHomeScore - row.predAwayScore;
      const deviation = Math.abs(actualGD - predGD);
      const key = `${row.matchId}|${row.predHomeScore}|${row.predAwayScore}`;
      if (!swingPredictionGroups.has(key)) {
        swingPredictionGroups.set(key, {
          matchId: row.matchId,
          homeTeamId: row.homeTeamId,
          awayTeamId: row.awayTeamId,
          homeScore: row.actualHomeScore,
          awayScore: row.actualAwayScore,
          predHomeScore: row.predHomeScore,
          predAwayScore: row.predAwayScore,
          deviation,
          users: [],
        });
      }
      swingPredictionGroups.get(key)!.users.push({ userId: row.userId, username: row.username, imageUrl: row.imageUrl });
    }

    let swingAndAMissData: SwingAndAMissData | null = null;
    if (swingPredictionGroups.size > 0) {
      const maxSwingDeviation = Math.max(...[...swingPredictionGroups.values()].map(g => g.deviation));
      if (maxSwingDeviation > 0) {
        const topGroups = [...swingPredictionGroups.values()].filter(g => g.deviation === maxSwingDeviation);
        swingAndAMissData = topGroups.reduce((best, g) => (g.users.length > best.users.length ? g : best));
        swingAndAMissData.users.sort((a, b) => a.username.localeCompare(b.username));
      }
    }

    const neededTeamIds = new Set<string>();
    for (const m of [bestPredictionMatch, worstPredictionMatch, unexpectedMatch, mostPredictableMatch, contrastMatch, swingAndAMissData]) {
      if (m?.homeTeamId) neededTeamIds.add(m.homeTeamId);
      if (m?.awayTeamId) neededTeamIds.add(m.awayTeamId);
    }
    const teamRows =
      neededTeamIds.size > 0 ? await db.select().from(teams).where(inArray(teams.id, [...neededTeamIds])) : [];
    const teamNameMap = new Map(teamRows.map(t => [t.id, t.name]));
    const teamImageMap = new Map(teamRows.map(t => [t.id, t.imageUrl]));
    const teamName = (teamId: string | null) => (teamId ? teamNameMap.get(teamId) ?? 'Unknown' : 'Unknown');

    if (bestPredictionMatch) {
      const homeTeamName = teamName(bestPredictionMatch.homeTeamId);
      const awayTeamName = teamName(bestPredictionMatch.awayTeamId);
      const winner = bestPredictionMatch.perfectScorers[0];
      const resultText =
        lang === 'no'
          ? bestPredictionMatch.resultCount === 1
            ? 'Ingen andre fikk i det hele tatt riktig resultat!'
            : `Bare ${bestPredictionMatch.resultCount} spillere fikk i det hele tatt riktig resultat!`
          : bestPredictionMatch.resultCount === 1
            ? 'No one else even got the correct result!'
            : `Only ${bestPredictionMatch.resultCount} players even got the result right!`;

      bestPredictionCard = {
        id: 'bestPrediction',
        title: lang === 'no' ? 'Synsk' : 'Best prediction',
        statistic:
          lang === 'no'
            ? `**${winner.username}** tippet eksakt resultat på ${homeTeamName} mot ${awayTeamName} (${bestPredictionMatch.homeScore}-${bestPredictionMatch.awayScore})! ${resultText}`
            : `**${winner.username}** got a perfect score on ${homeTeamName} vs ${awayTeamName} (${bestPredictionMatch.homeScore} - ${bestPredictionMatch.awayScore})! ${resultText}`,
        subjects: [{ type: 'user', id: winner.userId, name: winner.username, imageUrl: winner.imageUrl }],
        linkType: 'match',
        matchId: bestPredictionMatch.matchId,
      };
    }

    unluckyCard = {
      id: 'unlucky',
      title: lang === 'no' ? 'Uflaks' : 'Unlucky',
      statistic:
        unluckyGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(unluckyGroup.map(u => u.username), lang)} har vært bare ett mål unna å tippe eksakt resultat ${topUnluckyCount} ${topUnluckyCount === 1 ? 'gang' : 'ganger'}!` +
              (nextUnluckyGroup.length > 0
                ? ` ${nextUnluckyGroup.length === 1 ? 'Den' : 'De'} nest mest uheldige er ${formatUserList(nextUnluckyGroup.map(u => u.username), lang)} med ${nextUnluckyCount}.`
                : '')
            : `${formatUserList(unluckyGroup.map(u => u.username), lang)} ${unluckyGroup.length === 1 ? 'has' : 'have'} been one goal away from predicting a perfect score ${topUnluckyCount} ${topUnluckyCount === 1 ? 'time' : 'times'}!` +
              (nextUnluckyGroup.length > 0
                ? ` The next unluckiest ${nextUnluckyGroup.length === 1 ? 'is' : 'are'} ${formatUserList(nextUnluckyGroup.map(u => u.username), lang)} with ${nextUnluckyCount}.`
                : '')
          : lang === 'no'
            ? 'Ingen har vært ett mål fra et eksakt resultat ennå!'
            : 'No one has been one goal away from a perfect score yet!',
      subjects: unluckyGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
      linkType: 'user',
    };

    if (worstPredictionMatch) {
      const homeTeamName = teamName(worstPredictionMatch.homeTeamId);
      const awayTeamName = teamName(worstPredictionMatch.awayTeamId);

      const wrongGroups = new Map<string, typeof worstPredictionMatch.wrongPredictors>();
      for (const p of worstPredictionMatch.wrongPredictors) {
        const key = String(Math.sign(p.predHomeScore - p.predAwayScore));
        if (!wrongGroups.has(key)) wrongGroups.set(key, []);
        wrongGroups.get(key)!.push(p);
      }
      const sortedWrongGroups = [...wrongGroups.values()]
        .map(group => [...group].sort((a, b) => a.username.localeCompare(b.username)))
        .sort((a, b) => b.length - a.length || a[0].username.localeCompare(b[0].username));

      const wrongClauses = sortedWrongGroups.map(group => {
        const outcome = describeOutcome(homeTeamName, awayTeamName, group[0].predHomeScore, group[0].predAwayScore, lang);
        return lang === 'no'
          ? `${formatUserList(group.map(p => p.username), lang)} tippet ${outcome}`
          : `${formatUserList(group.map(p => p.username), lang)} predicted ${outcome}`;
      });
      const correctOutcome = describeOutcome(
        homeTeamName,
        awayTeamName,
        worstPredictionMatch.homeScore,
        worstPredictionMatch.awayScore,
        lang
      );

      const statistic =
        lang === 'no'
          ? `${wrongClauses.join('; ')}.` +
            (worstPredictionMatch.resultCount > 0 ? ` Alle andre tippet riktig: ${correctOutcome}.` : '')
          : `${wrongClauses.join('; ')}.` +
            (worstPredictionMatch.resultCount > 0 ? ` Everyone else correctly predicted ${correctOutcome}.` : '');

      worstPredictionCard = {
        id: 'worstPrediction',
        title: lang === 'no' ? 'Skivebom' : 'Worst prediction',
        statistic,
        subjects: sortedWrongGroups
          .flat()
          .map(p => ({ type: 'user' as const, id: p.userId, name: p.username, imageUrl: p.imageUrl })),
        linkType: 'match',
        matchId: worstPredictionMatch.matchId,
      };
    }

    if (unexpectedMatch) {
      const homeTeamName = teamName(unexpectedMatch.homeTeamId);
      const awayTeamName = teamName(unexpectedMatch.awayTeamId);
      const actualDiff = unexpectedMatch.homeScore - unexpectedMatch.awayScore;

      const deviationGroups = new Map<string, typeof unexpectedMatch.wrongPredictors>();
      for (const p of unexpectedMatch.wrongPredictors) {
        const deviation = Math.abs(p.predHomeScore - p.predAwayScore - actualDiff);
        if (deviation !== unexpectedMaxDeviation) continue;
        const key = `${p.predHomeScore}-${p.predAwayScore}`;
        if (!deviationGroups.has(key)) deviationGroups.set(key, []);
        deviationGroups.get(key)!.push(p);
      }
      let worstDeviationGroup = [...deviationGroups.values()][0];
      for (const group of deviationGroups.values()) {
        if (group.length > worstDeviationGroup.length) worstDeviationGroup = group;
      }
      worstDeviationGroup = [...worstDeviationGroup].sort((a, b) => a.username.localeCompare(b.username));

      const actualOutcome = describeOutcome(homeTeamName, awayTeamName, unexpectedMatch.homeScore, unexpectedMatch.awayScore, lang);
      const predictedOutcome = describeOutcome(
        homeTeamName,
        awayTeamName,
        worstDeviationGroup[0].predHomeScore,
        worstDeviationGroup[0].predAwayScore,
        lang
      );
      const namesText = formatUserList(worstDeviationGroup.map(p => p.username), lang);

      mostUnexpectedResultCard = {
        id: 'mostUnexpectedResult',
        title: lang === 'no' ? 'Sjokkresultat' : 'Most unexpected result',
        statistic:
          lang === 'no'
            ? `Ingen tippet ${actualOutcome}! ${namesText} tippet til og med ${predictedOutcome} (${worstDeviationGroup[0].predHomeScore}-${worstDeviationGroup[0].predAwayScore})!`
            : `No one predicted ${actualOutcome}! ${namesText} even predicted ${predictedOutcome} (${worstDeviationGroup[0].predHomeScore} - ${worstDeviationGroup[0].predAwayScore})!`,
        subjects: [unexpectedMatch.homeTeamId, unexpectedMatch.awayTeamId]
          .filter((teamId): teamId is string => teamId !== null)
          .map(teamId => ({ type: 'team' as const, id: teamId, name: teamName(teamId), imageUrl: teamImageMap.get(teamId) ?? null })),
        linkType: 'match',
        matchId: unexpectedMatch.matchId,
      };
    }

    if (mostPredictableMatch) {
      const homeTeamName = teamName(mostPredictableMatch.homeTeamId);
      const awayTeamName = teamName(mostPredictableMatch.awayTeamId);
      const resultCount = mostPredictableMatch.resultCount;
      const exactCount = mostPredictableMatch.perfectScorers.length;
      const scoredPoints = mostPredictableMatch.predictorPoints.map(p => p.points ?? 0);
      const avgPoints = (scoredPoints.reduce((sum, p) => sum + p, 0) / scoredPoints.length).toFixed(2);

      const zeroPointUsers = mostPredictableMatch.predictorPoints
        .filter(p => p.points === 0)
        .sort((a, b) => a.username.localeCompare(b.username));
      const onePointUsers = mostPredictableMatch.predictorPoints
        .filter(p => p.points === 1)
        .sort((a, b) => a.username.localeCompare(b.username));

      let appendText = '';
      if (zeroPointUsers.length > 0) {
        appendText =
          lang === 'no'
            ? ` Likevel sanket ${formatUserList(zeroPointUsers.map(u => u.username), lang)} 0 poeng.`
            : ` Still ${formatUserList(zeroPointUsers.map(u => u.username), lang)} earned 0 points.`;
      } else if (onePointUsers.length >= 1 && onePointUsers.length <= 4) {
        appendText =
          lang === 'no'
            ? ` Likevel sanket ${formatUserList(onePointUsers.map(u => u.username), lang)} bare 1 poeng.`
            : ` Still ${formatUserList(onePointUsers.map(u => u.username), lang)} earned only 1 point.`;
      }

      mostPredictableResultCard = {
        id: 'mostPredictableResult',
        title: lang === 'no' ? 'Forventet resultat' : 'The most expected result',
        statistic:
          (lang === 'no'
            ? `${homeTeamName} mot ${awayTeamName} (${mostPredictableMatch.homeScore}-${mostPredictableMatch.awayScore}) var det mest forutsigbare resultatet! Totalt tippet ${resultCount} ${resultCount === 1 ? 'spiller' : 'spillere'} riktig resultat, og ${exactCount} av dem tippet eksakt resultat! Hver spiller sanket i snitt ${avgPoints} poeng.`
            : `${homeTeamName} vs ${awayTeamName} (${mostPredictableMatch.homeScore} - ${mostPredictableMatch.awayScore}) was the most predictable outcome! A total of ${resultCount} ${resultCount === 1 ? 'user' : 'users'} predicted the correct result, and ${exactCount} of those predicted the exact score! Each user scored on average ${avgPoints} points.`) +
          appendText,
        subjects: [mostPredictableMatch.homeTeamId, mostPredictableMatch.awayTeamId]
          .filter((teamId): teamId is string => teamId !== null)
          .map(teamId => ({ type: 'team' as const, id: teamId, name: teamName(teamId), imageUrl: teamImageMap.get(teamId) ?? null })),
        linkType: 'match',
        matchId: mostPredictableMatch.matchId,
      };
    }

    if (contrastMatch) {
      const homeTeamName = teamName(contrastMatch.homeTeamId);
      const awayTeamName = teamName(contrastMatch.awayTeamId);
      const diffs = contrastMatch.predictions.map(p => p.predHomeScore - p.predAwayScore);
      const maxDiff = Math.max(...diffs);
      const minDiff = Math.min(...diffs);

      const highGroup = contrastMatch.predictions
        .filter(p => p.predHomeScore - p.predAwayScore === maxDiff)
        .sort((a, b) => a.username.localeCompare(b.username));
      const lowGroup = contrastMatch.predictions
        .filter(p => p.predHomeScore - p.predAwayScore === minDiff)
        .sort((a, b) => a.username.localeCompare(b.username));

      const describeGoalDiff = (diff: number) => {
        if (diff === 0) return lang === 'no' ? 'uavgjort' : 'a draw';
        const winnerName = diff > 0 ? homeTeamName : awayTeamName;
        const margin = Math.abs(diff);
        return lang === 'no'
          ? `${winnerName} vinne med ${margin} mål`
          : `${winnerName} to win by ${margin} ${margin === 1 ? 'goal' : 'goals'}`;
      };

      mostContrastingPredictionCard = {
        id: 'mostContrastingPrediction',
        title: lang === 'no' ? 'Natt Og Dag' : 'Most Contrasting Predictions',
        statistic:
          lang === 'no'
            ? `Det største spriket i tippingen så langt kom i kampen mellom ${homeTeamName} og ${awayTeamName}, hvor ${formatUserList(highGroup.map(u => u.username), lang)} tippet ${highGroup[0].predHomeScore}-${highGroup[0].predAwayScore} og ${formatUserList(lowGroup.map(u => u.username), lang)} tippet ${lowGroup[0].predHomeScore}-${lowGroup[0].predAwayScore}! Kampen endte til slutt med ${contrastMatch.homeScore}-${contrastMatch.awayScore}.`
            : `${homeTeamName} vs ${awayTeamName} (${contrastMatch.homeScore} - ${contrastMatch.awayScore}) caused the most contrasting predictions! ${formatUserList(highGroup.map(u => u.username), lang)} predicted ${describeGoalDiff(maxDiff)}, while ${formatUserList(lowGroup.map(u => u.username), lang)} predicted ${describeGoalDiff(minDiff)} — a ${contrastGap}-goal swing!`,
        subjects: [...highGroup, ...lowGroup].map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
        linkType: 'match',
        matchId: contrastMatch.matchId,
      };
    }

    if (swingAndAMissData) {
      const homeTeamName = teamName(swingAndAMissData.homeTeamId);
      const awayTeamName = teamName(swingAndAMissData.awayTeamId);
      const userNames = formatUserList(swingAndAMissData.users.map(u => u.username), lang);
      swingAndAMissCard = {
        id: 'swingAndAMiss',
        title: lang === 'no' ? 'Det var nesten da!' : 'Swing and a Miss',
        statistic:
          lang === 'no'
            ? `Kampen mellom ${homeTeamName} og ${awayTeamName} endte ${swingAndAMissData.homeScore} - ${swingAndAMissData.awayScore}, bare litt annerledes enn hva ${userNames} tippet, som trodde kampen skulle ende ${swingAndAMissData.predHomeScore} - ${swingAndAMissData.predAwayScore}.`
            : `The match between ${homeTeamName} and ${awayTeamName} ended ${swingAndAMissData.homeScore} - ${swingAndAMissData.awayScore}, just a little different from what ${userNames} predicted, who thought the match would end ${swingAndAMissData.predHomeScore} - ${swingAndAMissData.predAwayScore}.`,
        subjects: swingAndAMissData.users.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
        linkType: 'match',
        matchId: swingAndAMissData.matchId,
      };
    }

    hitOrMissCard = {
      id: 'hitOrMiss',
      title: 'Hit or Miss',
      statistic:
        hitOrMissGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(hitOrMissGroup.map(u => u.username), lang)} har "bare" tippet korrekt resultat ${hitOrMissGroup[0].correctResults} ${hitOrMissGroup[0].correctResults === 1 ? 'gang' : 'ganger'}, men ${hitOrMissGroup[0].exactScores} av de har vært fulltreffere!`
            : `${hitOrMissGroup[0].exactScores} out of ${formatUserList(hitOrMissGroup.map(u => u.username), lang)}'s ${hitOrMissGroup[0].correctResults} have been perfect predictions!`
          : lang === 'no'
            ? 'Ingen har tippet minst to perfekte resultater ennå!'
            : 'No one has predicted at least two perfect scores yet!',
      subjects: hitOrMissGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
      linkType: 'user',
    };

    const closeButNoCigarVerb = closeButNoCigarGroup.length === 1 ? 'has' : 'have';
    const closeButNoCigarTail =
      closeButNoCigarGroup.length > 0 && closeButNoCigarGroup[0].exactScores > 0
        ? `only managed ${closeButNoCigarGroup[0].exactScores} exact prediction${closeButNoCigarGroup[0].exactScores === 1 ? '' : 's'}!`
        : 'never got an exact score correct!';
    const closeButNoCigarTailNo =
      closeButNoCigarGroup.length > 0 && closeButNoCigarGroup[0].exactScores > 0
        ? `har bare truffet eksakt resultat ${closeButNoCigarGroup[0].exactScores} ${closeButNoCigarGroup[0].exactScores === 1 ? 'gang' : 'ganger'}!`
        : 'har aldri truffet eksakt resultat!';

    closeButNoCigarCard = {
      id: 'closeButNoCigar',
      title: 'Slow and Steady',
      statistic:
        closeButNoCigarGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(closeButNoCigarGroup.map(u => u.username), lang)} har tippet riktig resultat ${closeButNoCigarGroup[0].correctResults} ${closeButNoCigarGroup[0].correctResults === 1 ? 'gang' : 'ganger'}, men ${closeButNoCigarTailNo}`
            : `${formatUserList(closeButNoCigarGroup.map(u => u.username), lang)} ${closeButNoCigarVerb} predicted the correct result ${closeButNoCigarGroup[0].correctResults} times, but ${closeButNoCigarVerb} ${closeButNoCigarTail}`
          : lang === 'no'
            ? 'Ingen har tippet riktig resultat ennå!'
            : 'No one has predicted a correct result yet!',
      subjects: closeButNoCigarGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
      linkType: 'user',
    };

    bestFormCard = {
      id: 'bestForm',
      title: lang === 'no' ? 'I fyr og flamme 🔥' : 'Best form',
      statistic:
        bestFormGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(bestFormGroup.map(u => u.username), lang)} har sanket ${bestFormGroup[0].points} poeng de siste 5 kampene!`
            : `${formatUserList(bestFormGroup.map(u => u.username), lang)} ${bestFormGroup.length === 1 ? 'has' : 'have'} gained ${bestFormGroup[0].points} points in the last 5 matches!`
          : lang === 'no'
            ? 'Ingen kamper er fullført ennå!'
            : 'No matches have been completed yet!',
      subjects: bestFormGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
      linkType: 'user',
    };

    if (worstFormGroup.length > 0) {
      worstFormCard = {
        id: 'worstForm',
        title: lang === 'no' ? 'Send Hjelp' : 'Worst form',
        statistic:
          lang === 'no'
            ? `${formatUserList(worstFormGroup.map(u => u.username), lang)} har gått ${worstFormGroup[0].drought} kamper på rad uten å sanke et eneste poeng!`
            : `${formatUserList(worstFormGroup.map(u => u.username), lang)} ${worstFormGroup.length === 1 ? 'has' : 'have'} gone ${worstFormGroup[0].drought} matches without gaining a single point!`,
        subjects: worstFormGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
        linkType: 'user',
      };
    }

    // ── The Brautometer: average/highest/lowest predicted Haaland tournament goals ──
    const [haalandPlayer] = await db
      .select()
      .from(players)
      .where(
        and(
          eq(players.tournamentId, competition.tournamentId),
          ilike(players.name, 'erling haaland')
        )
      );

    const [haalandQuestion] = await db
      .select()
      .from(bonusQuestions)
      .where(
        and(
          eq(bonusQuestions.tournamentId, competition.tournamentId),
          eq(bonusQuestions.answerType, 'number'),
          ilike(bonusQuestions.question, '%haaland%')
        )
      );

    if (haalandQuestion) {
      const haalandAnswerRows = await db
        .select({
          userId: bonusAnswers.userId,
          username: users.username,
          imageUrl: users.imageUrl,
          answer: bonusAnswers.answer,
        })
        .from(bonusAnswers)
        .innerJoin(users, eq(bonusAnswers.userId, users.id))
        .where(
          and(
            eq(bonusAnswers.competitionId, id),
            eq(bonusAnswers.questionId, haalandQuestion.id),
            eq(users.isLeaderboardUser, false),
            eq(users.isComparisonUser, false)
          )
        );

      const haalandPredictions = haalandAnswerRows
        .filter(row => !activeStatUserIds || activeStatUserIds.has(row.userId))
        .map(row => ({ userId: row.userId, username: row.username, imageUrl: row.imageUrl, goals: Number(row.answer) }))
        .filter(row => Number.isFinite(row.goals));

      if (haalandPredictions.length > 0) {
        const average = haalandPredictions.reduce((sum, p) => sum + p.goals, 0) / haalandPredictions.length;
        const maxGoals = Math.max(...haalandPredictions.map(p => p.goals));
        const minGoals = Math.min(...haalandPredictions.map(p => p.goals));
        const mostFaithGroup = haalandPredictions
          .filter(p => p.goals === maxGoals)
          .sort((a, b) => a.username.localeCompare(b.username));
        const leastFaithGroup = haalandPredictions
          .filter(p => p.goals === minGoals)
          .sort((a, b) => a.username.localeCompare(b.username));

        brautometerCard = {
          id: 'brautometer',
          title: lang === 'no' ? 'Brautometeret' : 'The Brautometer',
          statistic:
            lang === 'no'
              ? `Deltakerne har i gjennomsnitt tippet at Haaland kommer til å score ${average.toFixed(2)} mål i turneringen. ${formatUserList(mostFaithGroup.map(u => u.username), lang)} har mest tro og tror han kommer til å score utrolige ${maxGoals} mål! Mens ${formatUserList(leastFaithGroup.map(u => u.username), lang)} tror han bare kommer til å score ${minGoals} mål.`
              : `The participants have on average predicted that Haaland will score ${average.toFixed(2)} goals in the tournament. ${formatUserList(mostFaithGroup.map(u => u.username), lang)} ${mostFaithGroup.length === 1 ? 'has' : 'have'} the most faith and ${mostFaithGroup.length === 1 ? 'believes' : 'believe'} he will score an incredible ${maxGoals} goals! While ${formatUserList(leastFaithGroup.map(u => u.username), lang)} only ${leastFaithGroup.length === 1 ? 'believes' : 'believe'} he will score ${minGoals} goals.`,
          subjects: mostFaithGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
          linkType: 'userBonus',
          iconImageUrl: '/haaland.jpg',
        };

        if (haalandPlayer && haalandPlayer.gamesPlayed >= 1) {
          const goals = haalandPlayer.goalsScored;
          const games = haalandPlayer.gamesPlayed;
          brautometerCard.statistic +=
            lang === 'no'
              ? ` Haaland har så langt scoret ${goals} ${goals === 1 ? 'mål' : 'mål'} på ${games} ${games === 1 ? 'kamp' : 'kamper'}.`
              : ` Haaland has so far scored ${goals} ${goals === 1 ? 'goal' : 'goals'} in ${games} ${games === 1 ? 'game' : 'games'}.`;
        }
      }
    }

    // ── The Traitor: user(s) who predicted Norway eliminated earliest ──
    // Traces each user's bracket predictions by checking which stages Norway appears
    // in as progressingTeamId. If Norway never appears as winner in any stage, the
    // user is considered to have predicted group-stage elimination.
    if (norwayTeam) {
      const norwayId = norwayTeam.id;
      const KNOCKOUT_STAGES_ORDERED = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final'];
      const STAGE_RANK_TRAITOR: Record<string, number> = {
        group: 0, round_of_16: 2, quarter_final: 3, semi_final: 4, final: 5, winner: 6,
      };

      const traitorBpRows = await db
        .select({ userId: bracketPredictions.userId, predictions: bracketPredictions.predictions })
        .from(bracketPredictions)
        .where(eq(bracketPredictions.competitionId, id));

      const userEliminations = new Map<string, { eliminatedAt: string; rank: number }>();

      for (const bp of traitorBpRows) {
        if (activeStatUserIds && !activeStatUserIds.has(bp.userId)) continue;
        if (!userInfo.has(bp.userId)) continue;

        const bpPreds = bp.predictions as BracketPredictions;

        // Find the latest knockout stage where Norway appears as progressingTeamId
        let lastSurvivedStageIdx = -1;
        for (let si = 0; si < KNOCKOUT_STAGES_ORDERED.length; si++) {
          const stage = KNOCKOUT_STAGES_ORDERED[si];
          const norwayWon = Object.entries(bpPreds).some(
            ([key, pred]) => key.startsWith(`${stage}_`) && pred.progressingTeamId === norwayId,
          );
          if (norwayWon) lastSurvivedStageIdx = si;
        }

        let eliminatedAt: string;
        if (lastSurvivedStageIdx === -1) {
          eliminatedAt = 'group';
        } else if (lastSurvivedStageIdx === KNOCKOUT_STAGES_ORDERED.length - 1) {
          eliminatedAt = 'winner';
        } else {
          eliminatedAt = KNOCKOUT_STAGES_ORDERED[lastSurvivedStageIdx + 1];
        }

        userEliminations.set(bp.userId, { eliminatedAt, rank: STAGE_RANK_TRAITOR[eliminatedAt] ?? 7 });
      }

      if (userEliminations.size > 0) {
        const minRank = Math.min(...[...userEliminations.values()].map(e => e.rank));

        if (minRank <= STAGE_RANK_TRAITOR['round_of_16']) {
          const traitors = [...userEliminations.entries()]
            .filter(([, e]) => e.rank === minRank)
            .map(([userId]) => ({ userId, ...userInfo.get(userId)! }))
            .sort((a, b) => a.username.localeCompare(b.username));

          const minStage = Object.keys(STAGE_RANK_TRAITOR).find(s => STAGE_RANK_TRAITOR[s] === minRank) ?? 'group';
          const stageLabelMap: Record<string, { no: string; en: string }> = {
            group: { no: 'gruppespillet', en: 'the group stage' },
            round_of_16: { no: 'runde 16', en: 'the round of 16' },
          };
          const stageLabelNo = stageLabelMap[minStage]?.no ?? minStage;
          const stageLabelEn = stageLabelMap[minStage]?.en ?? minStage;
          const traitorNames = formatUserList(traitors.map(u => u.username), lang);

          traitorCard = {
            id: 'traitor',
            title: lang === 'no' ? 'Landssvikeren' : 'The Traitor',
            statistic:
              lang === 'no'
                ? `${traitorNames} trodde faktisk at Norge ville bli slått ut allerede i ${stageLabelNo}!`
                : `${traitorNames} actually thought that Norway would be knocked out as early as ${stageLabelEn}!`,
            subjects: traitors.map(u => ({
              type: 'user' as const,
              id: u.userId,
              name: u.username,
              imageUrl: u.imageUrl,
            })),
            linkType: 'user',
            overlayImageUrl: norwayTeam.imageUrl ?? null,
          };
        }
      }
    }

    const cards = [
      theLeaderCard,
      bottomOfTheLeagueCard,
      bestPredictionCard,
      worstPredictionCard,
      bestFormCard,
      worstFormCard,
      unluckyCard,
      thePatriotCard,
      hitOrMissCard,
      closeButNoCigarCard,
      groupStageGuruCard,
      theOptimistCard,
      mostContrastingPredictionCard,
      mostUnexpectedResultCard,
      mostPredictableResultCard,
      swingAndAMissCard,
      traitorCard,
      brautometerCard,
    ].filter((card): card is UserStatCardData => card !== null);

    res.json(cards);
  } catch (err) {
    console.error('Get user stats error:', err);
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

router.get('/:id/leaderboard/events', requireAuth, async (req, res) => {
  const { id } = req.params;
  const user = res.locals.user;

  const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
  if (!competition) return res.status(404).json({ error: 'Competition not found' });

  if (!user.isAdmin) {
    const [membership] = await db
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
    if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const ping = setInterval(() => res.write(': ping\n\n'), 30_000);
  subscribeLeaderboard(id, res);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribeLeaderboard(id, res);
  });
});

router.get('/:id/my-status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    const [membership] = await db
      .select({
        groupStageLocked: competitionMembers.groupStageLocked,
        knockoutCompleteSeen: competitionMembers.knockoutCompleteSeen,
        lateAdditionWindowEndsAt: competitionMembers.lateAdditionWindowEndsAt,
      })
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));

    res.json({
      groupStageLocked: membership?.groupStageLocked ?? false,
      knockoutCompleteSeen: membership?.knockoutCompleteSeen ?? false,
      lateAdditionWindowEndsAt: membership?.lateAdditionWindowEndsAt?.toISOString() ?? null,
    });
  } catch (err) {
    console.error('Get my-status error:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

router.post('/:id/lock-group-stage', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    const [membership] = await db
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));

    if (membership) {
      await db
        .update(competitionMembers)
        .set({ groupStageLocked: true })
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
    }

    res.json({ groupStageLocked: true });
  } catch (err) {
    console.error('Lock group stage error:', err);
    res.status(500).json({ error: 'Failed to lock group stage' });
  }
});

router.post('/:id/acknowledge-knockout', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    await db
      .update(competitionMembers)
      .set({ knockoutCompleteSeen: true })
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));

    res.json({ ok: true });
  } catch (err) {
    console.error('Acknowledge knockout error:', err);
    res.status(500).json({ error: 'Failed to acknowledge' });
  }
});

router.get('/:id/predictions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const preds = await db
      .select()
      .from(predictions)
      .where(and(eq(predictions.competitionId, id), eq(predictions.userId, user.id)));

    res.json(preds);
  } catch (err) {
    console.error('Get predictions error:', err);
    res.status(500).json({ error: 'Failed to fetch predictions' });
  }
});

router.post('/:id/predictions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (user.isLeaderboardUser) {
      return res.status(403).json({ error: 'Leaderboard users cannot make predictions' });
    }

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    let membership: typeof competitionMembers.$inferSelect | undefined;
    if (!user.isAdmin) {
      const [mem] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!mem) return res.status(403).json({ error: 'Not a member of this competition' });
      membership = mem;
    }

    const isLateAdditionMember = membership?.lateAdditionWindowEndsAt != null;

    if (isLateAdditionMember) {
      // Late addition users: check 24h window instead of competition deadline
      if (membership!.lateAdditionWindowEndsAt && new Date() > new Date(membership!.lateAdditionWindowEndsAt)) {
        return res.status(400).json({ error: 'Your 24-hour prediction window has expired' });
      }
    } else if (!user.isComparisonUser && competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
      return res.status(400).json({ error: 'Prediction deadline has passed' });
    }

    const result = CreatePredictionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { matchId, homeScore, awayScore, progressingTeamId } = result.data;

    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.tournamentId !== competition.tournamentId) {
      return res.status(400).json({ error: "Match does not belong to this competition's tournament" });
    }

    // Late addition users cannot predict on matches that already have a result
    if (isLateAdditionMember && match.status === 'completed') {
      return res.status(400).json({ error: 'Late addition users cannot predict on matches that already have a result' });
    }

    // Late addition users cannot predict on matches where kickoff time has already passed
    if (isLateAdditionMember && match.scheduledAt && new Date() > new Date(match.scheduledAt)) {
      return res.status(400).json({ error: 'Cannot predict on a match after kickoff time' });
    }

    if (match.stage === 'group' && !user.isAdmin && !user.isComparisonUser) {
      const mem = membership ?? await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)))
        .then(r => r[0]);
      if (mem?.groupStageLocked) {
        const [bracketPred] = await db
          .select()
          .from(bracketPredictions)
          .where(and(eq(bracketPredictions.competitionId, id), eq(bracketPredictions.userId, user.id)));
        if (bracketPred && Object.keys(bracketPred.predictions ?? {}).length > 0) {
          return res.status(400).json({ error: 'Group stage predictions are locked' });
        }
      }
    }

    const [existing] = await db
      .select()
      .from(predictions)
      .where(
        and(
          eq(predictions.competitionId, id),
          eq(predictions.userId, user.id),
          eq(predictions.matchId, matchId)
        )
      );

    if (existing) {
      const [updated] = await db
        .update(predictions)
        .set({ homeScore, awayScore, progressingTeamId: progressingTeamId ?? null })
        .where(eq(predictions.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const predId = generateId(15);
    const [created] = await db
      .insert(predictions)
      .values({
        id: predId,
        competitionId: id,
        userId: user.id,
        matchId,
        homeScore,
        awayScore,
        progressingTeamId: progressingTeamId ?? null,
      })
      .returning();
    return res.status(201).json(created);
  } catch (err) {
    console.error('Save prediction error:', err);
    res.status(500).json({ error: 'Failed to save prediction' });
  }
});

router.delete('/:id/predictions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    await db
      .delete(predictions)
      .where(and(eq(predictions.competitionId, id), eq(predictions.userId, user.id)));

    await db
      .delete(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, id), eq(bracketPredictions.userId, user.id)));

    await db
      .update(competitionMembers)
      .set({ groupStageLocked: false, groupDisciplinaryChoices: {}, luckyLoserChoices: {} })
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));

    res.status(204).send();
  } catch (err) {
    console.error('Delete predictions error:', err);
    res.status(500).json({ error: 'Failed to delete predictions' });
  }
});

router.get('/:id/bracket-predictions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [row] = await db
      .select()
      .from(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, id), eq(bracketPredictions.userId, user.id)));

    res.json(row?.predictions ?? {});
  } catch (err) {
    console.error('Get bracket predictions error:', err);
    res.status(500).json({ error: 'Failed to fetch bracket predictions' });
  }
});

router.post('/:id/bracket-predictions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (user.isLeaderboardUser) {
      return res.status(403).json({ error: 'Leaderboard users cannot make predictions' });
    }

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    let bpMembership: typeof competitionMembers.$inferSelect | undefined;
    if (!user.isAdmin) {
      const [mem] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!mem) return res.status(403).json({ error: 'Not a member of this competition' });
      bpMembership = mem;
    }

    const isBpLateAdditionMember = bpMembership?.lateAdditionWindowEndsAt != null;

    if (isBpLateAdditionMember) {
      if (bpMembership!.lateAdditionWindowEndsAt && new Date() > new Date(bpMembership!.lateAdditionWindowEndsAt)) {
        return res.status(400).json({ error: 'Your 24-hour prediction window has expired' });
      }
    } else if (!user.isComparisonUser && competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
      return res.status(400).json({ error: 'Prediction deadline has passed' });
    }

    const result = SaveBracketPredictionsSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }

    await db
      .insert(bracketPredictions)
      .values({
        competitionId: id,
        userId: user.id,
        predictions: result.data.predictions,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [bracketPredictions.competitionId, bracketPredictions.userId],
        set: { predictions: result.data.predictions, updatedAt: new Date() },
      });

    // Recalculate scores so knockout tie / progresses points reflect the new predictions
    recalculateAllScoresForTournament(competition.tournamentId).catch(err =>
      console.error('Scoring recalculate error (bracket save):', err),
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Save bracket predictions error:', err);
    res.status(500).json({ error: 'Failed to save bracket predictions' });
  }
});

// ── View another member's predictions ─────────────────────────────────────────

router.get('/:id/predictions/:userId', requireAuth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const viewer = res.locals.user;

    if (!viewer.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, viewer.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [targetUser] = await db.select({ username: users.username, imageUrl: users.imageUrl }).from(users).where(eq(users.id, userId));
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const preds = await db
      .select()
      .from(predictions)
      .where(and(eq(predictions.competitionId, id), eq(predictions.userId, userId)));

    res.json({ predictions: preds, username: targetUser.username, imageUrl: targetUser.imageUrl ?? null });
  } catch (err) {
    console.error('Get user predictions error:', err);
    res.status(500).json({ error: 'Failed to fetch predictions' });
  }
});

router.get('/:id/bracket-predictions/:userId', requireAuth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const viewer = res.locals.user;

    if (!viewer.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, viewer.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [row] = await db
      .select()
      .from(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, id), eq(bracketPredictions.userId, userId)));

    res.json(row?.predictions ?? {});
  } catch (err) {
    console.error('Get user bracket predictions error:', err);
    res.status(500).json({ error: 'Failed to fetch bracket predictions' });
  }
});

router.get('/:id/tiebreak-choices/:userId', requireAuth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const viewer = res.locals.user;

    if (!viewer.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, viewer.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [targetMembership] = await db
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, userId)));

    res.json({
      groupChoices: targetMembership?.groupDisciplinaryChoices ?? {},
      luckyLoserChoices: targetMembership?.luckyLoserChoices ?? {},
    });
  } catch (err) {
    console.error('Get user tiebreak choices error:', err);
    res.status(500).json({ error: 'Failed to fetch tiebreak choices' });
  }
});

// ── Tiebreaker choices ────────────────────────────────────────────────────────

router.get('/:id/tiebreak-choices', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
      return res.json({
        groupChoices: membership.groupDisciplinaryChoices ?? {},
        luckyLoserChoices: membership.luckyLoserChoices ?? {},
      });
    }

    return res.json({ groupChoices: {}, luckyLoserChoices: {} });
  } catch (err) {
    console.error('Get tiebreak choices error:', err);
    res.status(500).json({ error: 'Failed to fetch tiebreak choices' });
  }
});

router.post('/:id/tiebreak-choices', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    const [membership] = await db
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
    if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });

    const { groupChoices, luckyLoserChoices } = req.body;
    const updates: Record<string, unknown> = {};
    if (groupChoices !== undefined) updates.groupDisciplinaryChoices = groupChoices;
    if (luckyLoserChoices !== undefined) updates.luckyLoserChoices = luckyLoserChoices;

    if (Object.keys(updates).length > 0) {
      await db
        .update(competitionMembers)
        .set(updates)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Save tiebreak choices error:', err);
    res.status(500).json({ error: 'Failed to save tiebreak choices' });
  }
});

// ── Bonus questions (read-only via competition — questions live on tournament) ─

router.get('/:id/bonus-questions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const questions = await db
      .select()
      .from(bonusQuestions)
      .where(eq(bonusQuestions.tournamentId, competition.tournamentId));
    res.json(questions);
  } catch (err) {
    console.error('Get bonus questions error:', err);
    res.status(500).json({ error: 'Failed to fetch bonus questions' });
  }
});

router.get('/:id/bonus-answers', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const answers = await db
      .select()
      .from(bonusAnswers)
      .where(and(eq(bonusAnswers.competitionId, id), eq(bonusAnswers.userId, user.id)));
    res.json(answers);
  } catch (err) {
    console.error('Get bonus answers error:', err);
    res.status(500).json({ error: 'Failed to fetch bonus answers' });
  }
});

router.get('/:id/bonus-answers/:userId', requireAuth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const viewer = res.locals.user;

    if (!viewer.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, viewer.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const answers = await db
      .select()
      .from(bonusAnswers)
      .where(and(eq(bonusAnswers.competitionId, id), eq(bonusAnswers.userId, userId)));
    res.json(answers);
  } catch (err) {
    console.error('Get user bonus answers error:', err);
    res.status(500).json({ error: 'Failed to fetch bonus answers' });
  }
});

router.post('/:id/bonus-answers', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;

    if (user.isLeaderboardUser) {
      return res.status(403).json({ error: 'Leaderboard users cannot submit bonus answers' });
    }

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    let baMembership: typeof competitionMembers.$inferSelect | undefined;
    if (!user.isAdmin) {
      const [mem] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!mem) return res.status(403).json({ error: 'Not a member of this competition' });
      baMembership = mem;
    }

    const isBaLateAdditionMember = baMembership?.lateAdditionWindowEndsAt != null;
    if (isBaLateAdditionMember) {
      if (new Date() > new Date(baMembership!.lateAdditionWindowEndsAt!)) {
        return res.status(400).json({ error: 'Your 24-hour prediction window has expired' });
      }
    } else if (!user.isComparisonUser && competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
      return res.status(400).json({ error: 'Prediction deadline has passed' });
    }

    const result = SaveBonusAnswerSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { questionId, answer } = result.data;

    const [question] = await db
      .select()
      .from(bonusQuestions)
      .where(and(eq(bonusQuestions.id, questionId), eq(bonusQuestions.tournamentId, competition.tournamentId)));
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const [existing] = await db
      .select()
      .from(bonusAnswers)
      .where(and(
        eq(bonusAnswers.questionId, questionId),
        eq(bonusAnswers.userId, user.id),
        eq(bonusAnswers.competitionId, id),
      ));

    if (existing) {
      const [updated] = await db
        .update(bonusAnswers)
        .set({ answer })
        .where(eq(bonusAnswers.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const aid = generateId(15);
    const [created] = await db
      .insert(bonusAnswers)
      .values({ id: aid, questionId, competitionId: id, userId: user.id, answer })
      .returning();
    return res.status(201).json(created);
  } catch (err) {
    console.error('Save bonus answer error:', err);
    res.status(500).json({ error: 'Failed to save bonus answer' });
  }
});

// ── Admin: copy comparison user predictions across same-tournament competitions ──

router.post('/admin/copy-comparison-predictions', requireAdmin, async (req, res) => {
  try {
    const comparisonUsers = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.isComparisonUser, true));

    const report: Array<{
      username: string;
      tournament: string;
      source: string;
      targets: string[];
      membersAdded: string[];
      matchPredsCopied: number;
      bracketCopied: boolean;
      bonusAnswersCopied: number;
    }> = [];

    const affectedTournamentIds = new Set<string>();

    for (const compUser of comparisonUsers) {
      // Find competitions where this user has predictions (these are the potential sources)
      const sourceCandidates = await db
        .select({
          competitionId: predictions.competitionId,
          competitionName: competitions.name,
          tournamentId: competitions.tournamentId,
          predCount: predictions.id, // used just to count below
        })
        .from(predictions)
        .innerJoin(competitions, eq(competitions.id, predictions.competitionId))
        .where(eq(predictions.userId, compUser.id));

      if (sourceCandidates.length === 0) continue;

      // Group by tournament, pick the competition with most predictions as source
      const byTournament = new Map<string, { competitionId: string; competitionName: string; count: number }>();
      for (const row of sourceCandidates) {
        const existing = byTournament.get(row.tournamentId);
        if (!existing) {
          byTournament.set(row.tournamentId, { competitionId: row.competitionId, competitionName: row.competitionName, count: 1 });
        } else {
          existing.count += 1;
        }
      }

      for (const [tournamentId, source] of byTournament) {
        // Find ALL competitions for this tournament (not just ones user is a member of)
        const allCompsForTournament = await db
          .select({ id: competitions.id, name: competitions.name })
          .from(competitions)
          .where(eq(competitions.tournamentId, tournamentId));

        const targets = allCompsForTournament.filter(c => c.id !== source.competitionId);
        if (targets.length === 0) continue;

        // Fetch membership info for the source competition (for tiebreaker choices)
        const [sourceMembership] = await db
          .select({ groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices, luckyLoserChoices: competitionMembers.luckyLoserChoices })
          .from(competitionMembers)
          .where(and(eq(competitionMembers.competitionId, source.competitionId), eq(competitionMembers.userId, compUser.id)));

        const sourcePreds = await db
          .select()
          .from(predictions)
          .where(and(eq(predictions.competitionId, source.competitionId), eq(predictions.userId, compUser.id)));

        const [sourceBracket] = await db
          .select()
          .from(bracketPredictions)
          .where(and(
            eq(bracketPredictions.competitionId, source.competitionId),
            eq(bracketPredictions.userId, compUser.id),
          ));

        const sourceAnswers = await db
          .select()
          .from(bonusAnswers)
          .where(and(
            eq(bonusAnswers.competitionId, source.competitionId),
            eq(bonusAnswers.userId, compUser.id),
          ));

        const copiedTargetNames: string[] = [];
        const addedMemberNames: string[] = [];

        for (const target of targets) {
          // Ensure the user is a member of this competition (add if missing)
          const [existingMembership] = await db
            .select()
            .from(competitionMembers)
            .where(and(eq(competitionMembers.competitionId, target.id), eq(competitionMembers.userId, compUser.id)));

          if (!existingMembership) {
            await db.insert(competitionMembers).values({ competitionId: target.id, userId: compUser.id });
            addedMemberNames.push(target.name);
          }

          // Copy match predictions
          if (sourcePreds.length > 0) {
            await db.delete(predictions).where(and(
              eq(predictions.competitionId, target.id),
              eq(predictions.userId, compUser.id),
            ));
            await db.insert(predictions).values(
              sourcePreds.map(p => ({
                id: generateId(15),
                competitionId: target.id,
                userId: compUser.id,
                matchId: p.matchId,
                homeScore: p.homeScore,
                awayScore: p.awayScore,
                progressingTeamId: p.progressingTeamId,
                points: null,
              })),
            );
          }

          // Copy bracket predictions
          if (sourceBracket) {
            await db.insert(bracketPredictions)
              .values({
                competitionId: target.id,
                userId: compUser.id,
                predictions: sourceBracket.predictions,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [bracketPredictions.competitionId, bracketPredictions.userId],
                set: { predictions: sourceBracket.predictions, updatedAt: new Date() },
              });
          }

          // Copy bonus answers
          if (sourceAnswers.length > 0) {
            const questionIds = [...new Set(sourceAnswers.map(a => a.questionId))];
            const validQuestions = await db
              .select({ id: bonusQuestions.id })
              .from(bonusQuestions)
              .where(and(eq(bonusQuestions.tournamentId, tournamentId), inArray(bonusQuestions.id, questionIds)));
            const validQuestionIds = new Set(validQuestions.map(q => q.id));
            const answersToInsert = sourceAnswers.filter(a => validQuestionIds.has(a.questionId));
            if (answersToInsert.length > 0) {
              await db.delete(bonusAnswers).where(and(
                eq(bonusAnswers.competitionId, target.id),
                eq(bonusAnswers.userId, compUser.id),
              ));
              await db.insert(bonusAnswers).values(
                answersToInsert.map(a => ({
                  id: generateId(15),
                  questionId: a.questionId,
                  competitionId: target.id,
                  userId: compUser.id,
                  answer: a.answer,
                  points: null,
                })),
              );
            }
          }

          // Copy tiebreaker choices
          if (sourceMembership?.groupDisciplinaryChoices || sourceMembership?.luckyLoserChoices) {
            await db.update(competitionMembers)
              .set({
                groupDisciplinaryChoices: sourceMembership.groupDisciplinaryChoices,
                luckyLoserChoices: sourceMembership.luckyLoserChoices,
              })
              .where(and(
                eq(competitionMembers.competitionId, target.id),
                eq(competitionMembers.userId, compUser.id),
              ));
          }

          copiedTargetNames.push(target.name);
          affectedTournamentIds.add(tournamentId);
        }

        report.push({
          username: compUser.username,
          tournament: tournamentId,
          source: source.competitionName,
          targets: copiedTargetNames,
          membersAdded: addedMemberNames,
          matchPredsCopied: sourcePreds.length,
          bracketCopied: !!sourceBracket,
          bonusAnswersCopied: sourceAnswers.length,
        });
      }
    }

    // Recalculate scores for all affected tournaments
    await Promise.all([...affectedTournamentIds].map(tid =>
      recalculateAllScoresForTournament(tid).catch(err =>
        console.error('Scoring recalculate error:', err)
      )
    ));

    res.json({ ok: true, report });
  } catch (err) {
    console.error('Copy comparison predictions error:', err);
    res.status(500).json({ error: 'Failed to copy predictions' });
  }
});

export { router as competitionsRouter };

