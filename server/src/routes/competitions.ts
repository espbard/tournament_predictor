import { Router } from 'express';
import { eq, and, inArray, or, ilike, desc } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client.js';
import { competitions, competitionMembers, users, tournaments, predictions, matches, teams, groups, bracketPredictions, bonusQuestions, bonusAnswers, players } from '../db/schema.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { CreateCompetitionSchema, CreatePredictionSchema, SaveBracketPredictionsSchema, DEFAULT_SCORING_CONFIG, SaveBonusAnswerSchema, resolveFirstRoundSlots } from '@tournament-predictor/shared';
import type { UserStatCardData, ScoringConfig, KnockoutConfig, BracketPredictions, LeaderboardProgressionMatch, LeaderboardProgressionResponse } from '@tournament-predictor/shared';
import { recalculateAllScoresForTournament } from '../lib/scoringTrigger.js';
import { computeGroupStandings, calculateMatchPoints, getUserPredictedTeamForKnockoutSlot, calculateGroupPositionPoints, calculateKnockoutPoints, type KnockoutMatchSlot, type FirstRoundPredTeams, type CompletedKnockoutMatch } from '../lib/scoring.js';
import { subscribeLeaderboard, unsubscribeLeaderboard } from '../lib/leaderboardEvents.js';

const router = Router();

function generateInviteCode(): string {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

type Lang = 'en' | 'no' | 'de';

function formatUserList(names: string[], lang: Lang): string {
  const bolded = names.map(n => `**${n}**`);
  const and = lang === 'no' ? 'og' : lang === 'de' ? 'und' : 'and';
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
  if (lang === 'de') {
    if (homeScore > awayScore) return `dass ${homeTeamName} gegen ${awayTeamName} gewinnt`;
    if (awayScore > homeScore) return `dass ${awayTeamName} gegen ${homeTeamName} gewinnt`;
    return `ein Unentschieden zwischen ${homeTeamName} und ${awayTeamName}`;
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
        iconColor: users.iconColor,
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
        iconColor: users.iconColor,
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
        iconColor: row.iconColor ?? null,
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

router.get('/:id/leaderboard-progression', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const user = res.locals.user;
    const includeComparison = req.query.includeComparison === 'true';
    const includeInactive = req.query.includeInactive === 'true';

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, competition.tournamentId));
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const config = competition.scoringConfig as ScoringConfig;
    const knockoutCfg = tournament.knockoutConfig as KnockoutConfig | null;
    const firstRound = knockoutCfg?.firstRound ?? 'round_of_16';
    const bracketSlots = knockoutCfg?.bracketSlots ?? {};
    const directQualifiers = knockoutCfg?.directQualifiers ?? 2;
    const tournamentGroupDisciplinaryChoices = knockoutCfg?.groupDisciplinaryChoices ?? {};

    // Fetch members (exclude leaderboard/comparison/test accounts)
    let memberRows = await db
      .select({
        userId: users.id,
        username: users.username,
        imageUrl: users.imageUrl,
        iconColor: users.iconColor,
        groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices,
        luckyLoserChoices: competitionMembers.luckyLoserChoices,
        bonusQuestionPoints: competitionMembers.bonusQuestionPoints,
        lateAdditionPoints: competitionMembers.lateAdditionPoints,
        lateAdditionWindowEndsAt: competitionMembers.lateAdditionWindowEndsAt,
      })
      .from(competitionMembers)
      .innerJoin(users, eq(competitionMembers.userId, users.id))
      .where(
        includeComparison
          ? and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false))
          : and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false)),
      );

    // Filter out inactive users (no predictions in the 5 most recent completed matches)
    const recentCompletedForProgression = await db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.status, 'completed')))
      .orderBy(desc(matches.scheduledAt))
      .limit(5);
    if (!includeInactive && recentCompletedForProgression.length >= 5) {
      const recentIds = recentCompletedForProgression.map(m => m.id);
      const allMemberIds = memberRows.map(m => m.userId);
      const activePredRows = await db
        .select({ userId: predictions.userId })
        .from(predictions)
        .where(and(
          eq(predictions.competitionId, id),
          inArray(predictions.matchId, recentIds),
          inArray(predictions.userId, allMemberIds),
        ));
      const activeUserIds = new Set(activePredRows.map(p => p.userId));
      memberRows = memberRows.filter(m => activeUserIds.has(m.userId));
    }

    const memberIds = memberRows.map(m => m.userId);
    if (memberIds.length === 0) {
      return res.json({ matches: [], users: [] } satisfies LeaderboardProgressionResponse);
    }

    // Fetch all tournament matches
    const allMatches = await db
      .select()
      .from(matches)
      .where(eq(matches.tournamentId, competition.tournamentId))
      .orderBy(matches.scheduledAt);

    const completedGroupMatches = allMatches.filter(m => m.stage === 'group' && m.status === 'completed');
    const allGroupMatches = allMatches.filter(m => m.stage === 'group');
    const allGroupDone = allGroupMatches.length > 0 && allGroupMatches.every(m => m.status === 'completed');

    const allKoMatchesRaw = allMatches.filter(m => m.stage !== 'group');
    // Must match the client's knockoutMatchMap sort so stage_N bracket keys align with stored predictions.
    allKoMatchesRaw.sort((a, b) => {
      const aHasIdx = a.bracketIndex != null;
      const bHasIdx = b.bracketIndex != null;
      if (aHasIdx && bHasIdx && a.bracketIndex !== b.bracketIndex) return a.bracketIndex! - b.bracketIndex!;
      if (aHasIdx && !bHasIdx) return -1;
      if (!aHasIdx && bHasIdx) return 1;
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });
    const completedKoMatches = allKoMatchesRaw.filter(m => m.status === 'completed');

    // Fetch teams and groups for labels and standings
    const teamRows = await db.select().from(teams).where(eq(teams.tournamentId, competition.tournamentId));
    const groupRows = await db.select().from(groups).where(eq(groups.tournamentId, competition.tournamentId));
    const teamMap = new Map(teamRows.map(t => [t.id, t]));
    const groupNameMap = new Map(groupRows.map(g => [g.id, g.name]));
    const teamGroupMap = new Map<string, string>();
    for (const t of teamRows) {
      if (t.groupId) {
        const gName = groupNameMap.get(t.groupId);
        if (gName) teamGroupMap.set(t.id, gName);
      }
    }

    // Fetch group predictions with points for all members
    const groupMatchIds = completedGroupMatches.map(m => m.id);
    const allGroupPreds = groupMatchIds.length > 0
      ? await db
          .select()
          .from(predictions)
          .where(
            and(
              eq(predictions.competitionId, id),
              inArray(predictions.matchId, groupMatchIds),
              inArray(predictions.userId, memberIds),
            ),
          )
      : [];

    // predLookup: matchId -> userId -> points
    const predLookup = new Map<string, Map<string, number>>();
    for (const p of allGroupPreds) {
      if (p.isReplacement) continue;
      if (!predLookup.has(p.matchId)) predLookup.set(p.matchId, new Map());
      predLookup.get(p.matchId)!.set(p.userId, p.points ?? 0);
    }

    // Group predictions by user for standings computation
    const groupPredsByUser = new Map<string, Map<string, typeof allGroupPreds[number]>>();
    for (const p of allGroupPreds) {
      if (p.isReplacement) continue;
      if (!groupPredsByUser.has(p.userId)) groupPredsByUser.set(p.userId, new Map());
      groupPredsByUser.get(p.userId)!.set(p.matchId, p);
    }

    // Fetch bracket predictions for all members
    const bracketPredRows = await db
      .select()
      .from(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, id), inArray(bracketPredictions.userId, memberIds)));
    const bracketPredMap = new Map(bracketPredRows.map(r => [r.userId, r.predictions as BracketPredictions]));

    // Compute actual group standings
    const actualStandings = computeGroupStandings(completedGroupMatches, teamGroupMap, tournamentGroupDisciplinaryChoices);

    // Per-user: compute predicted standings and first-round predicted teams
    const allFirstRoundMatches = allKoMatchesRaw.filter(m => m.stage === firstRound);
    const userFirstRoundPredTeams = new Map<string, FirstRoundPredTeams>();
    const userBracketPredsMap = new Map<string, BracketPredictions>();
    const userPredictedStandings = new Map<string, ReturnType<typeof computeGroupStandings>>();

    for (const member of memberRows) {
      const groupPredMap = groupPredsByUser.get(member.userId) ?? new Map();
      const simulatedMatches = completedGroupMatches
        .filter(m => m.homeTeamId && m.awayTeamId)
        .flatMap(m => {
          const pred = groupPredMap.get(m.id);
          if (!pred) return [];
          return [{ homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId!, homeScore: pred.homeScore, awayScore: pred.awayScore }];
        });
      const predictedStandings = computeGroupStandings(simulatedMatches, teamGroupMap, member.groupDisciplinaryChoices ?? {});
      userPredictedStandings.set(member.userId, predictedStandings);

      const resolvedSlots = resolveFirstRoundSlots(
        bracketSlots,
        predictedStandings,
        directQualifiers,
        allFirstRoundMatches.length,
        member.luckyLoserChoices ?? {},
      );
      const firstRoundPredTeams: FirstRoundPredTeams = {};
      allFirstRoundMatches.forEach((match, i) => {
        firstRoundPredTeams[`${firstRound}_${i}`] = {
          predHomeId: resolvedSlots[`m${i + 1}_home`] ?? null,
          predAwayId: resolvedSlots[`m${i + 1}_away`] ?? null,
        };
      });
      userFirstRoundPredTeams.set(member.userId, firstRoundPredTeams);
      userBracketPredsMap.set(member.userId, bracketPredMap.get(member.userId) ?? {});
    }

    // Match label helper
    const stageAbbr: Record<string, string> = {
      round_of_32: 'R32', round_of_16: 'R16', quarter_final: 'QF',
      semi_final: 'SF', bronze_final: '3rd', final: 'Final',
    };
    function formatMatchLabel(match: typeof allMatches[number]): string {
      const homeTeam = match.homeTeamId ? teamMap.get(match.homeTeamId) : null;
      const awayTeam = match.awayTeamId ? teamMap.get(match.awayTeamId) : null;
      if (homeTeam && awayTeam) {
        return `${homeTeam.name.slice(0, 3).toUpperCase()} vs ${awayTeam.name.slice(0, 3).toUpperCase()}`;
      }
      const abbr = stageAbbr[match.stage] ?? match.stage;
      const stageMatches = allKoMatchesRaw.filter(m => m.stage === match.stage);
      const idx = stageMatches.findIndex(m => m.id === match.id) + 1;
      return `${abbr} ${idx}`;
    }

    // Build progression milestones
    const milestones: LeaderboardProgressionMatch[] = [];
    const cumulativeTotals: Record<string, number> = {};
    for (const m of memberRows) cumulativeTotals[m.userId] = 0;

    const confirmedGroupStandingsData = knockoutCfg?.confirmedGroupStandings;

    // Build a map from matchId -> group names whose last completed match is this match.
    // completedGroupMatches is sorted by scheduledAt, so iterating in order means the
    // last assignment per group is always the chronologically latest match for that group.
    const groupLastMatchId = new Map<string, string>(); // groupName -> matchId
    for (const match of completedGroupMatches) {
      const matchGroupName = match.homeTeamId ? teamGroupMap.get(match.homeTeamId) : null;
      if (matchGroupName) groupLastMatchId.set(matchGroupName, match.id);
    }
    const lastMatchToGroups = new Map<string, string[]>(); // matchId -> groupNames[]
    for (const [groupName, matchId] of groupLastMatchId) {
      if (!lastMatchToGroups.has(matchId)) lastMatchToGroups.set(matchId, []);
      lastMatchToGroups.get(matchId)!.push(groupName);
    }

    // Group stage milestones — after each match, inject a per-group position milestone
    // for any confirmed group whose last completed match was just processed.
    for (const match of completedGroupMatches) {
      for (const userId of memberIds) {
        cumulativeTotals[userId] += predLookup.get(match.id)?.get(userId) ?? 0;
      }
      milestones.push({ matchId: match.id, label: formatMatchLabel(match), stage: match.stage, cumulativePoints: { ...cumulativeTotals } });

      const groupsEndingHere = (lastMatchToGroups.get(match.id) ?? []).sort();
      for (const groupName of groupsEndingHere) {
        if (!confirmedGroupStandingsData?.[groupName]) continue;
        const lockedGroupStandings = new Map([
          [groupName, confirmedGroupStandingsData[groupName].map((teamId: string) => ({ teamId, points: 0, gd: 0, gf: 0 }))],
        ]);
        for (const member of memberRows) {
          const predictedStandings = userPredictedStandings.get(member.userId) ?? new Map();
          const singleGroupPredicted = new Map([[groupName, predictedStandings.get(groupName) ?? []]]);
          cumulativeTotals[member.userId] += calculateGroupPositionPoints(lockedGroupStandings, singleGroupPredicted, config);
        }
        milestones.push({ matchId: `group-${groupName}`, label: `Group ${groupName}`, stage: 'group', cumulativePoints: { ...cumulativeTotals } });
      }
    }

    // Knockout milestones — compute calculateKnockoutPoints incrementally
    const prevKoTotals: Record<string, number> = {};
    for (const userId of memberIds) prevKoTotals[userId] = 0;

    for (const match of completedKoMatches) {
      const matchTime = match.scheduledAt ? new Date(match.scheduledAt).getTime() : Infinity;

      // Build filtered KO match list: completed only up to and including this match's scheduledAt
      const filteredKoMatches: CompletedKnockoutMatch[] = allKoMatchesRaw.map(m => ({
        id: m.id,
        stage: m.stage,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore ?? 0,
        awayScore: m.awayScore ?? 0,
        progressingTeamId: m.progressingTeamId,
        status: m.status === 'completed' && m.scheduledAt && new Date(m.scheduledAt).getTime() <= matchTime
          ? 'completed'
          : 'scheduled',
      }));

      for (const member of memberRows) {
        const userBracket = userBracketPredsMap.get(member.userId) ?? {};
        const firstRoundPredTeams = userFirstRoundPredTeams.get(member.userId) ?? {};

        const koResult = calculateKnockoutPoints(filteredKoMatches, firstRound, userBracket, config, firstRoundPredTeams);

        const delta = koResult.total - (prevKoTotals[member.userId] ?? 0);
        if (delta > 0) cumulativeTotals[member.userId] += delta;
        prevKoTotals[member.userId] = koResult.total;
      }

      milestones.push({ matchId: match.id, label: formatMatchLabel(match), stage: match.stage, cumulativePoints: { ...cumulativeTotals } });
    }

    // Bonus question points at the end
    const hasBonusPoints = memberRows.some(m => (m.bonusQuestionPoints ?? 0) > 0);
    if (hasBonusPoints) {
      for (const member of memberRows) {
        cumulativeTotals[member.userId] += (member.bonusQuestionPoints ?? 0);
      }
      milestones.push({ matchId: 'bonus', label: 'Bonus', stage: 'bonus', cumulativePoints: { ...cumulativeTotals } });
    }

    // Late-addition points: visualise on the milestone just before the user's first real prediction.
    // We post-process the already-built milestone snapshots so we don't have to restructure the loop above.
    const lateAdditionUsers = memberRows.filter(m => (m.lateAdditionPoints ?? 0) > 0);
    if (lateAdditionUsers.length > 0) {
      // Index the match scheduledAt so we can sort group predictions chronologically
      const matchScheduledAt = new Map<string, string | null>();
      for (const m of allMatches) matchScheduledAt.set(m.id, m.scheduledAt);

      for (const member of lateAdditionUsers) {
        const userId = member.userId;
        const pts = member.lateAdditionPoints!;

        // Find the earliest completed match for which this user has a non-replacement prediction.
        // Group stage: rows are in allGroupPreds.
        let firstPredMatchId: string | null = null;
        let firstPredTime: number = Infinity;

        for (const pred of allGroupPreds) {
          if (pred.userId !== userId || pred.isReplacement) continue;
          const t = matchScheduledAt.get(pred.matchId);
          const ms = t ? new Date(t).getTime() : Infinity;
          if (ms < firstPredTime) { firstPredTime = ms; firstPredMatchId = pred.matchId; }
        }

        // KO stage: bracket prediction covers all KO matches; treat the first completed KO match as the start.
        const bracketPred = userBracketPredsMap.get(userId);
        if (bracketPred && Object.keys(bracketPred).length > 0 && completedKoMatches.length > 0) {
          const firstKo = completedKoMatches[0]; // already sorted by scheduledAt
          const t = firstKo.scheduledAt ? new Date(firstKo.scheduledAt).getTime() : Infinity;
          if (t < firstPredTime) { firstPredTime = t; firstPredMatchId = firstKo.id; }
        }

        // Find where in milestones that first-prediction match sits.
        const firstMilestoneIdx = firstPredMatchId
          ? milestones.findIndex(ms => ms.matchId === firstPredMatchId)
          : -1;

        // Inject from the milestone BEFORE their first prediction (fall back to 0 if it's the very first).
        const injectionIdx = firstMilestoneIdx > 0 ? firstMilestoneIdx - 1
                           : firstMilestoneIdx === 0 ? 0
                           : 0; // no predictions found — show from the start

        for (let i = injectionIdx; i < milestones.length; i++) {
          milestones[i].cumulativePoints[userId] = (milestones[i].cumulativePoints[userId] ?? 0) + pts;
        }
      }
    }

    const response: LeaderboardProgressionResponse = {
      matches: milestones,
      users: memberRows.map(m => ({ userId: m.userId, username: m.username, imageUrl: m.imageUrl, iconColor: m.iconColor ?? null })),
    };
    res.json(response);
  } catch (err) {
    console.error('Leaderboard progression error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard progression' });
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
        iconColor: users.iconColor,
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
          ? and(eq(predictions.competitionId, id), eq(users.isLeaderboardUser, false))
          : and(eq(predictions.competitionId, id), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false))
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
      iconColor: string | null;
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
      return { matchId: row.matchId, userId: row.userId, username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null, isComparisonUser: row.isComparisonUser, homeScore: row.homeScore, awayScore: row.awayScore, progressingTeamId: row.progressingTeamId, points: row.points, isReplacement: row.isReplacement, breakdown: bd };
    });

    // Knockout predictions come from bracketPredictions (not the predictions table).
    // Fetch ALL knockout matches (including not-yet-played) so bracket key indices
    // (round_of_16_0, etc.) stay consistent with how the scoring logic assigns them.
    const KNOCKOUT_STAGE_LIST = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final'] as const;
    const allKoMatches = await db
      .select({ id: matches.id, stage: matches.stage, scheduledAt: matches.scheduledAt, status: matches.status, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId, homeScore: matches.homeScore, awayScore: matches.awayScore, progressingTeamId: matches.progressingTeamId, bracketIndex: matches.bracketIndex })
      .from(matches)
      .where(and(
        eq(matches.tournamentId, competition.tournamentId),
        inArray(matches.stage, [...KNOCKOUT_STAGE_LIST]),
      ));

    // Sort matches using the same logic as the client bracket visualizer:
    // bracketIndex first (nulls last), then scheduledAt. This ensures the
    // stage_N bracket keys assigned below match what was stored when users
    // submitted their predictions.
    allKoMatches.sort((a, b) => {
      const aHasIdx = a.bracketIndex != null;
      const bHasIdx = b.bracketIndex != null;
      if (aHasIdx && bHasIdx) {
        if (a.bracketIndex !== b.bracketIndex) return a.bracketIndex! - b.bracketIndex!;
      } else if (aHasIdx) {
        return -1;
      } else if (bHasIdx) {
        return 1;
      }
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });

    // Map bracket key → matchId (and full data) for all knockout matches
    const bracketKeyToMatchId = new Map<string, string>();
    const matchIdToKoData = new Map<string, typeof allKoMatches[number]>();
    const stageIdx = new Map<string, number>();
    for (const m of allKoMatches) {
      const i = stageIdx.get(m.stage) ?? 0;
      bracketKeyToMatchId.set(`${m.stage}_${i}`, m.id);
      matchIdToKoData.set(m.id, m);
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
          iconColor: users.iconColor,
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

          }

          result.push({
            matchId,
            userId: bp.userId,
            username: userInfo.username,
            imageUrl: userInfo.imageUrl,
            iconColor: userInfo.iconColor ?? null,
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
    const lang: Lang = req.query.lang === 'no' ? 'no' : req.query.lang === 'de' ? 'de' : 'en';
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
        iconColor: users.iconColor,
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
      .innerJoin(competitionMembers, and(eq(competitionMembers.userId, predictions.userId), eq(competitionMembers.competitionId, id)))
      .where(
        and(
          eq(predictions.competitionId, id),
          eq(matches.status, 'completed'),
          eq(users.isLeaderboardUser, false),
          eq(users.isComparisonUser, false),
          eq(predictions.isReplacement, false)
        )
      );

    // Determine inactive users (no predictions in the 5 most recent completed matches).
    // Group-stage predictions live in `predictions`; knockout predictions live in
    // `bracketPredictions`, so we must query both tables when recent matches span
    // multiple stages (which happens once the knockout phase begins).
    const recentForStatCards = await db
      .select({ id: matches.id, stage: matches.stage })
      .from(matches)
      .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.status, 'completed')))
      .orderBy(desc(matches.scheduledAt))
      .limit(5);

    let activeStatUserIds: Set<string> | null = null;
    if (recentForStatCards.length >= 5) {
      const recentGroupMatchIds = recentForStatCards.filter(m => m.stage === 'group').map(m => m.id);
      const hasRecentKoMatches = recentForStatCards.some(m => m.stage !== 'group');

      const activeUserIdSet = new Set<string>();

      if (recentGroupMatchIds.length > 0) {
        const recentStatPreds = await db
          .select({ userId: predictions.userId })
          .from(predictions)
          .where(and(eq(predictions.competitionId, id), inArray(predictions.matchId, recentGroupMatchIds)));
        recentStatPreds.forEach(r => activeUserIdSet.add(r.userId));
      }

      if (hasRecentKoMatches) {
        // Any user who submitted bracket predictions is considered active during the KO stage
        // (bracket predictions cover all knockout matches in a single submission).
        const bracketPredUsersForStats = await db
          .select({ userId: bracketPredictions.userId })
          .from(bracketPredictions)
          .where(eq(bracketPredictions.competitionId, id));
        bracketPredUsersForStats.forEach(r => activeUserIdSet.add(r.userId));
      }

      activeStatUserIds = activeUserIdSet;
    }

    const activeRows = activeStatUserIds ? rows.filter(r => activeStatUserIds!.has(r.userId)) : rows;

    const oneGoalAwayCounts = new Map<string, { username: string; imageUrl: string | null; iconColor: string | null; count: number }>();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      const goalsAway =
        Math.abs(row.predHomeScore - row.actualHomeScore) + Math.abs(row.predAwayScore - row.actualAwayScore);
      if (goalsAway !== 1) continue;
      const entry = oneGoalAwayCounts.get(row.userId) ?? { username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null, count: 0 };
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
      { username: string; imageUrl: string | null; iconColor: string | null; correctResults: number; exactScores: number }
    >();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      const predictedResult = Math.sign(row.predHomeScore - row.predAwayScore);
      const actualResult = Math.sign(row.actualHomeScore - row.actualAwayScore);
      if (predictedResult !== actualResult) continue;
      const entry =
        userResultStats.get(row.userId) ??
        { username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null, correctResults: 0, exactScores: 0 };
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

    // ── Best/Worst form: points earned across the most recent completed GROUP matches ──
    // Knockout predictions are stored per-competition in bracketPredictions (not per-match
    // in predictions), so we cannot retrieve per-match KO points from activeRows. Restricting
    // to group-stage matches keeps the form cards accurate and avoids false droughts caused by
    // KO matches appearing in the "recent 5" with zero entries in pointsByUserMatch.
    const completedMatches = await db
      .select({ id: matches.id, scheduledAt: matches.scheduledAt })
      .from(matches)
      .where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.status, 'completed'), eq(matches.stage, 'group')));
    const completedMatchesByRecency = [...completedMatches].sort(
      (a, b) => (b.scheduledAt?.getTime() ?? 0) - (a.scheduledAt?.getTime() ?? 0)
    );
    const last5MatchIds = new Set(completedMatchesByRecency.slice(0, 5).map(m => m.id));

    const userInfo = new Map<string, { username: string; imageUrl: string | null; iconColor: string | null }>();
    const isLateAdditionByUser = new Map<string, boolean>();
    const pointsByUserMatch = new Map<string, number>();
    const predCountByUser = new Map<string, number>();
    for (const row of activeRows) {
      userInfo.set(row.userId, { username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null });
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

    let bestFormGroup: { userId: string; username: string; imageUrl: string | null; iconColor: string | null; points: number }[] = [];
    if (recentPointsByUser.size > 0) {
      const maxRecentPoints = Math.max(...recentPointsByUser.values());
      bestFormGroup = [...recentPointsByUser.entries()]
        .filter(([, points]) => points === maxRecentPoints)
        .map(([userId, points]) => ({ userId, points, ...userInfo.get(userId)! }))
        .sort((a, b) => a.username.localeCompare(b.username));
    }

    let worstFormGroup: { userId: string; username: string; imageUrl: string | null; iconColor: string | null; drought: number }[] = [];
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
    // Fetch all member totals to include non-match points (bonus questions, bracket, group positions, etc.)
    const memberRows = await db
      .select({
        userId: users.id,
        username: users.username,
        imageUrl: users.imageUrl,
        iconColor: users.iconColor,
        exactScorePoints: competitionMembers.exactScorePoints,
        correctResultPoints: competitionMembers.correctResultPoints,
        correctTeamProgressesPoints: competitionMembers.correctTeamProgressesPoints,
        correctGroupPositionPoints: competitionMembers.correctGroupPositionPoints,
        correctTeamInKnockoutTiePoints: competitionMembers.correctTeamInKnockoutTiePoints,
        correctTeamInFinalPoints: competitionMembers.correctTeamInFinalPoints,
        correctWinnerPoints: competitionMembers.correctWinnerPoints,
        bonusQuestionPoints: competitionMembers.bonusQuestionPoints,
        lateAdditionPoints: competitionMembers.lateAdditionPoints,
        groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices,
        luckyLoserChoices: competitionMembers.luckyLoserChoices,
      })
      .from(competitionMembers)
      .innerJoin(users, eq(competitionMembers.userId, users.id))
      .where(and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false)));

    // Build user info from ALL rows (not just active users) so the actual leader is never excluded
    // because they haven't predicted recently.
    const leaderUserInfo = new Map<string, { username: string; imageUrl: string | null; iconColor: string | null }>();
    const leaderPointsByUserMatch = new Map<string, number>();
    for (const row of rows) {
      leaderUserInfo.set(row.userId, { username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null });
      leaderPointsByUserMatch.set(`${row.userId}|${row.matchId}`, row.points ?? 0);
    }

    // Fixed non-KO offset per user: group position points + bonus + late addition.
    // KO points are computed incrementally per KO match milestone below so they don't
    // distort the ranking at earlier milestones.
    const nonMatchPointsByUser = new Map<string, number>();
    for (const row of memberRows) {
      nonMatchPointsByUser.set(row.userId,
        row.correctGroupPositionPoints + row.bonusQuestionPoints + row.lateAdditionPoints
      );
    }
    // Include members who have non-match points but no completed match predictions.
    for (const row of memberRows) {
      if (!leaderUserInfo.has(row.userId)) {
        leaderUserInfo.set(row.userId, { username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null });
      }
    }

    // Fetch data for incremental KO points (mirrors leaderboard-progression logic).
    const [leaderTournament] = await db.select().from(tournaments).where(eq(tournaments.id, competition.tournamentId));
    const leaderKnockoutCfg = leaderTournament?.knockoutConfig as KnockoutConfig | null;
    const leaderFirstRound = leaderKnockoutCfg?.firstRound ?? 'round_of_16';
    const leaderBracketSlots = leaderKnockoutCfg?.bracketSlots ?? {};
    const leaderDirectQualifiers = leaderKnockoutCfg?.directQualifiers ?? 2;

    const allTournamentMatchesForLeader = await db
      .select()
      .from(matches)
      .where(eq(matches.tournamentId, competition.tournamentId));

    const completedGroupMatchesForLeader = allTournamentMatchesForLeader
      .filter(m => m.stage === 'group' && m.status === 'completed')
      .sort((a, b) => (a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0) - (b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0));

    const allKoMatchesForLeader = allTournamentMatchesForLeader.filter(m => m.stage !== 'group');
    allKoMatchesForLeader.sort((a, b) => {
      const aHasIdx = a.bracketIndex != null;
      const bHasIdx = b.bracketIndex != null;
      if (aHasIdx && bHasIdx && a.bracketIndex !== b.bracketIndex) return a.bracketIndex! - b.bracketIndex!;
      if (aHasIdx && !bHasIdx) return -1;
      if (!aHasIdx && bHasIdx) return 1;
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });
    const completedKoMatchesForLeader = allKoMatchesForLeader.filter(m => m.status === 'completed');

    const memberUserIds = memberRows.map(m => m.userId);
    const [teamRowsForLeader, groupRowsForLeader, bracketPredRowsForLeader] = await Promise.all([
      db.select().from(teams).where(eq(teams.tournamentId, competition.tournamentId)),
      db.select().from(groups).where(eq(groups.tournamentId, competition.tournamentId)),
      memberUserIds.length > 0
        ? db.select().from(bracketPredictions).where(and(eq(bracketPredictions.competitionId, id), inArray(bracketPredictions.userId, memberUserIds)))
        : Promise.resolve([]),
    ]);

    const groupNameMapForLeader = new Map(groupRowsForLeader.map(g => [g.id, g.name]));
    const teamGroupMapForLeader = new Map<string, string>();
    for (const t of teamRowsForLeader) {
      if (t.groupId) {
        const gName = groupNameMapForLeader.get(t.groupId);
        if (gName) teamGroupMapForLeader.set(t.id, gName);
      }
    }
    const bracketPredMapForLeader = new Map(bracketPredRowsForLeader.map(r => [r.userId, r.predictions as BracketPredictions]));

    // Build predicted group standings per user from group-stage prediction rows.
    const groupPredsByUserForLeader = new Map<string, Map<string, typeof rows[number]>>();
    for (const row of rows) {
      if (!groupPredsByUserForLeader.has(row.userId)) groupPredsByUserForLeader.set(row.userId, new Map());
      groupPredsByUserForLeader.get(row.userId)!.set(row.matchId, row);
    }

    const allFirstRoundMatchesForLeader = allKoMatchesForLeader.filter(m => m.stage === leaderFirstRound);
    const userFirstRoundPredTeamsForLeader = new Map<string, FirstRoundPredTeams>();
    const userBracketPredsForLeader = new Map<string, BracketPredictions>();

    for (const member of memberRows) {
      const groupPredMap = groupPredsByUserForLeader.get(member.userId) ?? new Map();
      const simulatedMatches = completedGroupMatchesForLeader
        .filter(m => m.homeTeamId && m.awayTeamId)
        .flatMap(m => {
          const pred = groupPredMap.get(m.id);
          if (!pred) return [];
          return [{ homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId!, homeScore: pred.predHomeScore, awayScore: pred.predAwayScore }];
        });
      const predictedStandings = computeGroupStandings(simulatedMatches, teamGroupMapForLeader, member.groupDisciplinaryChoices ?? {});
      const resolvedSlots = resolveFirstRoundSlots(
        leaderBracketSlots, predictedStandings, leaderDirectQualifiers,
        allFirstRoundMatchesForLeader.length, member.luckyLoserChoices ?? {},
      );
      const firstRoundPredTeams: FirstRoundPredTeams = {};
      allFirstRoundMatchesForLeader.forEach((m, i) => {
        firstRoundPredTeams[`${leaderFirstRound}_${i}`] = {
          predHomeId: resolvedSlots[`m${i + 1}_home`] ?? null,
          predAwayId: resolvedSlots[`m${i + 1}_away`] ?? null,
        };
      });
      userFirstRoundPredTeamsForLeader.set(member.userId, firstRoundPredTeams);
      userBracketPredsForLeader.set(member.userId, bracketPredMapForLeader.get(member.userId) ?? {});
    }

    const cumulativePointsByUser = new Map<string, number>();
    for (const userId of leaderUserInfo.keys()) cumulativePointsByUser.set(userId, 0);

    const leadingSetsByMatch: Set<string>[] = [];
    const rankSnapshotsByMatch: Map<string, number>[] = [];

    // Group stage milestones
    for (const match of completedGroupMatchesForLeader) {
      for (const userId of leaderUserInfo.keys()) {
        const points = leaderPointsByUserMatch.get(`${userId}|${match.id}`) ?? 0;
        cumulativePointsByUser.set(userId, (cumulativePointsByUser.get(userId) ?? 0) + points);
      }
      const maxPts = Math.max(...[...cumulativePointsByUser.entries()].map(([uid, p]) => p + (nonMatchPointsByUser.get(uid) ?? 0)));
      leadingSetsByMatch.push(new Set([...cumulativePointsByUser.entries()].filter(([uid, p]) => p + (nonMatchPointsByUser.get(uid) ?? 0) === maxPts).map(([uid]) => uid)));
      rankSnapshotsByMatch.push(new Map(cumulativePointsByUser));
    }

    // Knockout stage milestones — compute KO points incrementally per match
    const prevKoTotalsForStreak: Record<string, number> = {};
    for (const userId of leaderUserInfo.keys()) prevKoTotalsForStreak[userId] = 0;

    for (const match of completedKoMatchesForLeader) {
      const matchTime = match.scheduledAt ? new Date(match.scheduledAt).getTime() : Infinity;
      const filteredKoMatches: CompletedKnockoutMatch[] = allKoMatchesForLeader.map(m => ({
        id: m.id, stage: m.stage, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId,
        homeScore: m.homeScore ?? 0, awayScore: m.awayScore ?? 0, progressingTeamId: m.progressingTeamId,
        status: m.status === 'completed' && m.scheduledAt && new Date(m.scheduledAt).getTime() <= matchTime
          ? 'completed' : 'scheduled',
      }));

      for (const userId of leaderUserInfo.keys()) {
        const koResult = calculateKnockoutPoints(
          filteredKoMatches, leaderFirstRound,
          userBracketPredsForLeader.get(userId) ?? {}, scoringConfig,
          userFirstRoundPredTeamsForLeader.get(userId) ?? {},
        );
        const delta = koResult.total - (prevKoTotalsForStreak[userId] ?? 0);
        if (delta > 0) cumulativePointsByUser.set(userId, (cumulativePointsByUser.get(userId) ?? 0) + delta);
        prevKoTotalsForStreak[userId] = koResult.total;
      }

      const maxPts = Math.max(...[...cumulativePointsByUser.entries()].map(([uid, p]) => p + (nonMatchPointsByUser.get(uid) ?? 0)));
      leadingSetsByMatch.push(new Set([...cumulativePointsByUser.entries()].filter(([uid, p]) => p + (nonMatchPointsByUser.get(uid) ?? 0) === maxPts).map(([uid]) => uid)));
      rankSnapshotsByMatch.push(new Map(cumulativePointsByUser));
    }

    let kingGroup: { userId: string; username: string; imageUrl: string | null; iconColor: string | null; streak: number }[] = [];
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
          .map(l => ({ userId: l.userId, streak: l.streak, ...leaderUserInfo.get(l.userId)! }))
          .sort((a, b) => a.username.localeCompare(b.username));
      }
    }

    let theLeaderCard: UserStatCardData | null = null;
    let bottomOfTheLeagueCard: UserStatCardData | null = null;
    let theClimberCard: UserStatCardData | null = null;
    let theFallerCard: UserStatCardData | null = null;
    let knockoutSpecialistCard: UserStatCardData | null = null;
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
    let jaViElskerCard: UserStatCardData | null = null;
    let traitorCard: UserStatCardData | null = null;
    let matchMadeInHeavenCard: UserStatCardData | null = null;
    let audienceDarlingCard: UserStatCardData | null = null;

    if (kingGroup.length > 0) {
      const gameCount = kingGroup[0].streak;
      theLeaderCard = {
        id: 'theLeader',
        title: lang === 'no' ? 'Kongen på haugen' : lang === 'de' ? 'Der Platzhirsch' : 'The Leader',
        statistic:
          lang === 'no'
            ? `${formatUserList(kingGroup.map(u => u.username), lang)} har regjert på toppen i ${gameCount} kamp${gameCount === 1 ? '' : 'er'}!`
            : lang === 'de'
              ? `${formatUserList(kingGroup.map(u => u.username), lang)} thront seit ${gameCount} Spiel${gameCount === 1 ? '' : 'en'} an der Spitze wie eine sehr wackelige Krone!`
              : `${formatUserList(kingGroup.map(u => u.username), lang)} ${kingGroup.length === 1 ? 'has' : 'have'} reigned supreme for the last ${gameCount} game${gameCount === 1 ? '' : 's'}!`,
        subjects: kingGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
        linkType: 'leaderboard',
      };
    }

    // ── Bottom of the league: lowest total points vs. the leader ──
    // memberRows was fetched above for the Leader card calculation and is reused here.
    const memberTotals = memberRows
      .filter(m => !activeStatUserIds || activeStatUserIds.has(m.userId))
      .map(row => ({
        userId: row.userId,
        username: row.username,
        imageUrl: row.imageUrl,
        iconColor: row.iconColor ?? null,
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
        title: lang === 'no' ? 'Kan Bare Bli Bedre' : lang === 'de' ? 'Tabellenleuchte' : 'Bottom of the league',
        statistic:
          lang === 'no'
            ? `${formatUserList(bottomGroup.map(u => u.username), lang)} er sist på tabellen med bare ${minPoints} poeng! ${gap} poeng bak ${formatUserList(topGroup.map(u => u.username), lang)} på topp!`
            : lang === 'de'
              ? `${formatUserList(bottomGroup.map(u => u.username), lang)} hockt mit kläglichen ${minPoints} Punkt${minPoints === 1 ? '' : 'en'} ganz unten! Satte ${gap} Punkt${gap === 1 ? '' : 'e'} hinter ${formatUserList(topGroup.map(u => u.username), lang)} da oben!`
              : `${formatUserList(bottomGroup.map(u => u.username), lang)} ${bottomGroup.length === 1 ? 'is' : 'are'} bottom of the table with only ${minPoints} point${minPoints === 1 ? '' : 's'}! ${gap} point${gap === 1 ? '' : 's'} behind ${formatUserList(topGroup.map(u => u.username), lang)} in first place!`,
        subjects: bottomGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
        linkType: 'leaderboard',
      };
    }

    // ── The Climber / The Faller: biggest rank change over the last 10 games ──
    if (rankSnapshotsByMatch.length >= 11) {
      const totalSnapshots = rankSnapshotsByMatch.length;
      const snapshotBefore = rankSnapshotsByMatch[totalSnapshots - 11];
      const snapshotCurrent = rankSnapshotsByMatch[totalSnapshots - 1];

      function computeRankMap(snapshot: Map<string, number>): Map<string, number> {
        const sorted = [...snapshot.entries()]
          .map(([uid, pts]) => ({ uid, total: pts + (nonMatchPointsByUser.get(uid) ?? 0) }))
          .sort((a, b) => b.total - a.total);
        const rankMap = new Map<string, number>();
        for (let i = 0; i < sorted.length; i++) {
          const rank = i === 0 || sorted[i].total < sorted[i - 1].total ? i + 1 : rankMap.get(sorted[i - 1].uid)!;
          rankMap.set(sorted[i].uid, rank);
        }
        return rankMap;
      }

      const ranksBefore = computeRankMap(snapshotBefore);
      const ranksCurrent = computeRankMap(snapshotCurrent);

      type RankChange = { userId: string; username: string; imageUrl: string | null; iconColor: string | null; spotsClimbed: number };
      const rankChanges: RankChange[] = [];
      for (const [userId, currentRank] of ranksCurrent) {
        const previousRank = ranksBefore.get(userId);
        if (previousRank === undefined) continue;
        const userInfo = leaderUserInfo.get(userId);
        if (!userInfo) continue;
        rankChanges.push({ userId, ...userInfo, spotsClimbed: previousRank - currentRank });
      }

      const maxClimbed = rankChanges.length > 0 ? Math.max(...rankChanges.map(r => r.spotsClimbed)) : 0;
      if (maxClimbed >= 2) {
        const climbers = rankChanges
          .filter(r => r.spotsClimbed === maxClimbed)
          .sort((a, b) => a.username.localeCompare(b.username));
        theClimberCard = {
          id: 'theClimber',
          title: lang === 'no' ? 'Det klatres!' : lang === 'de' ? 'Der Aufsteiger' : 'The Climber',
          statistic:
            lang === 'no'
              ? `${formatUserList(climbers.map(u => u.username), lang)} har klatret ${maxClimbed} ${maxClimbed === 1 ? 'plass' : 'plasser'} på tabellen de siste 10 kampene!`
              : lang === 'de'
                ? `${formatUserList(climbers.map(u => u.username), lang)} ist in den letzten 10 Spielen um ${maxClimbed} ${maxClimbed === 1 ? 'Platz' : 'Plätze'} aufgestiegen!`
                : `${formatUserList(climbers.map(u => u.username), lang)} ${climbers.length === 1 ? 'has' : 'have'} climbed ${maxClimbed} ${maxClimbed === 1 ? 'spot' : 'spots'} on the leaderboard over the last 10 games!`,
          subjects: climbers.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
          linkType: 'leaderboard',
        };
      }

      const maxFell = rankChanges.length > 0 ? Math.max(...rankChanges.map(r => -r.spotsClimbed)) : 0;
      if (maxFell >= 2) {
        const fallers = rankChanges
          .filter(r => -r.spotsClimbed === maxFell)
          .sort((a, b) => a.username.localeCompare(b.username));
        theFallerCard = {
          id: 'theFaller',
          title: lang === 'no' ? 'Rett åt skogen' : lang === 'de' ? 'Tabellenabsteiger' : "I'm falling!",
          statistic:
            lang === 'no'
              ? `${formatUserList(fallers.map(u => u.username), lang)} har falt ${maxFell} ${maxFell === 1 ? 'plass' : 'plasser'} på tabellen de siste 10 kampene!`
              : lang === 'de'
                ? `${formatUserList(fallers.map(u => u.username), lang)} ist in den letzten 10 Spielen um ${maxFell} ${maxFell === 1 ? 'Platz' : 'Plätze'} abgefallen!`
                : `${formatUserList(fallers.map(u => u.username), lang)} ${fallers.length === 1 ? 'has' : 'have'} dropped ${maxFell} ${maxFell === 1 ? 'spot' : 'spots'} on the leaderboard over the last 10 games!`,
          subjects: fallers.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
          linkType: 'leaderboard',
        };
      }
    }

    // ── Knockout Specialist: biggest rank improvement from group stage ranking to KO ranking ──
    {
      const activeForKo = memberRows.filter(m => !activeStatUserIds || activeStatUserIds.has(m.userId));
      if (activeForKo.length >= 4) {
        const withPoints = activeForKo.map(row => ({
          userId: row.userId,
          username: row.username,
          imageUrl: row.imageUrl,
          iconColor: row.iconColor ?? null,
          groupPoints: row.exactScorePoints + row.correctResultPoints,
          koPoints:
            row.correctTeamProgressesPoints +
            row.correctTeamInKnockoutTiePoints +
            row.correctTeamInFinalPoints +
            row.correctWinnerPoints,
        }));

        const anyKoPoints = withPoints.some(u => u.koPoints > 0);
        if (anyKoPoints) {
          function rankPlayers(players: typeof withPoints, key: 'groupPoints' | 'koPoints'): Map<string, number> {
            const sorted = [...players].sort((a, b) => b[key] - a[key]);
            const ranks = new Map<string, number>();
            for (let i = 0; i < sorted.length; i++) {
              const rank = i === 0 || sorted[i][key] < sorted[i - 1][key] ? i + 1 : ranks.get(sorted[i - 1].userId)!;
              ranks.set(sorted[i].userId, rank);
            }
            return ranks;
          }

          const groupRanks = rankPlayers(withPoints, 'groupPoints');
          const koRanks = rankPlayers(withPoints, 'koPoints');

          const candidates = withPoints
            .filter(u => u.koPoints > 0)
            .map(u => ({ ...u, rankImprovement: groupRanks.get(u.userId)! - koRanks.get(u.userId)! }));

          const maxRankImprovement = candidates.length > 0 ? Math.max(...candidates.map(u => u.rankImprovement)) : 0;
          if (maxRankImprovement > 0) {
            const specialists = candidates
              .filter(u => u.rankImprovement === maxRankImprovement)
              .sort((a, b) => a.username.localeCompare(b.username));
            knockoutSpecialistCard = {
              id: 'knockoutSpecialist',
              title: lang === 'no' ? 'Best når det gjelder' : lang === 'de' ? 'K.O.-Spezialist' : 'The Knockout Specialist',
              statistic:
                lang === 'no'
                  ? `${formatUserList(specialists.map(u => u.username), lang)} sleit i gruppespillet, men virkelig best når det gjelder! ${maxRankImprovement} plasser bedre rangert i sluttspillet enn i gruppespillet!`
                  : lang === 'de'
                    ? `${formatUserList(specialists.map(u => u.username), lang)} ${specialists.length === 1 ? 'kämpfte' : 'kämpften'} in der Gruppe, aber ${specialists.length === 1 ? 'glänzte' : 'glänzten'} im K.O.! ${maxRankImprovement} ${maxRankImprovement === 1 ? 'Platz' : 'Plätze'} besser als in der Gruppenphase!`
                    : `${formatUserList(specialists.map(u => u.username), lang)} struggled in the group stage but turned it around in the knockouts — ${maxRankImprovement} ${maxRankImprovement === 1 ? 'place' : 'places'} higher in the knockout rankings than in the group stage!`,
              subjects: specialists.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
              linkType: 'leaderboard',
            };
          }
        }
      }
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
            iconColor: users.iconColor,
            groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices,
          })
          .from(competitionMembers)
          .innerJoin(users, eq(competitionMembers.userId, users.id))
          .where(and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false), eq(users.isComparisonUser, false)));

        const memberChoiceRows = activeStatUserIds
          ? allMemberChoiceRows.filter(m => activeStatUserIds!.has(m.userId))
          : allMemberChoiceRows;

        const memberInfoByUserId = new Map(
          memberChoiceRows.map(m => [m.userId, { userId: m.userId, username: m.username, imageUrl: m.imageUrl, iconColor: m.iconColor ?? null }])
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
                : lang === 'de'
                  ? ` ${formatUserList(worstGroup.map(u => u.username), lang)} hatte nur ${minCorrect} richtig. Peinlich.`
                  : ` ${formatUserList(worstGroup.map(u => u.username), lang)} had the fewest correct, with only ${minCorrect}.`;
          }

          groupStageGuruCard = {
            id: 'groupStageGuru',
            title: lang === 'no' ? 'Gruppespill-Geni' : lang === 'de' ? 'Gruppenphase-Genie' : 'Group Stage Guru',
            statistic:
              (lang === 'no'
                ? `${formatUserList(bestGroup.map(u => u.username), lang)} tippet ${maxCorrect} av ${totalTeamCount} lag i riktig posisjon i gruppespillet!`
                : lang === 'de'
                  ? `${formatUserList(bestGroup.map(u => u.username), lang)} hat ${maxCorrect} von ${totalTeamCount} Teams in der richtigen Gruppenposition getippt! Beeindruckend für jemanden ohne Kristallkugel.`
                  : `${formatUserList(bestGroup.map(u => u.username), lang)} predicted ${maxCorrect} out of ${totalTeamCount} teams in their correct final group position!`) +
              worstSentence,
            subjects: bestGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor ?? null })),
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
          { username: string; imageUrl: string | null; iconColor: string | null; wins: number; gf: number; ga: number }
        >();
        for (const row of activeRows) {
          if (!norwayMatchIds.has(row.matchId)) continue;
          const norwayIsHome = norwayHomeByMatch.get(row.matchId);
          const predNorwayGoals = norwayIsHome ? row.predHomeScore : row.predAwayScore;
          const predOpponentGoals = norwayIsHome ? row.predAwayScore : row.predHomeScore;
          const entry =
            patriotStatsByUser.get(row.userId) ?? { username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null, wins: 0, gf: 0, ga: 0 };
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
                : lang === 'de'
                  ? `nur ${winner.ga} Gegentore kassiert!`
                  : `conceded only ${winner.ga}!`
              : lang === 'no'
                ? 'uten å slippe inn ett eneste mål!'
                : lang === 'de'
                  ? 'kein einziges Gegentor kassiert!'
                  : 'without conceding a single goal!';

          thePatriotCard = {
            id: 'thePatriot',
            title: lang === 'no' ? 'Patrioten 🇳🇴' : lang === 'de' ? 'Norwegen-Fanatiker 🇳🇴' : 'The Patriot 🇳🇴',
            statistic:
              lang === 'no'
                ? `${formatUserList(patriotGroup.map(u => u.username), lang)} er den største patrioten! De har tippet at Norge har vunnet ${winner.wins} av sine ${norwayMatches.length} kamper så langt! Og at de har scoret hele ${winner.gf} mål og ${concededClause}`
                : lang === 'de'
                  ? `${formatUserList(patriotGroup.map(u => u.username), lang)} ist der größte Norwegen-Fan von allen! Norwegen gewinnt laut ${patriotGroup.length === 1 ? 'ihm/ihr' : 'ihnen'} sage und schreibe ${winner.wins} von ${norwayMatches.length} Spielen und schießt dabei stolze ${winner.gf} Tore — und hat dabei ${concededClause}`
                  : `${formatUserList(patriotGroup.map(u => u.username), lang)} ${patriotGroup.length === 1 ? 'is the biggest patriot' : 'are the biggest patriots'}! They've predicted that Norway has won ${winner.wins} of their ${norwayMatches.length} games so far! And that they've scored a whopping ${winner.gf} goals and ${concededClause}`,
            subjects: patriotGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
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
      perfectScorers: { userId: string; username: string; imageUrl: string | null; iconColor: string | null }[];
      resultCount: number;
      wrongPredictors: { userId: string; username: string; imageUrl: string | null; iconColor: string | null; predHomeScore: number; predAwayScore: number }[];
      predictorPoints: { userId: string; username: string; imageUrl: string | null; iconColor: string | null; points: number | null }[];
      predictions: { userId: string; username: string; imageUrl: string | null; iconColor: string | null; predHomeScore: number; predAwayScore: number }[];
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
      stat.predictorPoints.push({ userId: row.userId, username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null, points: row.points });
      stat.predictions.push({
        userId: row.userId,
        username: row.username,
        imageUrl: row.imageUrl,
        iconColor: row.iconColor ?? null,
        predHomeScore: row.predHomeScore,
        predAwayScore: row.predAwayScore,
      });
      if (row.predHomeScore === row.actualHomeScore && row.predAwayScore === row.actualAwayScore) {
        stat.perfectScorers.push({ userId: row.userId, username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null });
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
          iconColor: row.iconColor ?? null,
          predHomeScore: row.predHomeScore,
          predAwayScore: row.predAwayScore,
        });
      }
    }

    // ── Match Made in Heaven: users with perfect scores in ALL games featuring the same team ──
    const userTeamPredStats = new Map<string, Map<string, { total: number; perfect: number; correctResults: number }>>();
    for (const row of activeRows) {
      if (row.actualHomeScore === null || row.actualAwayScore === null) continue;
      const isPerfect = row.predHomeScore === row.actualHomeScore && row.predAwayScore === row.actualAwayScore;
      const actualOutcome = Math.sign(row.actualHomeScore - row.actualAwayScore);
      const predOutcome = Math.sign(row.predHomeScore - row.predAwayScore);
      const isCorrectResult = actualOutcome === predOutcome;
      for (const teamId of [row.homeTeamId, row.awayTeamId]) {
        if (!teamId) continue;
        if (!userTeamPredStats.has(row.userId)) userTeamPredStats.set(row.userId, new Map());
        const teamMap = userTeamPredStats.get(row.userId)!;
        const entry = teamMap.get(teamId) ?? { total: 0, perfect: 0, correctResults: 0 };
        entry.total += 1;
        if (isPerfect) entry.perfect += 1;
        if (isCorrectResult) entry.correctResults += 1;
        teamMap.set(teamId, entry);
      }
    }
    const heavenByTeam = new Map<string, { userId: string; count: number }[]>();
    for (const [userId, teamMap] of userTeamPredStats.entries()) {
      for (const [teamId, stats] of teamMap.entries()) {
        if (stats.total >= 2 && stats.total === stats.perfect) {
          if (!heavenByTeam.has(teamId)) heavenByTeam.set(teamId, []);
          heavenByTeam.get(teamId)!.push({ userId, count: stats.total });
        }
      }
    }

    // Fallback: if no one has a perfect record, find who has the most perfect predictions (min 2)
    // Only users who got the correct result for ALL games for that team are eligible.
    let heavenFallbackMaxPerfect = 0;
    const heavenFallbackByTeam = new Map<string, { userId: string; count: number }[]>();
    if (heavenByTeam.size === 0) {
      for (const teamMap of userTeamPredStats.values()) {
        for (const stats of teamMap.values()) {
          if (stats.perfect >= 2 && stats.correctResults === stats.total && stats.perfect > heavenFallbackMaxPerfect) {
            heavenFallbackMaxPerfect = stats.perfect;
          }
        }
      }
      if (heavenFallbackMaxPerfect >= 2) {
        for (const [userId, teamMap] of userTeamPredStats.entries()) {
          for (const [teamId, stats] of teamMap.entries()) {
            if (stats.perfect === heavenFallbackMaxPerfect && stats.correctResults === stats.total) {
              if (!heavenFallbackByTeam.has(teamId)) heavenFallbackByTeam.set(teamId, []);
              heavenFallbackByTeam.get(teamId)!.push({ userId, count: stats.perfect });
            }
          }
        }
      }
    }

    const heavenActiveByTeam = heavenByTeam.size > 0 ? heavenByTeam : heavenFallbackByTeam;
    const heavenIsFallback = heavenByTeam.size === 0 && heavenFallbackByTeam.size > 0;
    const heavenTeamIds = new Set<string>(heavenActiveByTeam.keys());

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
              : lang === 'de'
                ? ` Während ${formatUserList(lowestPredictorGroup.map(u => u.username), lang)} mit ${minPredicted} Toren gerechnet hat. Ein Pessimist, der tatsächlich recht hat.`
                : ` Meanwhile ${formatUserList(lowestPredictorGroup.map(u => u.username), lang)} ${lowestPredictorGroup.length === 1 ? 'has' : 'have'} predicted that only ${minPredicted} ${minPredicted === 1 ? 'goal' : 'goals'} should've been scored by now.`
            : '';

        theOptimistCard = {
          id: 'theOptimist',
          title: lang === 'no' ? 'Optimisten' : lang === 'de' ? 'Der Optimist' : 'The Optimist',
          statistic:
            (lang === 'no'
              ? `${formatUserList(highestPredictorGroup.map(u => u.username), lang)} har tippet at det totalt skulle vært scoret ${maxPredicted} mål på dette tidspunktet! Bare ${actualTotalGoals} mål har faktisk blitt scoret.`
              : lang === 'de'
                ? `${formatUserList(highestPredictorGroup.map(u => u.username), lang)} hat insgesamt ${maxPredicted} Tore erwartet! Tatsächlich wurden nur ${actualTotalGoals} erzielt. Lebt wohl in einer eigenen kleinen Traumwelt.`
                : `${formatUserList(highestPredictorGroup.map(u => u.username), lang)} ${highestPredictorGroup.length === 1 ? 'has' : 'have'} predicted that a total of ${maxPredicted} ${maxPredicted === 1 ? 'goal' : 'goals'} should have been scored by this point! Only ${actualTotalGoals} ${actualTotalGoals === 1 ? 'goal' : 'goals'} ${actualTotalGoals === 1 ? 'has' : 'have'} actually been scored.`) +
            lowestSentence,
          subjects: highestPredictorGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
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
      users: { userId: string; username: string; imageUrl: string | null; iconColor: string | null }[];
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
      swingPredictionGroups.get(key)!.users.push({ userId: row.userId, username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor ?? null });
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

    // ── The Audience Darling: most predicted tournament winner ──
    const audienceDarlingBpRows = await db
      .select({ userId: bracketPredictions.userId, predictions: bracketPredictions.predictions })
      .from(bracketPredictions)
      .where(eq(bracketPredictions.competitionId, id));

    const winnerPredsByTeam = new Map<string, { userId: string; username: string; imageUrl: string | null; iconColor: string | null }[]>();
    for (const bp of audienceDarlingBpRows) {
      if (activeStatUserIds && !activeStatUserIds.has(bp.userId)) continue;
      if (!userInfo.has(bp.userId)) continue;
      const preds = bp.predictions as BracketPredictions;
      for (const [key, pred] of Object.entries(preds)) {
        if (key.startsWith('final_') && pred.progressingTeamId) {
          if (!winnerPredsByTeam.has(pred.progressingTeamId)) winnerPredsByTeam.set(pred.progressingTeamId, []);
          const info = userInfo.get(bp.userId)!;
          winnerPredsByTeam.get(pred.progressingTeamId)!.push({ userId: bp.userId, username: info.username, imageUrl: info.imageUrl, iconColor: info.iconColor });
          break;
        }
      }
    }

    const neededTeamIds = new Set<string>();
    for (const m of [bestPredictionMatch, worstPredictionMatch, unexpectedMatch, mostPredictableMatch, contrastMatch, swingAndAMissData]) {
      if (m?.homeTeamId) neededTeamIds.add(m.homeTeamId);
      if (m?.awayTeamId) neededTeamIds.add(m.awayTeamId);
    }
    for (const teamId of heavenTeamIds) neededTeamIds.add(teamId);
    for (const teamId of winnerPredsByTeam.keys()) neededTeamIds.add(teamId);
    const teamRows =
      neededTeamIds.size > 0 ? await db.select().from(teams).where(inArray(teams.id, [...neededTeamIds])) : [];
    const teamNameMap = new Map(teamRows.map(t => [t.id, t.name]));
    const teamImageMap = new Map(teamRows.map(t => [t.id, t.imageUrl]));
    const teamName = (teamId: string | null) => (teamId ? teamNameMap.get(teamId) ?? 'Unknown' : 'Unknown');

    if (winnerPredsByTeam.size > 0) {
      const norwayId = norwayTeam?.id;
      const sortedWinnerTeams = [...winnerPredsByTeam.entries()].sort((a, b) => {
        const diff = b[1].length - a[1].length;
        return diff !== 0 ? diff : teamName(a[0]).localeCompare(teamName(b[0]));
      });

      const topEntry = sortedWinnerTeams[0];
      const isNorwayFirst = !!norwayId && topEntry[0] === norwayId;
      const topCount = topEntry[1].length;
      const tiedForFirst = sortedWinnerTeams.filter(([, predictors]) => predictors.length === topCount);
      const isTieWithNorway = !!norwayId && tiedForFirst.length > 1 && tiedForFirst.some(([teamId]) => teamId === norwayId);
      // Filter Norway only when it is strictly alone at the top (not tied)
      const shouldFilterNorway = isNorwayFirst && !isTieWithNorway;

      let statistic: string;
      let cardIconImageUrl: string | null;
      let cardSubjects: Array<{ type: 'user' | 'team'; id: string; name: string; imageUrl?: string | null; iconColor?: string | null }>;
      let featuredTeamIds: Set<string>;

      if (isTieWithNorway) {
        const andWord = lang === 'no' ? 'og' : lang === 'de' ? 'und' : 'and';
        const tiedNames = tiedForFirst.map(([teamId]) => `**${teamName(teamId)}**`);
        const teamsString =
          tiedNames.length === 2
            ? `${tiedNames[0]} ${andWord} ${tiedNames[1]}`
            : `${tiedNames.slice(0, -1).join(', ')}, ${andWord} ${tiedNames[tiedNames.length - 1]}`;

        const bothAll = lang === 'no'
          ? (tiedForFirst.length === 2 ? 'begge' : 'alle')
          : lang === 'de'
            ? (tiedForFirst.length === 2 ? 'beide' : 'alle')
            : (tiedForFirst.length === 2 ? 'both' : 'all');

        statistic = lang === 'no'
          ? `${teamsString} er ${bothAll} de mest tippede vinnerne med **${topCount}** ${topCount === 1 ? 'spiller' : 'spillere'} hver!`
          : lang === 'de'
            ? `${teamsString} sind ${bothAll} die meistgetippten Turniersieger mit jeweils **${topCount}** ${topCount === 1 ? 'Spieler' : 'Spielern'}!`
            : `${teamsString} are ${bothAll} tied as the most predicted winners with **${topCount}** prediction${topCount === 1 ? '' : 's'} each!`;

        cardSubjects = tiedForFirst.map(([teamId]) => ({
          type: 'team' as const,
          id: teamId,
          name: teamName(teamId),
          imageUrl: teamImageMap.get(teamId) ?? null,
        }));
        cardIconImageUrl = null;
        featuredTeamIds = new Set(tiedForFirst.map(([teamId]) => teamId));
      } else {
        const norwayCount = shouldFilterNorway ? topEntry[1].length : 0;
        const mainEntry = shouldFilterNorway ? (sortedWinnerTeams[1] ?? topEntry) : topEntry;

        const [mainTeamId, mainPredictors] = mainEntry;
        const mainTeamDisplayName = teamName(mainTeamId);
        const mainCount = mainPredictors.length;
        const sortedMainPredictors = [...mainPredictors].sort((a, b) => a.username.localeCompare(b.username));
        const mainUserList = formatUserList(sortedMainPredictors.map(u => u.username), lang);

        statistic =
          lang === 'no'
            ? `**${mainTeamDisplayName}** er den mest tippede vinneren! Totalt **${mainCount}** ${mainCount === 1 ? 'spiller' : 'spillere'}: ${mainUserList} har tippet at de vil vinne turneringen.`
            : lang === 'de'
              ? `**${mainTeamDisplayName}** ist der meistgetippte Turniersieger! Satte **${mainCount}** ${mainCount === 1 ? 'Spieler hat' : 'Spieler haben'} getippt, dass sie gewinnen werden: ${mainUserList}.`
              : `**${mainTeamDisplayName}** is the most predicted winner! A total of **${mainCount}** ${mainCount === 1 ? 'user' : 'users'}: ${mainUserList} ${mainCount === 1 ? 'has' : 'have'} predicted that they will win the tournament.`;

        if (shouldFilterNorway && mainEntry !== topEntry) {
          statistic +=
            lang === 'no'
              ? ` Bortsett fra Norge da! **${norwayCount}** ${norwayCount === 1 ? 'spiller' : 'spillere'} har tippet at Norge vinner det hele!`
              : lang === 'de'
                ? ` Außer Norwegen natürlich! **${norwayCount}** ${norwayCount === 1 ? 'Spieler hat' : 'Spieler haben'} getippt, dass Norwegen das Turnier gewinnt!`
                : ` Except for Norway of course! **${norwayCount}** ${norwayCount === 1 ? 'person has' : 'people have'} predicted that Norway will win the whole thing!`;
        }

        cardSubjects = [];
        cardIconImageUrl = teamImageMap.get(mainTeamId) ?? null;
        featuredTeamIds = new Set([mainTeamId]);
        if (shouldFilterNorway && norwayId) featuredTeamIds.add(norwayId);
      }

      const soloTeams = sortedWinnerTeams
        .filter(([teamId, predictors]) => predictors.length === 1 && !featuredTeamIds.has(teamId))
        .sort(([idA], [idB]) => teamName(idA).localeCompare(teamName(idB)));

      if (soloTeams.length > 0) {
        const soloClauses = soloTeams.map(([teamId, predictors]) =>
          lang === 'no'
            ? `**${predictors[0].username}**, for øvrig, er den eneste som har tippet at **${teamName(teamId)}** skal gå hele veien`
            : lang === 'de'
              ? `**${predictors[0].username}** ist der einzige Spieler, der auf **${teamName(teamId)}** als Gesamtsieger getippt hat`
              : `**${predictors[0].username}** is the only player to predict **${teamName(teamId)}** to go all the way`
        );
        const andWord = lang === 'no' ? 'og' : lang === 'de' ? 'und' : 'and';
        let soloText: string;
        if (soloClauses.length === 1) {
          soloText = `${soloClauses[0]}!`;
        } else if (soloClauses.length === 2) {
          soloText = `${soloClauses[0]}, ${andWord} ${soloClauses[1]}!`;
        } else {
          soloText = `${soloClauses.slice(0, -1).join(', ')}, ${andWord} ${soloClauses[soloClauses.length - 1]}!`;
        }
        const meanwhilePrefix = lang === 'no' ? '' : lang === 'de' ? 'Außerdem, ' : 'Meanwhile, ';
        statistic += ` ${meanwhilePrefix}${soloText}`;
      }

      audienceDarlingCard = {
        id: 'audienceDarling',
        title: lang === 'no' ? 'Publikumsfavoritten' : lang === 'de' ? 'Der Publikumsliebling' : 'The Audience Darling',
        statistic,
        subjects: cardSubjects,
        linkType: null,
        iconImageUrl: cardIconImageUrl,
      };
    }

    if (bestPredictionMatch) {
      const homeTeamName = teamName(bestPredictionMatch.homeTeamId);
      const awayTeamName = teamName(bestPredictionMatch.awayTeamId);
      const winner = bestPredictionMatch.perfectScorers[0];
      const resultText =
        lang === 'no'
          ? bestPredictionMatch.resultCount === 1
            ? 'Ingen andre fikk i det hele tatt riktig resultat!'
            : `Bare ${bestPredictionMatch.resultCount} spillere fikk i det hele tatt riktig resultat!`
          : lang === 'de'
            ? bestPredictionMatch.resultCount === 1
              ? 'Kein anderer hat überhaupt das richtige Ergebnis getippt!'
              : `Nur ${bestPredictionMatch.resultCount} Leute haben überhaupt das richtige Ergebnis getippt!`
            : bestPredictionMatch.resultCount === 1
              ? 'No one else even got the correct result!'
              : `Only ${bestPredictionMatch.resultCount} players even got the result right!`;

      bestPredictionCard = {
        id: 'bestPrediction',
        title: lang === 'no' ? 'Synsk' : lang === 'de' ? 'Wahrsager' : 'Best prediction',
        statistic:
          lang === 'no'
            ? `**${winner.username}** tippet eksakt resultat på ${homeTeamName} mot ${awayTeamName} (${bestPredictionMatch.homeScore}-${bestPredictionMatch.awayScore})! ${resultText}`
            : lang === 'de'
              ? `**${winner.username}** hat ${homeTeamName} gegen ${awayTeamName} (${bestPredictionMatch.homeScore}-${bestPredictionMatch.awayScore}) exakt vorhergesagt! ${resultText}`
              : `**${winner.username}** got a perfect score on ${homeTeamName} vs ${awayTeamName} (${bestPredictionMatch.homeScore} - ${bestPredictionMatch.awayScore})! ${resultText}`,
        subjects: [{ type: 'user', id: winner.userId, name: winner.username, imageUrl: winner.imageUrl, iconColor: winner.iconColor }],
        linkType: 'match',
        matchId: bestPredictionMatch.matchId,
      };
    }

    unluckyCard = {
      id: 'unlucky',
      title: lang === 'no' ? 'Uflaks' : lang === 'de' ? 'Pech gehabt' : 'Unlucky',
      statistic:
        unluckyGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(unluckyGroup.map(u => u.username), lang)} har vært bare ett mål unna å tippe eksakt resultat ${topUnluckyCount} ${topUnluckyCount === 1 ? 'gang' : 'ganger'}!` +
              (nextUnluckyGroup.length > 0
                ? ` ${nextUnluckyGroup.length === 1 ? 'Den' : 'De'} nest mest uheldige er ${formatUserList(nextUnluckyGroup.map(u => u.username), lang)} med ${nextUnluckyCount}.`
                : '')
            : lang === 'de'
              ? `${formatUserList(unluckyGroup.map(u => u.username), lang)} war ${topUnluckyCount} Mal nur ein Tor vom Volltreffer entfernt! Das Schicksal ist manchmal wirklich grausam.` +
                (nextUnluckyGroup.length > 0
                  ? ` Die zweitunglücklichsten sind ${formatUserList(nextUnluckyGroup.map(u => u.username), lang)} mit ${nextUnluckyCount}.`
                  : '')
              : `${formatUserList(unluckyGroup.map(u => u.username), lang)} ${unluckyGroup.length === 1 ? 'has' : 'have'} been one goal away from predicting a perfect score ${topUnluckyCount} ${topUnluckyCount === 1 ? 'time' : 'times'}!` +
                (nextUnluckyGroup.length > 0
                  ? ` The next unluckiest ${nextUnluckyGroup.length === 1 ? 'is' : 'are'} ${formatUserList(nextUnluckyGroup.map(u => u.username), lang)} with ${nextUnluckyCount}.`
                  : '')
          : lang === 'no'
            ? 'Ingen har vært ett mål fra et eksakt resultat ennå!'
            : lang === 'de'
              ? 'Noch niemand war nur ein Tor vom Volltreffer entfernt!'
              : 'No one has been one goal away from a perfect score yet!',
      subjects: unluckyGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
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
          : lang === 'de'
            ? `${formatUserList(group.map(p => p.username), lang)} hat getippt ${outcome}`
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
          : lang === 'de'
            ? `${wrongClauses.join('; ')}.` +
              (worstPredictionMatch.resultCount > 0 ? ` Alle anderen lagen richtig: ${correctOutcome}.` : '')
            : `${wrongClauses.join('; ')}.` +
              (worstPredictionMatch.resultCount > 0 ? ` Everyone else correctly predicted ${correctOutcome}.` : '');

      worstPredictionCard = {
        id: 'worstPrediction',
        title: lang === 'no' ? 'Skivebom' : lang === 'de' ? 'Katastrophentipp' : 'Worst prediction',
        statistic,
        subjects: sortedWrongGroups
          .flat()
          .map(p => ({ type: 'user' as const, id: p.userId, name: p.username, imageUrl: p.imageUrl, iconColor: p.iconColor })),
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
        title: lang === 'no' ? 'Sjokkresultat' : lang === 'de' ? 'Schockresultat' : 'Most unexpected result',
        statistic:
          lang === 'no'
            ? `Ingen tippet ${actualOutcome}! ${namesText} tippet til og med ${predictedOutcome} (${worstDeviationGroup[0].predHomeScore}-${worstDeviationGroup[0].predAwayScore})!`
            : lang === 'de'
              ? `Niemand hat ${actualOutcome} vorhergesagt! ${namesText} hat sogar ${predictedOutcome} (${worstDeviationGroup[0].predHomeScore}-${worstDeviationGroup[0].predAwayScore}) getippt!`
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
            : lang === 'de'
              ? ` Und trotzdem hat ${formatUserList(zeroPointUsers.map(u => u.username), lang)} 0 Punkte geholt. Wie?`
              : ` Still ${formatUserList(zeroPointUsers.map(u => u.username), lang)} earned 0 points.`;
      } else if (onePointUsers.length >= 1 && onePointUsers.length <= 4) {
        appendText =
          lang === 'no'
            ? ` Likevel sanket ${formatUserList(onePointUsers.map(u => u.username), lang)} bare 1 poeng.`
            : lang === 'de'
              ? ` Und trotzdem hat ${formatUserList(onePointUsers.map(u => u.username), lang)} nur 1 Punkt geholt. Traurig.`
              : ` Still ${formatUserList(onePointUsers.map(u => u.username), lang)} earned only 1 point.`;
      }

      mostPredictableResultCard = {
        id: 'mostPredictableResult',
        title: lang === 'no' ? 'Forventet resultat' : lang === 'de' ? 'Na klar!' : 'The most expected result',
        statistic:
          (lang === 'no'
            ? `${homeTeamName} mot ${awayTeamName} (${mostPredictableMatch.homeScore}-${mostPredictableMatch.awayScore}) var det mest forutsigbare resultatet! Totalt tippet ${resultCount} ${resultCount === 1 ? 'spiller' : 'spillere'} riktig resultat, og ${exactCount} av dem tippet eksakt resultat! Hver spiller sanket i snitt ${avgPoints} poeng.`
            : lang === 'de'
              ? `${homeTeamName} gegen ${awayTeamName} (${mostPredictableMatch.homeScore}-${mostPredictableMatch.awayScore}) — so offensichtlich, dass sogar ein Blindgänger es hätte tippen können! ${resultCount} Leute lagen richtig, ${exactCount} davon sogar mit exaktem Ergebnis. Im Schnitt ${avgPoints} Punkte pro Person.`
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
        if (diff === 0) return lang === 'no' ? 'uavgjort' : lang === 'de' ? 'Unentschieden' : 'a draw';
        const winnerName = diff > 0 ? homeTeamName : awayTeamName;
        const margin = Math.abs(diff);
        return lang === 'no'
          ? `${winnerName} vinne med ${margin} mål`
          : lang === 'de'
            ? `${winnerName} gewinnt mit ${margin} Tor${margin === 1 ? '' : 'en'}`
            : `${winnerName} to win by ${margin} ${margin === 1 ? 'goal' : 'goals'}`;
      };

      mostContrastingPredictionCard = {
        id: 'mostContrastingPrediction',
        title: lang === 'no' ? 'Natt Og Dag' : lang === 'de' ? 'Wie Tag und Nacht' : 'Most Contrasting Predictions',
        statistic:
          lang === 'no'
            ? `Det største spriket i tippingen så langt kom i kampen mellom ${homeTeamName} og ${awayTeamName}, hvor ${formatUserList(highGroup.map(u => u.username), lang)} tippet ${highGroup[0].predHomeScore}-${highGroup[0].predAwayScore} og ${formatUserList(lowGroup.map(u => u.username), lang)} tippet ${lowGroup[0].predHomeScore}-${lowGroup[0].predAwayScore}! Kampen endte til slutt med ${contrastMatch.homeScore}-${contrastMatch.awayScore}.`
            : lang === 'de'
              ? `Bei ${homeTeamName} gegen ${awayTeamName} (${contrastMatch.homeScore}-${contrastMatch.awayScore}) waren die Meinungen gespalten! ${formatUserList(highGroup.map(u => u.username), lang)} tippte ${describeGoalDiff(maxDiff)}, während ${formatUserList(lowGroup.map(u => u.username), lang)} auf ${describeGoalDiff(minDiff)} setzte — eine Differenz von ${contrastGap} Toren!`
              : `${homeTeamName} vs ${awayTeamName} (${contrastMatch.homeScore} - ${contrastMatch.awayScore}) caused the most contrasting predictions! ${formatUserList(highGroup.map(u => u.username), lang)} predicted ${describeGoalDiff(maxDiff)}, while ${formatUserList(lowGroup.map(u => u.username), lang)} predicted ${describeGoalDiff(minDiff)} — a ${contrastGap}-goal swing!`,
        subjects: [...highGroup, ...lowGroup].map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
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
        title: lang === 'no' ? 'Det var nesten da!' : lang === 'de' ? 'Knapp daneben!' : 'Swing and a Miss',
        statistic:
          lang === 'no'
            ? `Kampen mellom ${homeTeamName} og ${awayTeamName} endte ${swingAndAMissData.homeScore} - ${swingAndAMissData.awayScore}, bare litt annerledes enn hva ${userNames} tippet, som trodde kampen skulle ende ${swingAndAMissData.predHomeScore} - ${swingAndAMissData.predAwayScore}.`
            : lang === 'de'
              ? `Das Spiel ${homeTeamName} gegen ${awayTeamName} endete ${swingAndAMissData.homeScore} - ${swingAndAMissData.awayScore} — nur eine Kleinigkeit anders als ${userNames} gedacht hatte, der auf ${swingAndAMissData.predHomeScore} - ${swingAndAMissData.predAwayScore} tippte. Nah dran, aber leider nein.`
              : `The match between ${homeTeamName} and ${awayTeamName} ended ${swingAndAMissData.homeScore} - ${swingAndAMissData.awayScore}, just a little different from what ${userNames} predicted, who thought the match would end ${swingAndAMissData.predHomeScore} - ${swingAndAMissData.predAwayScore}.`,
        subjects: swingAndAMissData.users.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
        linkType: 'match',
        matchId: swingAndAMissData.matchId,
      };
    }

    hitOrMissCard = {
      id: 'hitOrMiss',
      title: lang === 'de' ? 'Alles oder Nichts' : 'Hit or Miss',
      statistic:
        hitOrMissGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(hitOrMissGroup.map(u => u.username), lang)} har "bare" tippet korrekt resultat ${hitOrMissGroup[0].correctResults} ${hitOrMissGroup[0].correctResults === 1 ? 'gang' : 'ganger'}, men ${hitOrMissGroup[0].exactScores} av de har vært fulltreffere!`
            : lang === 'de'
              ? `${formatUserList(hitOrMissGroup.map(u => u.username), lang)} hat zwar nur ${hitOrMissGroup[0].correctResults} richtige Ergebnisse, aber davon waren ${hitOrMissGroup[0].exactScores} exakte Volltreffer! Hochrisikosstrategie.`
              : `${hitOrMissGroup[0].exactScores} out of ${formatUserList(hitOrMissGroup.map(u => u.username), lang)}'s ${hitOrMissGroup[0].correctResults} have been perfect predictions!`
          : lang === 'no'
            ? 'Ingen har tippet minst to perfekte resultater ennå!'
            : lang === 'de'
              ? 'Noch niemand hat mindestens zwei exakte Ergebnisse getippt!'
              : 'No one has predicted at least two perfect scores yet!',
      subjects: hitOrMissGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
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
    const closeButNoCigarTailDe =
      closeButNoCigarGroup.length > 0 && closeButNoCigarGroup[0].exactScores > 0
        ? `hat es nur ${closeButNoCigarGroup[0].exactScores} Mal exakt getroffen!`
        : 'hat noch nie exakt getroffen!';

    closeButNoCigarCard = {
      id: 'closeButNoCigar',
      title: lang === 'de' ? 'Fast perfekt' : 'Slow and Steady',
      statistic:
        closeButNoCigarGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(closeButNoCigarGroup.map(u => u.username), lang)} har tippet riktig resultat ${closeButNoCigarGroup[0].correctResults} ${closeButNoCigarGroup[0].correctResults === 1 ? 'gang' : 'ganger'}, men ${closeButNoCigarTailNo}`
            : lang === 'de'
              ? `${formatUserList(closeButNoCigarGroup.map(u => u.username), lang)} hat ${closeButNoCigarGroup[0].correctResults} Mal das richtige Ergebnis getippt, aber beim exakten Ergebnis — da hapert es gewaltig. ${closeButNoCigarTailDe}`
              : `${formatUserList(closeButNoCigarGroup.map(u => u.username), lang)} ${closeButNoCigarVerb} predicted the correct result ${closeButNoCigarGroup[0].correctResults} times, but ${closeButNoCigarVerb} ${closeButNoCigarTail}`
          : lang === 'no'
            ? 'Ingen har tippet riktig resultat ennå!'
            : lang === 'de'
              ? 'Noch niemand hat ein richtiges Ergebnis getippt!'
              : 'No one has predicted a correct result yet!',
      subjects: closeButNoCigarGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
      linkType: 'user',
    };

    bestFormCard = {
      id: 'bestForm',
      title: lang === 'no' ? 'I fyr og flamme 🔥' : lang === 'de' ? 'Formrakete 🔥' : 'Best form',
      statistic:
        bestFormGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(bestFormGroup.map(u => u.username), lang)} har sanket ${bestFormGroup[0].points} poeng de siste 5 kampene!`
            : lang === 'de'
              ? `${formatUserList(bestFormGroup.map(u => u.username), lang)} hat in den letzten 5 Spielen ${bestFormGroup[0].points} Punkte eingesammelt! Heiß wie eine Bratwurst auf dem Grill.`
              : `${formatUserList(bestFormGroup.map(u => u.username), lang)} ${bestFormGroup.length === 1 ? 'has' : 'have'} gained ${bestFormGroup[0].points} points in the last 5 matches!`
          : lang === 'no'
            ? 'Ingen kamper er fullført ennå!'
            : lang === 'de'
              ? 'Noch keine Spiele abgeschlossen!'
              : 'No matches have been completed yet!',
      subjects: bestFormGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
      linkType: 'user',
    };

    if (worstFormGroup.length > 0) {
      worstFormCard = {
        id: 'worstForm',
        title: lang === 'no' ? 'Send Hjelp' : lang === 'de' ? 'Hilfe senden' : 'Worst form',
        statistic:
          lang === 'no'
            ? `${formatUserList(worstFormGroup.map(u => u.username), lang)} har gått ${worstFormGroup[0].drought} kamper på rad uten å sanke et eneste poeng!`
            : lang === 'de'
              ? `${formatUserList(worstFormGroup.map(u => u.username), lang)} hat ${worstFormGroup[0].drought} Spiele in Folge keinen einzigen Punkt geholt! Bitte ruft professionelle Hilfe!`
              : `${formatUserList(worstFormGroup.map(u => u.username), lang)} ${worstFormGroup.length === 1 ? 'has' : 'have'} gone ${worstFormGroup[0].drought} matches without gaining a single point!`,
        subjects: worstFormGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor })),
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
          iconColor: users.iconColor,
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
        .map(row => ({ userId: row.userId, username: row.username, imageUrl: row.imageUrl, iconColor: row.iconColor, goals: Number(row.answer) }))
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

        const goalCountMap = new Map<number, number>();
        for (const p of haalandPredictions) goalCountMap.set(p.goals, (goalCountMap.get(p.goals) ?? 0) + 1);
        const distributionData: { value: number; count: number }[] = [];
        for (let v = 0; v <= maxGoals + 1; v++) distributionData.push({ value: v, count: goalCountMap.get(v) ?? 0 });

        const haalandActualGoals = (haalandPlayer && haalandPlayer.gamesPlayed >= 1) ? haalandPlayer.goalsScored : null;

        brautometerCard = {
          id: 'brautometer',
          title: lang === 'no' ? 'Brautometeret' : lang === 'de' ? 'Der Brautometer' : 'The Brautometer',
          statistic:
            lang === 'no'
              ? `Deltakerne har i gjennomsnitt tippet at Haaland kommer til å score ${average.toFixed(2)} mål i turneringen. ${formatUserList(mostFaithGroup.map(u => u.username), lang)} har mest tro og tror han kommer til å score utrolige ${maxGoals} mål! Mens ${formatUserList(leastFaithGroup.map(u => u.username), lang)} tror han bare kommer til å score ${minGoals} mål.`
              : lang === 'de'
                ? `Die Teilnehmer haben im Schnitt ${average.toFixed(2)} Haaland-Tore erwartet. ${formatUserList(mostFaithGroup.map(u => u.username), lang)} glaubt am meisten an ihn und tippt sagenhafter ${maxGoals} Tore! ${formatUserList(leastFaithGroup.map(u => u.username), lang)} hingegen glaubt er trifft nur ${minGoals} Mal. Einer von ihnen irrt sich gewaltig.`
                : `The participants have on average predicted that Haaland will score ${average.toFixed(2)} goals in the tournament. ${formatUserList(mostFaithGroup.map(u => u.username), lang)} ${mostFaithGroup.length === 1 ? 'has' : 'have'} the most faith and ${mostFaithGroup.length === 1 ? 'believes' : 'believe'} he will score an incredible ${maxGoals} goals! While ${formatUserList(leastFaithGroup.map(u => u.username), lang)} only ${leastFaithGroup.length === 1 ? 'believes' : 'believe'} he will score ${minGoals} goals.`,
          subjects: mostFaithGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor ?? null })),
          linkType: 'userBonus',
          iconImageUrl: '/haaland.jpg',
          distributionData,
          distributionActualValue: haalandActualGoals,
        };

        if (haalandActualGoals !== null) {
          const goals = haalandActualGoals;
          const games = haalandPlayer!.gamesPlayed;
          brautometerCard.statistic +=
            lang === 'no'
              ? ` Haaland har så langt scoret ${goals} ${goals === 1 ? 'mål' : 'mål'} på ${games} ${games === 1 ? 'kamp' : 'kamper'}.`
              : lang === 'de'
                ? ` Haaland hat bisher ${goals} Tor${goals === 1 ? '' : 'e'} in ${games} Spiel${games === 1 ? '' : 'en'} erzielt.`
                : ` Haaland has so far scored ${goals} ${goals === 1 ? 'goal' : 'goals'} in ${games} ${games === 1 ? 'game' : 'games'}.`;
        }
      }
    }

    // ── Ja vi elsker: user(s) who predicted Norway to win the tournament ──
    if (norwayTeam) {
      const norwayId = norwayTeam.id;
      const bpRows = await db
        .select({ userId: bracketPredictions.userId, predictions: bracketPredictions.predictions })
        .from(bracketPredictions)
        .where(eq(bracketPredictions.competitionId, id));

      const believers = bpRows
        .filter(bp => {
          if (activeStatUserIds && !activeStatUserIds.has(bp.userId)) return false;
          if (!userInfo.has(bp.userId)) return false;
          const preds = bp.predictions as BracketPredictions;
          return Object.entries(preds).some(
            ([key, pred]) => key.startsWith('final_') && pred.progressingTeamId === norwayId,
          );
        })
        .map(bp => ({ userId: bp.userId, ...userInfo.get(bp.userId)! }))
        .sort((a, b) => a.username.localeCompare(b.username));

      if (believers.length > 0) {
        const names = formatUserList(believers.map(u => u.username), lang);
        jaViElskerCard = {
          id: 'ja-vi-elsker',
          title: 'Ja vi elsker 🇳🇴',
          statistic:
            lang === 'no'
              ? `${names} tror faktisk at Norge kommer til å vinne hele turneringen!`
              : lang === 'de'
                ? `${names} glaubt tatsächlich, dass Norwegen das gesamte Turnier gewinnt! Norwegischer Patriotismus kennt keine Grenzen.`
                : `${names} actually ${believers.length === 1 ? 'believes' : 'believe'} that Norway will win the entire tournament!`,
          subjects: believers.map(u => ({
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

    // ── The Traitor: user(s) who predicted Norway eliminated earliest ──
    // Uses Norway's group stage predictions to determine whether they qualified
    // (any of 1st/2nd/3rd place), then checks bracket predictions for later stages.
    // This correctly distinguishes "4th in group = eliminated" from "3rd as lucky loser
    // but then lost in R32", which pure bracket-scan cannot.
    if (norwayTeam) {
      const norwayId = norwayTeam.id;
      const KNOCKOUT_STAGES_ORDERED = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final'];
      const STAGE_RANK_TRAITOR: Record<string, number> = {
        group: 0, round_of_32: 1, round_of_16: 2, quarter_final: 3, semi_final: 4, final: 5, winner: 6,
      };

      // Step 1: find Norway's group and all matches within it
      const [traitorBpRows, [norwayTeamRow]] = await Promise.all([
        db.select({ userId: bracketPredictions.userId, predictions: bracketPredictions.predictions })
          .from(bracketPredictions).where(eq(bracketPredictions.competitionId, id)),
        db.select({ groupId: teams.groupId })
          .from(teams).where(and(eq(teams.tournamentId, competition.tournamentId), eq(teams.id, norwayId))),
      ]);

      const norwayGroupId = norwayTeamRow?.groupId ?? null;
      let norwayGroupTeamIds: string[] = [];
      type NorwayGroupMatch = { id: string; homeTeamId: string; awayTeamId: string };
      let norwayGroupMatchData: NorwayGroupMatch[] = [];
      const norwayGroupPredsByUser = new Map<
        string,
        Map<string, { homeScore: number; awayScore: number; homeTeamId: string; awayTeamId: string }>
      >();

      if (norwayGroupId) {
        const [groupTeamRows, allGroupMatchRows] = await Promise.all([
          db.select({ id: teams.id })
            .from(teams).where(and(eq(teams.tournamentId, competition.tournamentId), eq(teams.groupId, norwayGroupId))),
          db.select({ id: matches.id, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId })
            .from(matches).where(and(eq(matches.tournamentId, competition.tournamentId), eq(matches.stage, 'group'))),
        ]);

        norwayGroupTeamIds = groupTeamRows.map(t => t.id);
        const norwayGroupTeamSet = new Set(norwayGroupTeamIds);
        norwayGroupMatchData = allGroupMatchRows.filter(
          m => m.homeTeamId && m.awayTeamId
            && norwayGroupTeamSet.has(m.homeTeamId)
            && norwayGroupTeamSet.has(m.awayTeamId),
        ) as NorwayGroupMatch[];

        const norwayGroupMatchIds = norwayGroupMatchData.map(m => m.id);
        if (norwayGroupMatchIds.length > 0) {
          const groupPredRows = await db
            .select({ userId: predictions.userId, matchId: predictions.matchId, homeScore: predictions.homeScore, awayScore: predictions.awayScore })
            .from(predictions)
            .where(and(
              eq(predictions.competitionId, id),
              inArray(predictions.matchId, norwayGroupMatchIds),
              eq(predictions.isReplacement, false),
            ));

          const matchDataMap = new Map(norwayGroupMatchData.map(m => [m.id, m]));
          for (const pred of groupPredRows) {
            if (!norwayGroupPredsByUser.has(pred.userId)) norwayGroupPredsByUser.set(pred.userId, new Map());
            const md = matchDataMap.get(pred.matchId);
            if (md) {
              norwayGroupPredsByUser.get(pred.userId)!.set(pred.matchId, {
                homeScore: pred.homeScore, awayScore: pred.awayScore,
                homeTeamId: md.homeTeamId, awayTeamId: md.awayTeamId,
              });
            }
          }
        }
      }

      // Returns 0-indexed position of Norway in their group based on user predictions.
      // Returns null if the user made no group predictions for Norway's group.
      const getNorwayGroupPos = (userId: string): number | null => {
        if (!norwayGroupId || norwayGroupTeamIds.length === 0) return null;
        const userPreds = norwayGroupPredsByUser.get(userId);
        if (!userPreds || userPreds.size === 0) return null;

        const stats = new Map(norwayGroupTeamIds.map(tid => [tid, { pts: 0, gd: 0, gf: 0 }]));
        for (const { homeTeamId, awayTeamId, homeScore, awayScore } of userPreds.values()) {
          const home = stats.get(homeTeamId);
          const away = stats.get(awayTeamId);
          if (!home || !away) continue;
          if (homeScore > awayScore) home.pts += 3;
          else if (homeScore === awayScore) { home.pts += 1; away.pts += 1; }
          else away.pts += 3;
          home.gd += homeScore - awayScore; home.gf += homeScore;
          away.gd += awayScore - homeScore; away.gf += awayScore;
        }

        const sorted = [...stats.entries()].sort((a, b) =>
          b[1].pts !== a[1].pts ? b[1].pts - a[1].pts :
          b[1].gd  !== a[1].gd  ? b[1].gd  - a[1].gd  :
          b[1].gf  - a[1].gf,
        );
        const pos = sorted.findIndex(([tid]) => tid === norwayId);
        return pos >= 0 ? pos : null;
      };

      const userEliminations = new Map<string, { eliminatedAt: string; rank: number }>();

      for (const bp of traitorBpRows) {
        if (activeStatUserIds && !activeStatUserIds.has(bp.userId)) continue;
        if (!userInfo.has(bp.userId)) continue;

        const bpPreds = bp.predictions as BracketPredictions;
        const norwayGroupPos = getNorwayGroupPos(bp.userId);

        let eliminatedAt: string;

        if (norwayGroupPos !== null && norwayGroupPos >= norwayGroupTeamIds.length - 1) {
          // Norway predicted last in their group → definitely eliminated in group stage
          eliminatedAt = 'group';
        } else {
          // Norway is 1st/2nd/3rd (or no group data) → check bracket predictions for wins
          let lastSurvivedStageIdx = -1;
          for (let si = 0; si < KNOCKOUT_STAGES_ORDERED.length; si++) {
            const stage = KNOCKOUT_STAGES_ORDERED[si];
            const norwayWon = Object.entries(bpPreds).some(
              ([key, pred]) => key.startsWith(`${stage}_`) && pred.progressingTeamId === norwayId,
            );
            if (norwayWon) lastSurvivedStageIdx = si;
          }

          if (lastSurvivedStageIdx === -1) {
            // Norway didn't win any bracket match
            if (norwayGroupPos !== null) {
              // Group data says Norway was 1st–3rd → they were in R32 but lost there
              eliminatedAt = 'round_of_32';
            } else {
              // No group data and no bracket win → can't tell; treat as group elimination
              eliminatedAt = 'group';
            }
          } else if (lastSurvivedStageIdx === KNOCKOUT_STAGES_ORDERED.length - 1) {
            eliminatedAt = 'winner';
          } else {
            eliminatedAt = KNOCKOUT_STAGES_ORDERED[lastSurvivedStageIdx + 1];
          }
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
          const stageLabelMap: Record<string, { no: string; en: string; de: string }> = {
            group: { no: 'gruppespillet', en: 'the group stage', de: 'der Gruppenphase' },
            round_of_32: { no: 'sekstendelsfinalen', en: 'the round of 32', de: 'der Runde der 32' },
            round_of_16: { no: 'runde 16', en: 'the round of 16', de: 'dem Achtelfinale' },
          };
          const stageLabelNo = stageLabelMap[minStage]?.no ?? minStage;
          const stageLabelEn = stageLabelMap[minStage]?.en ?? minStage;
          const stageLabelDe = stageLabelMap[minStage]?.de ?? minStage;
          const traitorNames = formatUserList(traitors.map(u => u.username), lang);

          traitorCard = {
            id: 'traitor',
            title: lang === 'no' ? 'Landssvikeren' : lang === 'de' ? 'Der Verräter' : 'The Traitor',
            statistic:
              lang === 'no'
                ? `${traitorNames} trodde faktisk at Norge ville bli slått ut allerede i ${stageLabelNo}!`
                : lang === 'de'
                  ? `${traitorNames} dachte allen Ernstes, Norwegen würde schon in ${stageLabelDe} ausscheiden! Das nennt man Pessimismus.`
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

    if (heavenActiveByTeam.size > 0) {
      // Invert to user → [{teamId, count}] so one user with multiple teams stays on one line
      const userToTeams = new Map<string, { teamId: string; count: number }[]>();
      for (const [teamId, entries] of heavenActiveByTeam.entries()) {
        for (const { userId, count } of entries) {
          if (!userToTeams.has(userId)) userToTeams.set(userId, []);
          userToTeams.get(userId)!.push({ teamId, count });
        }
      }
      for (const teams of userToTeams.values()) {
        teams.sort((a, b) => teamName(a.teamId).localeCompare(teamName(b.teamId)));
      }

      // Group users who share the exact same set of teams into one line
      const lineGroups = new Map<string, { teamIds: string[]; counts: number[]; userIds: string[] }>();
      for (const [userId, teams] of userToTeams.entries()) {
        const key = teams.map(t => t.teamId).join('|');
        if (!lineGroups.has(key)) {
          lineGroups.set(key, { teamIds: teams.map(t => t.teamId), counts: teams.map(t => t.count), userIds: [] });
        }
        lineGroups.get(key)!.userIds.push(userId);
      }

      const sortedGroups = [...lineGroups.values()]
        .map(g => ({
          teamIds: g.teamIds,
          counts: g.counts,
          users: g.userIds.map(uid => ({ uid, ...userInfo.get(uid)! })).sort((a, b) => a.username.localeCompare(b.username)),
        }))
        .sort((a, b) => teamName(a.teamIds[0]).localeCompare(teamName(b.teamIds[0])));

      const allCounts = sortedGroups.flatMap(g => g.counts);
      const firstCount = allCounts[0];
      const allSameCount = allCounts.every(c => c === firstCount);

      const heavenSubjects = sortedGroups.flatMap(g =>
        g.users.map(u => ({ type: 'user' as const, id: u.uid, name: u.username, imageUrl: u.imageUrl, iconColor: u.iconColor }))
      );

      const joinTeamNames = (tIds: string[]): string => {
        const bolded = tIds.map(id => `**${teamName(id)}**`);
        const andWord = lang === 'no' ? 'og' : lang === 'de' ? 'und' : 'and';
        if (bolded.length === 1) return bolded[0];
        if (bolded.length === 2) return `${bolded[0]} ${andWord} ${bolded[1]}`;
        return `${bolded.slice(0, -1).join(', ')}, ${andWord} ${bolded[bolded.length - 1]}`;
      };

      const buildConnectionLine = (users: typeof sortedGroups[0]['users'], tIds: string[]): string => {
        const userNames = formatUserList(users.map(u => u.username), lang);
        const teams = joinTeamNames(tIds);
        if (heavenIsFallback) {
          const n = firstCount;
          if (lang === 'no') return `${userNames} har tippet eksakt resultat ${n} ${n === 1 ? 'gang' : 'ganger'} for ${teams}!`;
          if (lang === 'de') return `${userNames} ${users.length === 1 ? 'hat' : 'haben'} ${n} Mal das exakte Ergebnis für ${teams} getippt!`;
          return `${userNames} ${users.length === 1 ? 'has' : 'have'} predicted the exact score ${n} ${n === 1 ? 'time' : 'times'} for ${teams}!`;
        }
        if (lang === 'no') return `${userNames} har en åndelig forbindelse med ${teams}!`;
        if (lang === 'de') return `${userNames} ${users.length === 1 ? 'hat' : 'haben'} eine spirituelle Verbindung mit ${teams}!`;
        return `${userNames} ${users.length === 1 ? 'has' : 'have'} a spiritual connection with ${teams}!`;
      };

      const buildCountPhrase = (): string => {
        if (allSameCount) {
          if (lang === 'no') return `alle ${firstCount} ${firstCount === 1 ? 'kamp' : 'kamper'} de har spilt`;
          if (lang === 'de') return `allen ${firstCount} ${firstCount === 1 ? 'Spiel' : 'Spielen'}, die sie gespielt haben`;
          return `all ${firstCount} ${firstCount === 1 ? 'game' : 'games'} they have played`;
        }
        if (lang === 'no') return 'alle kampene de har spilt';
        if (lang === 'de') return 'allen Spielen, die sie gespielt haben';
        return 'all the games they have played';
      };

      const gamesLine = heavenIsFallback
        ? (lang === 'no'
          ? 'Det er flest eksakte resultater for ett enkelt lag!'
          : lang === 'de'
            ? 'Das sind die meisten exakten Treffer für ein einzelnes Team!'
            : 'That\'s the most perfect score predictions for any single team!')
        : (lang === 'no'
          ? `De har gjettet eksakt resultat i ${buildCountPhrase()}!`
          : lang === 'de'
            ? `Sie haben in ${buildCountPhrase()} das perfekte Ergebnis getippt!`
            : `They have guessed the perfect score in ${buildCountPhrase()}!`);

      let heavenStatistic: string;
      if (sortedGroups.length === 1) {
        heavenStatistic = `${buildConnectionLine(sortedGroups[0].users, sortedGroups[0].teamIds)} ${gamesLine}`;
      } else {
        const lines = sortedGroups.map(g => buildConnectionLine(g.users, g.teamIds));
        heavenStatistic = lines.join('\n') + '\n' + gamesLine;
      }

      matchMadeInHeavenCard = {
        id: 'matchMadeInHeaven',
        title: 'Match made in heaven',
        statistic: heavenStatistic,
        subjects: heavenSubjects,
        linkType: 'user',
      };
    }

    const cards = [
      theLeaderCard,
      bottomOfTheLeagueCard,
      theClimberCard,
      theFallerCard,
      knockoutSpecialistCard,
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
      jaViElskerCard,
      traitorCard,
      brautometerCard,
      matchMadeInHeavenCard,
      audienceDarlingCard,
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

    const [targetUser] = await db.select({ username: users.username, imageUrl: users.imageUrl, iconColor: users.iconColor }).from(users).where(eq(users.id, userId));
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const preds = await db
      .select()
      .from(predictions)
      .where(and(eq(predictions.competitionId, id), eq(predictions.userId, userId)));

    res.json({ predictions: preds, username: targetUser.username, imageUrl: targetUser.imageUrl ?? null, iconColor: targetUser.iconColor ?? null });
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

