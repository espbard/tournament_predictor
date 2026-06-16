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

function formatUserList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function describeOutcome(homeTeamName: string, awayTeamName: string, homeScore: number, awayScore: number): string {
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

    const rankedUnlucky = [...oneGoalAwayCounts.entries()]
      .map(([userId, entry]) => ({ userId, ...entry }))
      .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username));
    const unluckiest = rankedUnlucky[0] ?? null;
    const secondUnluckiest = rankedUnlucky[1] ?? null;

    const cards: UserStatCardData[] = [];

    // ── Best/worst prediction: per-match outcome stats ──
    interface MatchStat {
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

    const neededTeamIds = new Set<string>();
    for (const m of [bestPredictionMatch, worstPredictionMatch]) {
      if (m?.homeTeamId) neededTeamIds.add(m.homeTeamId);
      if (m?.awayTeamId) neededTeamIds.add(m.awayTeamId);
    }
    const teamRows =
      neededTeamIds.size > 0 ? await db.select().from(teams).where(inArray(teams.id, [...neededTeamIds])) : [];
    const teamNameMap = new Map(teamRows.map(t => [t.id, t.name]));
    const teamName = (teamId: string | null) => (teamId ? teamNameMap.get(teamId) ?? 'Unknown' : 'Unknown');

    if (bestPredictionMatch) {
      const homeTeamName = teamName(bestPredictionMatch.homeTeamId);
      const awayTeamName = teamName(bestPredictionMatch.awayTeamId);
      const winner = bestPredictionMatch.perfectScorers[0];
      const resultText =
        bestPredictionMatch.resultCount === 1
          ? 'No one else even got the correct result!'
          : `Only ${bestPredictionMatch.resultCount} players even got the result right!`;

      cards.push({
        id: 'bestPrediction',
        title: 'Best prediction!',
        statistic: `${winner.username} got a perfect score on ${homeTeamName} vs ${awayTeamName} (${bestPredictionMatch.homeScore} - ${bestPredictionMatch.awayScore})! ${resultText}`,
        subject: { type: 'user', id: winner.userId, name: winner.username, imageUrl: winner.imageUrl },
      });
    }

    cards.push({
      id: 'unlucky',
      title: 'Unlucky',
      statistic: unluckiest
        ? `${unluckiest.username} has been one goal away from predicting a perfect score ${unluckiest.count} ${unluckiest.count === 1 ? 'time' : 'times'}!` +
          (secondUnluckiest ? ` The second unluckiest is ${secondUnluckiest.username} with ${secondUnluckiest.count}.` : '')
        : 'No one has been one goal away from a perfect score yet!',
      subject: unluckiest
        ? { type: 'user', id: unluckiest.userId, name: unluckiest.username, imageUrl: unluckiest.imageUrl }
        : null,
    });

    if (worstPredictionMatch) {
      const homeTeamName = teamName(worstPredictionMatch.homeTeamId);
      const awayTeamName = teamName(worstPredictionMatch.awayTeamId);

      const wrongGroups = new Map<string, typeof worstPredictionMatch.wrongPredictors>();
      for (const p of worstPredictionMatch.wrongPredictors) {
        const key = `${p.predHomeScore}-${p.predAwayScore}`;
        if (!wrongGroups.has(key)) wrongGroups.set(key, []);
        wrongGroups.get(key)!.push(p);
      }
      let worstGroup = [...wrongGroups.values()][0];
      for (const group of wrongGroups.values()) {
        if (group.length > worstGroup.length) worstGroup = group;
      }
      worstGroup = [...worstGroup].sort((a, b) => a.username.localeCompare(b.username));

      const wrongOutcome = describeOutcome(homeTeamName, awayTeamName, worstGroup[0].predHomeScore, worstGroup[0].predAwayScore);
      const correctOutcome = describeOutcome(
        homeTeamName,
        awayTeamName,
        worstPredictionMatch.homeScore,
        worstPredictionMatch.awayScore
      );
      const namesText = formatUserList(worstGroup.map(p => p.username));

      cards.push({
        id: 'worstPrediction',
        title: 'Worst prediction',
        statistic: `${namesText} predicted ${wrongOutcome} (${worstGroup[0].predHomeScore} - ${worstGroup[0].predAwayScore}). Everyone else predicted ${correctOutcome}.`,
        subject: { type: 'user', id: worstGroup[0].userId, name: worstGroup[0].username, imageUrl: worstGroup[0].imageUrl },
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
