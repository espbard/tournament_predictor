import { eq, and, inArray } from 'drizzle-orm';
import { notifyLeaderboardUpdate } from './leaderboardEvents.js';
import { db } from '../db/client.js';
import {
  matches,
  predictions,
  competitions,
  competitionMembers,
  bracketPredictions,
  bonusQuestions,
  bonusAnswers,
  teams,
  groups,
  tournaments,
  users,
} from '../db/schema.js';
import {
  calculateMatchPoints,
  computeGroupStandings,
  calculateGroupPositionPoints,
  calculateKnockoutPoints,
  getUserPredictedTeamForKnockoutSlot,
  type KnockoutMatchSlot,
  type FirstRoundPredTeams,
} from './scoring.js';
import { resolveFirstRoundSlots, type KnockoutConfig, type BracketPredictions, type ScoringConfig } from '@tournament-predictor/shared';

export const KNOCKOUT_STAGES = [
  'round_of_32',
  'round_of_16',
  'quarter_final',
  'semi_final',
  'bronze_final',
  'final',
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Loads every knockout-stage match for a tournament, sorted the same way the client's
// knockoutMatchMap sorts them (bracketIndex-first, then scheduledAt) and grouped by
// stage, so `stage_N` bracket-prediction keys align with how users stored their picks.
export async function loadKnockoutMatchesByStage(tournamentId: string): Promise<Map<string, KnockoutMatchSlot[]>> {
  const allKoMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES])));
  allKoMatches.sort((a, b) => {
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

  const matchesByStage = new Map<string, KnockoutMatchSlot[]>();
  for (const m of allKoMatches) {
    if (!matchesByStage.has(m.stage)) matchesByStage.set(m.stage, []);
    matchesByStage.get(m.stage)!.push(m);
  }
  return matchesByStage;
}

// Same as loadKnockoutMatchesByStage, but the first-round slots are replaced with the
// occupants THIS USER predicted (from their own group-stage predictions + tiebreaker
// choices), not the real/actual bracket. This mirrors what the client's bracket editor
// shows while a user is filling in predictions (KnockoutStageContent.tsx's matchTeams,
// which is built entirely from the user's own picks, group stage included) — as opposed
// to getUserPredictedTeamForKnockoutSlot's own first-round base case, which anchors to
// the actual bracket for scoring purposes. Later rounds only ever depend on the user's
// own bracket picks either way, so only the first-round entries need swapping.
export async function loadUserPredictedKnockoutMatchesByStage(
  competitionId: string,
  tournamentId: string,
  userId: string,
): Promise<Map<string, KnockoutMatchSlot[]> | null> {
  const [tournamentRow] = await db
    .select({ knockoutConfig: tournaments.knockoutConfig })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId));
  const koCfg = tournamentRow?.knockoutConfig as KnockoutConfig | null;
  if (!koCfg) return null;

  const matchesByStageActual = await loadKnockoutMatchesByStage(tournamentId);
  const { firstRound, bracketSlots, directQualifiers } = koCfg;
  const firstRoundMatches = matchesByStageActual.get(firstRound) ?? [];

  const [[memberRow], teamRows, groupRows, completedGroupMatches] = await Promise.all([
    db.select({ groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices, luckyLoserChoices: competitionMembers.luckyLoserChoices })
      .from(competitionMembers)
      .where(and(eq(competitionMembers.competitionId, competitionId), eq(competitionMembers.userId, userId))),
    db.select({ id: teams.id, groupId: teams.groupId }).from(teams).where(eq(teams.tournamentId, tournamentId)),
    db.select().from(groups).where(eq(groups.tournamentId, tournamentId)),
    db.select({ id: matches.id, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId })
      .from(matches)
      .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed'))),
  ]);

  const groupNameMap = new Map(groupRows.map(g => [g.id, g.name]));
  const teamGroupMap = new Map<string, string>();
  for (const t of teamRows) {
    if (t.groupId) {
      const gName = groupNameMap.get(t.groupId);
      if (gName) teamGroupMap.set(t.id, gName);
    }
  }

  const groupMatchIds = completedGroupMatches.map(m => m.id);
  const userGroupPreds = groupMatchIds.length > 0
    ? await db
        .select({ matchId: predictions.matchId, homeScore: predictions.homeScore, awayScore: predictions.awayScore })
        .from(predictions)
        .where(and(eq(predictions.competitionId, competitionId), eq(predictions.userId, userId), inArray(predictions.matchId, groupMatchIds)))
    : [];
  const userGroupPredMap = new Map(userGroupPreds.map(p => [p.matchId, p]));

  const simulatedMatches = completedGroupMatches
    .filter(m => m.homeTeamId && m.awayTeamId)
    .flatMap(m => {
      const p = userGroupPredMap.get(m.id);
      return p ? [{ homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId!, homeScore: p.homeScore, awayScore: p.awayScore }] : [];
    });

  const predictedStandings = computeGroupStandings(
    simulatedMatches, teamGroupMap, (memberRow?.groupDisciplinaryChoices ?? {}) as Record<string, string[]>,
  );
  const resolvedSlots = resolveFirstRoundSlots(
    bracketSlots, predictedStandings, directQualifiers, firstRoundMatches.length,
    (memberRow?.luckyLoserChoices ?? {}) as Record<string, string[]>,
  );

  const matchesByStageForPred = new Map<string, KnockoutMatchSlot[]>();
  for (const [stage, ms] of matchesByStageActual) {
    if (stage !== firstRound) { matchesByStageForPred.set(stage, ms); continue; }
    matchesByStageForPred.set(stage, ms.map((m, i) => ({
      id: m.id,
      stage: m.stage,
      homeTeamId: resolvedSlots[`m${i + 1}_home`] ?? null,
      awayTeamId: resolvedSlots[`m${i + 1}_away`] ?? null,
    })));
  }

  return matchesByStageForPred;
}

async function getMemberUserIds(competitionId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: competitionMembers.userId })
    .from(competitionMembers)
    .where(eq(competitionMembers.competitionId, competitionId));
  return rows.map(r => r.userId);
}

// ── Update per-match points on group predictions (for match-level display) ───

async function scoreGroupMatchPredictions(
  matchId: string,
  match: { homeScore: number; awayScore: number; stage: string; progressingTeamId: string | null },
  competitionId: string,
  config: ScoringConfig,
): Promise<void> {
  const preds = await db
    .select()
    .from(predictions)
    .where(and(eq(predictions.matchId, matchId), eq(predictions.competitionId, competitionId)));

  for (const pred of preds) {
    if (pred.isReplacement) continue;
    const result = calculateMatchPoints(
      { homeScore: pred.homeScore, awayScore: pred.awayScore, progressingTeamId: pred.progressingTeamId },
      { homeScore: match.homeScore, awayScore: match.awayScore, stage: match.stage, actualProgressingTeamId: match.progressingTeamId },
      config,
    );
    await db.update(predictions).set({ points: result.points }).where(eq(predictions.id, pred.id));
  }
}

// ── Recompute all per-source breakdown columns for every member ───────────────

async function recomputeAllMemberBreakdowns(
  tournamentId: string,
  competitionId: string,
  config: ScoringConfig,
  firstRound: string,
  bracketSlots: Record<string, string> = {},
  tournamentGroupDisciplinaryChoices: Record<string, string[]> = {},
  directQualifiers = 2,
  groupStandingsLocked = false,
  confirmedGroupStandings: Record<string, string[]> | undefined = undefined,
): Promise<void> {
  // --- Group stage data ---
  const completedGroupMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed')));

  const teamRows = await db
    .select({ id: teams.id, groupId: teams.groupId })
    .from(teams)
    .where(eq(teams.tournamentId, tournamentId));
  const groupRows = await db.select().from(groups).where(eq(groups.tournamentId, tournamentId));
  const groupNameMap = new Map(groupRows.map(g => [g.id, g.name]));
  const teamGroupMap = new Map<string, string>();
  for (const t of teamRows) {
    if (t.groupId) {
      const gName = groupNameMap.get(t.groupId);
      if (gName) teamGroupMap.set(t.id, gName);
    }
  }
  const actualStandings = computeGroupStandings(completedGroupMatches, teamGroupMap, tournamentGroupDisciplinaryChoices);
  const groupMatchIds = completedGroupMatches.map(m => m.id);

  // --- Knockout stage data ---
  const allKoMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES])));
  // Must match the client's knockoutMatchMap sort (bracketIndex-first, then scheduledAt)
  // so that stage_N bracket keys align with how users stored their predictions.
  allKoMatches.sort((a, b) => {
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

  // Fetch all members (including comparison users — they need scoring too)
  const memberRows = await db
    .select({
      userId: competitionMembers.userId,
      groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices,
      luckyLoserChoices: competitionMembers.luckyLoserChoices,
      lateAdditionWindowEndsAt: competitionMembers.lateAdditionWindowEndsAt,
      lateAdditionPoints: competitionMembers.lateAdditionPoints,
      exactScorePoints: competitionMembers.exactScorePoints,
      correctResultPoints: competitionMembers.correctResultPoints,
      correctTeamProgressesPoints: competitionMembers.correctTeamProgressesPoints,
      correctGroupPositionPoints: competitionMembers.correctGroupPositionPoints,
      correctTeamInKnockoutTiePoints: competitionMembers.correctTeamInKnockoutTiePoints,
      correctTeamInFinalPoints: competitionMembers.correctTeamInFinalPoints,
      correctWinnerPoints: competitionMembers.correctWinnerPoints,
      bonusQuestionPoints: competitionMembers.bonusQuestionPoints,
      isLeaderboardUser: users.isLeaderboardUser,
      isComparisonUser: users.isComparisonUser,
    })
    .from(competitionMembers)
    .innerJoin(users, eq(competitionMembers.userId, users.id))
    .where(eq(competitionMembers.competitionId, competitionId));

  // Pre-fetch all group predictions for all members (needed for late addition fallback)
  const allGroupPredRows = groupMatchIds.length > 0
    ? await db
        .select()
        .from(predictions)
        .where(and(eq(predictions.competitionId, competitionId), inArray(predictions.matchId, groupMatchIds)))
    : [];
  const groupPredsByUser = new Map<string, Map<string, typeof allGroupPredRows[number]>>();
  for (const p of allGroupPredRows) {
    if (!groupPredsByUser.has(p.userId)) groupPredsByUser.set(p.userId, new Map());
    groupPredsByUser.get(p.userId)!.set(p.matchId, p);
  }

  // Identify the lowest-scoring regular member (non-late-addition, non-leaderboard, non-comparison)
  // Used as fallback predictions for late addition users' missing group matches
  const regularMembers = memberRows.filter(m => m.lateAdditionWindowEndsAt == null && !m.isLeaderboardUser && !m.isComparisonUser);
  let lowestScorerUserId: string | null = null;
  if (regularMembers.length > 0) {
    let lowestScore = Infinity;
    for (const m of regularMembers) {
      const total = m.exactScorePoints + m.correctResultPoints + m.correctTeamProgressesPoints +
        m.correctGroupPositionPoints + m.correctTeamInKnockoutTiePoints +
        m.correctTeamInFinalPoints + m.correctWinnerPoints + m.bonusQuestionPoints;
      if (total < lowestScore) {
        lowestScore = total;
        lowestScorerUserId = m.userId;
      }
    }
  }
  const lowestScorerPredMap = lowestScorerUserId ? (groupPredsByUser.get(lowestScorerUserId) ?? new Map()) : new Map();

  for (const {
    userId,
    groupDisciplinaryChoices: userGroupDisciplinaryChoices,
    luckyLoserChoices: userLuckyLoserChoices,
    lateAdditionWindowEndsAt,
  } of memberRows) {
    const isLateAdditionMember = lateAdditionWindowEndsAt != null;
    // --- Group match prediction breakdown ---
    const groupPredMap = groupPredsByUser.get(userId) ?? new Map<string, typeof allGroupPredRows[number]>();

    let groupExactScore = 0;
    let groupCorrectResult = 0;
    let groupCorrectTeamProgresses = 0;

    for (const m of completedGroupMatches) {
      const pred = groupPredMap.get(m.id);
      if (!pred || pred.isReplacement || m.homeScore === null || m.awayScore === null) continue;
      const result = calculateMatchPoints(
        { homeScore: pred.homeScore, awayScore: pred.awayScore, progressingTeamId: pred.progressingTeamId },
        { homeScore: m.homeScore, awayScore: m.awayScore, stage: m.stage, actualProgressingTeamId: m.progressingTeamId },
        config,
      );
      groupExactScore += result.breakdown.exactScore;
      groupCorrectResult += result.breakdown.correctResult;
      groupCorrectTeamProgresses += result.breakdown.correctTeamProgresses;
    }

    // --- Predicted group standings (used for group position pts and first-round tie pts) ---
    // For late addition users: fill in missing predictions with the lowest-scorer's predictions
    const simulatedMatches = completedGroupMatches
      .filter(m => m.homeTeamId && m.awayTeamId)
      .flatMap(m => {
        let pred = groupPredMap.get(m.id);
        if (!pred && isLateAdditionMember) {
          pred = lowestScorerPredMap.get(m.id);
        }
        if (!pred) return [];
        return [{ homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId!, homeScore: pred.homeScore, awayScore: pred.awayScore }];
      });
    const predictedStandings = computeGroupStandings(simulatedMatches, teamGroupMap, userGroupDisciplinaryChoices ?? {});

    // --- Group position points (awarded per confirmed group, incrementally) ---
    let groupPositionPts = 0;
    if (confirmedGroupStandings && Object.keys(confirmedGroupStandings).length > 0) {
      const lockedStandings = new Map(
        Object.entries(confirmedGroupStandings).map(([g, ids]) => [g, ids.map(id => ({ teamId: id, points: 0, gd: 0, gf: 0 }))]),
      );
      groupPositionPts = calculateGroupPositionPoints(lockedStandings, predictedStandings, config);
    }

    // --- Knockout bracket breakdown ---
    const [bpRow] = await db
      .select()
      .from(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, competitionId), eq(bracketPredictions.userId, userId)));
    let userBracketPreds: BracketPredictions = bpRow?.predictions ?? {};

    // Build per-user first-round predicted teams (bracket slot labels → team IDs
    // using this user's predicted group standings). Resolves both direct
    // qualifier slots (e.g. "1A") and lucky-loser slots, matching the same
    // cross-group eligibility logic used for the predicted bracket display.
    const firstRoundPredTeams: FirstRoundPredTeams = {};
    const allFirstRoundMatches = allKoMatches.filter(m => m.stage === firstRound);
    const resolvedFirstRoundSlots = resolveFirstRoundSlots(
      bracketSlots,
      predictedStandings,
      directQualifiers,
      allFirstRoundMatches.length,
      userLuckyLoserChoices ?? {},
    );
    allFirstRoundMatches.forEach((match, i) => {
      firstRoundPredTeams[`${firstRound}_${i}`] = {
        predHomeId: resolvedFirstRoundSlots[`m${i + 1}_home`] ?? null,
        predAwayId: resolvedFirstRoundSlots[`m${i + 1}_away`] ?? null,
      };
    });

    // Mark flipped predictions for all completed knockout matches (all rounds).
    // Done here so we have access to per-user predicted standings for first-round
    // slot resolution without an extra DB query loop.
    if (bpRow) {
      const matchesByStageForFlip = new Map<string, KnockoutMatchSlot[]>();
      for (const m of allKoMatches) {
        if (!matchesByStageForFlip.has(m.stage)) matchesByStageForFlip.set(m.stage, []);
        matchesByStageForFlip.get(m.stage)!.push(m);
      }

      let bracketPredsChanged = false;
      let updatedBracketPreds = { ...userBracketPreds };

      for (const m of allKoMatches) {
        if (m.status !== 'completed' || !m.homeTeamId || !m.awayTeamId) continue;
        if (m.stage === 'bronze_final') continue;

        const stageMatches = matchesByStageForFlip.get(m.stage) ?? [];
        const matchIdx = stageMatches.findIndex(sm => sm.id === m.id);
        if (matchIdx < 0) continue;

        const predKey = `${m.stage}_${matchIdx}`;
        const pred = updatedBracketPreds[predKey];
        if (!pred) continue;

        let predHome: string | null = null;
        let predAway: string | null = null;

        if (m.stage === firstRound) {
          predHome = firstRoundPredTeams[predKey]?.predHomeId ?? null;
          predAway = firstRoundPredTeams[predKey]?.predAwayId ?? null;
        } else {
          predHome = getUserPredictedTeamForKnockoutSlot(
            m.stage, matchIdx, 'home', firstRound, matchesByStageForFlip, updatedBracketPreds,
          );
          predAway = getUserPredictedTeamForKnockoutSlot(
            m.stage, matchIdx, 'away', firstRound, matchesByStageForFlip, updatedBracketPreds,
          );
        }

        const shouldFlip =
          (predHome !== null && predHome === m.awayTeamId) ||
          (predAway !== null && predAway === m.homeTeamId);

        if (shouldFlip !== !!pred.flipped) {
          updatedBracketPreds = { ...updatedBracketPreds, [predKey]: { ...pred, flipped: shouldFlip } };
          bracketPredsChanged = true;
        }
      }

      if (bracketPredsChanged) {
        userBracketPreds = updatedBracketPreds;
        await db
          .update(bracketPredictions)
          .set({ predictions: updatedBracketPreds, updatedAt: new Date() })
          .where(and(eq(bracketPredictions.competitionId, competitionId), eq(bracketPredictions.userId, userId)));
      }
    }

    const koResult = calculateKnockoutPoints(
      allKoMatches.map(m => ({
        id: m.id,
        stage: m.stage,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore ?? 0,
        awayScore: m.awayScore ?? 0,
        progressingTeamId: m.progressingTeamId,
        status: m.status,
      })),
      firstRound,
      userBracketPreds,
      config,
      firstRoundPredTeams,
    );

    // --- Bonus question points ---
    const bonusRows = await db
      .select({ points: bonusAnswers.points })
      .from(bonusAnswers)
      .where(and(eq(bonusAnswers.competitionId, competitionId), eq(bonusAnswers.userId, userId)));
    const bonusPts = bonusRows.reduce((sum, r) => sum + (r.points ?? 0), 0);

    await db
      .update(competitionMembers)
      .set({
        exactScorePoints: groupExactScore + koResult.breakdown.exactScore,
        correctResultPoints: groupCorrectResult + koResult.breakdown.correctResult,
        correctTeamProgressesPoints: groupCorrectTeamProgresses + koResult.breakdown.correctTeamProgresses,
        correctGroupPositionPoints: groupPositionPts,
        correctTeamInKnockoutTiePoints: koResult.breakdown.correctTeamInKnockoutTie,
        correctTeamInFinalPoints: koResult.breakdown.correctTeamInFinal,
        correctWinnerPoints: koResult.breakdown.correctWinner,
        bonusQuestionPoints: bonusPts,
      })
      .where(and(eq(competitionMembers.competitionId, competitionId), eq(competitionMembers.userId, userId)));
  }
}

// ── Main scoring trigger (called when a match result is entered) ──────────────

export async function triggerScoringForMatch(matchId: string, tournamentId: string): Promise<void> {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!match || match.status !== 'completed' || match.homeScore === null || match.awayScore === null) return;

  const allComps = await db
    .select()
    .from(competitions)
    .where(eq(competitions.tournamentId, tournamentId));

  const isKnockout = (KNOCKOUT_STAGES as readonly string[]).includes(match.stage);

  const [tourRow] = await db
    .select({ knockoutConfig: tournaments.knockoutConfig })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1);
  const knockoutCfg = tourRow?.knockoutConfig as KnockoutConfig | null;
  const firstRound = knockoutCfg?.firstRound ?? 'round_of_16';
  const bracketSlots = knockoutCfg?.bracketSlots ?? {};
  const tournamentGroupDisciplinaryChoices = knockoutCfg?.groupDisciplinaryChoices ?? {};
  const groupStandingsLocked = knockoutCfg?.groupStandingsLocked ?? false;
  const confirmedGroupStandings = knockoutCfg?.confirmedGroupStandings;

  for (const comp of allComps) {
    const config = comp.scoringConfig as ScoringConfig;

    if (!isKnockout) {
      // Update per-match points on individual prediction rows (used for match-level display)
      await scoreGroupMatchPredictions(
        matchId,
        { homeScore: match.homeScore, awayScore: match.awayScore, stage: match.stage, progressingTeamId: match.progressingTeamId },
        comp.id,
        config,
      );
    }

    // Flip marking and full breakdown recompute (flip marking integrated inside)
    await recomputeAllMemberBreakdowns(
      tournamentId, comp.id, config, firstRound, bracketSlots, tournamentGroupDisciplinaryChoices,
      knockoutCfg?.directQualifiers ?? 2,
      groupStandingsLocked,
      confirmedGroupStandings,
    );
  }
  notifyLeaderboardUpdate(allComps.map(c => c.id));
}

// ── Full recalculate (called from admin "Recalculate Scores" action) ──────────

export async function recalculateAllScoresForTournament(tournamentId: string): Promise<void> {
  const allComps = await db
    .select()
    .from(competitions)
    .where(eq(competitions.tournamentId, tournamentId));

  const [tourRow] = await db
    .select({ knockoutConfig: tournaments.knockoutConfig })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1);
  const knockoutCfgFull = tourRow?.knockoutConfig as KnockoutConfig | null;
  const firstRound = knockoutCfgFull?.firstRound ?? 'round_of_16';
  const bracketSlotsFull = knockoutCfgFull?.bracketSlots ?? {};
  const tournamentGroupDisciplinaryChoicesFull = knockoutCfgFull?.groupDisciplinaryChoices ?? {};
  const groupStandingsLockedFull = knockoutCfgFull?.groupStandingsLocked ?? false;
  const confirmedGroupStandingsFull = knockoutCfgFull?.confirmedGroupStandings;

  const completedGroupMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed')));

  for (const comp of allComps) {
    const config = comp.scoringConfig as ScoringConfig;

    for (const match of completedGroupMatches) {
      if (match.homeScore !== null && match.awayScore !== null) {
        await scoreGroupMatchPredictions(
          match.id,
          { homeScore: match.homeScore, awayScore: match.awayScore, stage: match.stage, progressingTeamId: match.progressingTeamId },
          comp.id,
          config,
        );
      }
    }

    // Flip marking is integrated into recomputeAllMemberBreakdowns
    await recomputeAllMemberBreakdowns(
      tournamentId, comp.id, config, firstRound, bracketSlotsFull, tournamentGroupDisciplinaryChoicesFull,
      knockoutCfgFull?.directQualifiers ?? 2,
      groupStandingsLockedFull,
      confirmedGroupStandingsFull,
    );
  }
  notifyLeaderboardUpdate(allComps.map(c => c.id));
}

// ── Bonus question scoring (called when admin sets correctAnswer) ─────────────

function parseCorrectAnswers(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {}
  return [raw];
}

// Scores a single bonus question's answers, unconditionally. Callers are
// responsible for only invoking this once the tournament is completed —
// bonus points must never be awarded before then.
async function scoreBonusQuestion(question: typeof bonusQuestions.$inferSelect): Promise<void> {
  if (!question.correctAnswer) return;

  const allAnswers = await db
    .select()
    .from(bonusAnswers)
    .where(eq(bonusAnswers.questionId, question.id));

  const correctAnswers = parseCorrectAnswers(question.correctAnswer);
  for (const answer of allAnswers) {
    const isCorrect = correctAnswers.some(ca => answer.answer.trim().toLowerCase() === ca.trim().toLowerCase());
    await db
      .update(bonusAnswers)
      .set({ points: isCorrect ? question.points : 0 })
      .where(eq(bonusAnswers.id, answer.id));
  }
}

// Recomputes the bonusQuestionPoints rollup for every member of the given
// competitions from their current bonusAnswers rows.
async function recomputeBonusQuestionPointsRollup(competitionIds: string[]): Promise<void> {
  for (const compId of competitionIds) {
    const memberIds = await getMemberUserIds(compId);
    for (const userId of memberIds) {
      const bonusRows = await db
        .select({ points: bonusAnswers.points })
        .from(bonusAnswers)
        .where(and(eq(bonusAnswers.competitionId, compId), eq(bonusAnswers.userId, userId)));
      const bonusPts = bonusRows.reduce((sum, r) => sum + (r.points ?? 0), 0);

      await db
        .update(competitionMembers)
        .set({ bonusQuestionPoints: bonusPts })
        .where(and(eq(competitionMembers.competitionId, compId), eq(competitionMembers.userId, userId)));
    }
  }
}

// Called whenever an admin sets/changes a bonus question's correct answer.
// Bonus points are only ever awarded once the tournament has been marked
// completed — until then this is a no-op (the answer is stored, but scoring
// is deferred to scoreAllBonusQuestionsForTournament).
export async function triggerBonusScoring(questionId: string, tournamentId: string): Promise<void> {
  const [tournament] = await db
    .select({ status: tournaments.status })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1);
  if (!tournament || tournament.status !== 'completed') return;

  const [question] = await db
    .select()
    .from(bonusQuestions)
    .where(eq(bonusQuestions.id, questionId))
    .limit(1);
  if (!question) return;

  await scoreBonusQuestion(question);

  const compIds = (
    await db.select({ id: competitions.id }).from(competitions).where(eq(competitions.tournamentId, tournamentId))
  ).map(c => c.id);
  await recomputeBonusQuestionPointsRollup(compIds);
  notifyLeaderboardUpdate(compIds);
}

// Called when a tournament transitions to 'completed'. Scores every bonus
// question that already has a correct answer recorded, awarding the points
// that were withheld while the tournament was still upcoming/active.
export async function scoreAllBonusQuestionsForTournament(tournamentId: string): Promise<void> {
  const questions = await db
    .select()
    .from(bonusQuestions)
    .where(eq(bonusQuestions.tournamentId, tournamentId));

  for (const question of questions) {
    await scoreBonusQuestion(question);
  }

  const compIds = (
    await db.select({ id: competitions.id }).from(competitions).where(eq(competitions.tournamentId, tournamentId))
  ).map(c => c.id);
  await recomputeBonusQuestionPointsRollup(compIds);
  notifyLeaderboardUpdate(compIds);
}
