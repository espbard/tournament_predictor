import { Router } from 'express';
import { eq, and, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client.js';
import { competitions, competitionMembers, users, tournaments, predictions, matches, teams, bracketPredictions, bonusQuestions, bonusAnswers } from '../db/schema.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { CreateCompetitionSchema, CreatePredictionSchema, SaveBracketPredictionsSchema, DEFAULT_SCORING_CONFIG, SaveBonusAnswerSchema } from '@tournament-predictor/shared';
import type { UserStatCardData } from '@tournament-predictor/shared';
import { recalculateAllScoresForTournament } from '../lib/scoringTrigger.js';
import { subscribeLeaderboard, unsubscribeLeaderboard } from '../lib/leaderboardEvents.js';

const router = Router();

function generateInviteCode(): string {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

type Lang = 'en' | 'no';

function formatUserList(names: string[], lang: Lang): string {
  const and = lang === 'no' ? 'og' : 'and';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} ${and} ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, ${and} ${names[names.length - 1]}`;
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

    if (tournament && tournament.status !== 'upcoming') {
      return res.status(403).json({ error: 'This competition is no longer open for new members' });
    }

    if (competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
      return res.status(403).json({ error: 'The prediction deadline for this competition has passed' });
    }

    const userId: string = res.locals.user.id;
    const [existing] = await db
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, competition.id), eq(competitionMembers.userId, userId)));
    if (existing) return res.status(409).json({ error: 'Already a member of this competition' });

    await db.insert(competitionMembers).values({
      competitionId: competition.id,
      userId,
    });

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

    const { name, imageUrl, predictionDeadline } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl ?? null;
    if (predictionDeadline !== undefined) {
      updates.predictionDeadline = predictionDeadline ? new Date(predictionDeadline) : null;
    }

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

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const rows = await db
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
      })
      .from(competitionMembers)
      .innerJoin(users, eq(competitionMembers.userId, users.id))
      .where(and(eq(competitionMembers.competitionId, id), eq(users.isLeaderboardUser, false)));

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
        row.bonusQuestionPoints,
    }));
    rowsWithTotal.sort((a, b) => b.totalPoints - a.totalPoints);

    let rank = 1;
    const leaderboard = rowsWithTotal.map((row, i) => {
      if (i > 0 && row.totalPoints < rowsWithTotal[i - 1].totalPoints) rank = i + 1;
      return {
        userId: row.userId,
        username: row.username,
        imageUrl: row.imageUrl,
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
        },
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

    const [competition] = await db.select().from(competitions).where(eq(competitions.id, id));
    if (!competition) return res.status(404).json({ error: 'Competition not found' });

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    const rows = await db
      .select({
        matchId: predictions.matchId,
        userId: predictions.userId,
        username: users.username,
        imageUrl: users.imageUrl,
        homeScore: predictions.homeScore,
        awayScore: predictions.awayScore,
        progressingTeamId: predictions.progressingTeamId,
        points: predictions.points,
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
        and(
          eq(predictions.competitionId, id),
          eq(matches.status, 'completed'),
          eq(users.isLeaderboardUser, false)
        )
      );

    res.json(rows);
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
          eq(users.isLeaderboardUser, false)
        )
      );

    const oneGoalAwayCounts = new Map<string, { username: string; imageUrl: string | null; count: number }>();
    for (const row of rows) {
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
    for (const row of rows) {
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
    const pointsByUserMatch = new Map<string, number>();
    for (const row of rows) {
      userInfo.set(row.userId, { username: row.username, imageUrl: row.imageUrl });
      pointsByUserMatch.set(`${row.userId}|${row.matchId}`, row.points ?? 0);
    }

    const recentPointsByUser = new Map<string, number>();
    for (const row of rows) {
      if (!last5MatchIds.has(row.matchId)) continue;
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

    const cards: UserStatCardData[] = [];

    if (kingGroup.length > 0) {
      const gameCount = kingGroup[0].streak;
      cards.push({
        id: 'theLeader',
        title: lang === 'no' ? 'Kongen på haugen' : 'The Leader',
        statistic:
          lang === 'no'
            ? `${formatUserList(kingGroup.map(u => u.username), lang)} har regjert på toppen i ${gameCount} kamp${gameCount === 1 ? '' : 'er'}!`
            : `${formatUserList(kingGroup.map(u => u.username), lang)} ${kingGroup.length === 1 ? 'has' : 'have'} reigned supreme for the last ${gameCount} game${gameCount === 1 ? '' : 's'}!`,
        subjects: kingGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
        linkType: 'leaderboard',
      });
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
    }
    const matchStats = new Map<string, MatchStat>();
    for (const row of rows) {
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
        };
        matchStats.set(row.matchId, stat);
      }
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

    const neededTeamIds = new Set<string>();
    for (const m of [bestPredictionMatch, worstPredictionMatch, unexpectedMatch]) {
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

      cards.push({
        id: 'bestPrediction',
        title: lang === 'no' ? 'Beste tips' : 'Best prediction',
        statistic:
          lang === 'no'
            ? `${winner.username} tippet eksakt resultat på ${homeTeamName} mot ${awayTeamName} (${bestPredictionMatch.homeScore}-${bestPredictionMatch.awayScore})! ${resultText}`
            : `${winner.username} got a perfect score on ${homeTeamName} vs ${awayTeamName} (${bestPredictionMatch.homeScore} - ${bestPredictionMatch.awayScore})! ${resultText}`,
        subjects: [{ type: 'user', id: winner.userId, name: winner.username, imageUrl: winner.imageUrl }],
        linkType: 'match',
        matchId: bestPredictionMatch.matchId,
      });
    }

    cards.push({
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
    });

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

      cards.push({
        id: 'worstPrediction',
        title: lang === 'no' ? 'Dårligste tips' : 'Worst prediction',
        statistic,
        subjects: sortedWrongGroups
          .flat()
          .map(p => ({ type: 'user' as const, id: p.userId, name: p.username, imageUrl: p.imageUrl })),
        linkType: 'match',
        matchId: worstPredictionMatch.matchId,
      });
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

      cards.push({
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
      });
    }

    cards.push({
      id: 'hitOrMiss',
      title: 'Hit or Miss',
      statistic:
        hitOrMissGroup.length > 0
          ? lang === 'no'
            ? `${formatUserList(hitOrMissGroup.map(u => u.username), lang)} har truffet eksakt ${hitOrMissGroup[0].exactScores} av ${hitOrMissGroup[0].correctResults} riktige resultater!`
            : `${hitOrMissGroup[0].exactScores} out of ${formatUserList(hitOrMissGroup.map(u => u.username), lang)}'s ${hitOrMissGroup[0].correctResults} have been perfect predictions!`
          : lang === 'no'
            ? 'Ingen har tippet minst to perfekte resultater ennå!'
            : 'No one has predicted at least two perfect scores yet!',
      subjects: hitOrMissGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
      linkType: 'user',
    });

    const closeButNoCigarVerb = closeButNoCigarGroup.length === 1 ? 'has' : 'have';
    const closeButNoCigarTail =
      closeButNoCigarGroup.length > 0 && closeButNoCigarGroup[0].exactScores > 0
        ? `only managed ${closeButNoCigarGroup[0].exactScores} exact prediction${closeButNoCigarGroup[0].exactScores === 1 ? '' : 's'}!`
        : 'never got an exact score correct!';
    const closeButNoCigarTailNo =
      closeButNoCigarGroup.length > 0 && closeButNoCigarGroup[0].exactScores > 0
        ? `har bare truffet eksakt resultat ${closeButNoCigarGroup[0].exactScores} ${closeButNoCigarGroup[0].exactScores === 1 ? 'gang' : 'ganger'}!`
        : 'har aldri truffet eksakt resultat!';

    cards.push({
      id: 'closeButNoCigar',
      title: 'Close But No Cigar',
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
    });

    cards.push({
      id: 'bestForm',
      title: 'Best form',
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
    });

    if (worstFormGroup.length > 0) {
      cards.push({
        id: 'worstForm',
        title: lang === 'no' ? 'Dårligste form' : 'Worst form',
        statistic:
          lang === 'no'
            ? `${formatUserList(worstFormGroup.map(u => u.username), lang)} har gått ${worstFormGroup[0].drought} kamper på rad uten å sanke et eneste poeng!`
            : `${formatUserList(worstFormGroup.map(u => u.username), lang)} ${worstFormGroup.length === 1 ? 'has' : 'have'} gone ${worstFormGroup[0].drought} matches without gaining a single point!`,
        subjects: worstFormGroup.map(u => ({ type: 'user' as const, id: u.userId, name: u.username, imageUrl: u.imageUrl })),
        linkType: 'user',
      });
    }

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
      .select()
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));

    res.json({
      groupStageLocked: membership?.groupStageLocked ?? false,
      knockoutCompleteSeen: membership?.knockoutCompleteSeen ?? false,
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

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    if (competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
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

    if (match.stage === 'group' && !user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (membership?.groupStageLocked) {
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

    if (competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
      return res.status(400).json({ error: 'Prediction deadline has passed' });
    }

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
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

    if (!user.isAdmin) {
      const [membership] = await db
        .select()
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, id), eq(competitionMembers.userId, user.id)));
      if (!membership) return res.status(403).json({ error: 'Not a member of this competition' });
    }

    if (competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
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

export { router as competitionsRouter };
