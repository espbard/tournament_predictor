import { and, desc, eq, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client.js';
import { competitionMembers, competitions, matches, predictions, tournaments, users } from '../db/schema.js';
import { liveCompetitionMembers, liveCompetitions } from '../db/liveSchema.js';

// ── Joining a competition ─────────────────────────────────────────────────────
//
// One place for "add this user to this competition", shared by the two doors into a
// competition: the invite code (POST /api/competitions/join, POST /api/live/competitions/join)
// and the share link (POST /api/invites/:token/accept). The rules that decide whether a
// join is allowed — a closed tournament, a passed deadline, the late-addition handling —
// must not differ between the two, so they live here rather than in a route handler.

type Competition = typeof competitions.$inferSelect;
type LiveCompetition = typeof liveCompetitions.$inferSelect;

export type JoinResult<T> =
  | { ok: true; competition: T; alreadyMember: boolean }
  | { ok: false; status: number; error: string };

/**
 * Add a user to a manual competition.
 *
 * `alreadyMember` is reported rather than treated as an error: a share link that a member
 * opens twice should land them in the competition, not on an error page. Callers that
 * need the stricter behaviour (the invite-code form answers 409) check the flag.
 */
export async function joinManualCompetition(
  competition: Competition,
  userId: string,
): Promise<JoinResult<Competition>> {
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, competition.tournamentId));

  // Read isLateAddition directly from DB to avoid stale session values
  const [dbUser] = await db
    .select({ isLateAddition: users.isLateAddition })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const isLateAdditionJoin = (dbUser?.isLateAddition ?? false) && tournament?.status === 'active';

  const [existing] = await db
    .select()
    .from(competitionMembers)
    .where(and(eq(competitionMembers.competitionId, competition.id), eq(competitionMembers.userId, userId)));
  // Checked before the gates below: someone who is already in stays in, even once the
  // tournament has moved on and a fresh join would be refused.
  if (existing) return { ok: true, competition, alreadyMember: true };

  if (tournament && tournament.status === 'completed') {
    return { ok: false, status: 403, error: 'This competition is no longer open for new members' };
  }

  if (isLateAdditionJoin && !competition.allowLateAdditions) {
    return { ok: false, status: 403, error: 'This competition does not allow late additions' };
  }

  if (!isLateAdditionJoin && tournament && tournament.status !== 'upcoming') {
    return { ok: false, status: 403, error: 'This competition is no longer open for new members' };
  }

  if (!isLateAdditionJoin && competition.predictionDeadline && new Date() > new Date(competition.predictionDeadline)) {
    return { ok: false, status: 403, error: 'The prediction deadline for this competition has passed' };
  }

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

  return { ok: true, competition, alreadyMember: false };
}

/**
 * Add a user to a live competition.
 *
 * Nothing to gate on: the live type locks per fixture, so a league is open to newcomers
 * for as long as it runs. A late joiner simply has no predictions for what has already
 * kicked off.
 */
export async function joinLiveCompetition(
  competition: LiveCompetition,
  userId: string,
): Promise<JoinResult<LiveCompetition>> {
  const [existing] = await db
    .select({ id: liveCompetitionMembers.id })
    .from(liveCompetitionMembers)
    .where(
      and(
        eq(liveCompetitionMembers.liveCompetitionId, competition.id),
        eq(liveCompetitionMembers.userId, userId),
      ),
    );
  if (existing) return { ok: true, competition, alreadyMember: true };

  await db.insert(liveCompetitionMembers).values({
    id: generateId(15),
    liveCompetitionId: competition.id,
    userId,
  });
  return { ok: true, competition, alreadyMember: false };
}
