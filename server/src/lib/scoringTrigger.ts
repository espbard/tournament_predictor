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

const KNOCKOUT_STAGES = [
  'round_of_32',
  'round_of_16',
  'quarter_final',
  'semi_final',
  'bronze_final',
  'final',
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  allKoMatches.sort((a, b) => {
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

    // --- Group position points (only after admin confirms standings) ---
    let groupPositionPts = 0;
    if (groupStandingsLocked && confirmedGroupStandings) {
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
        if (!pred || pred.flipped) continue;

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

        if (shouldFlip) {
          updatedBracketPreds = { ...updatedBracketPreds, [predKey]: { ...pred, flipped: true } };
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

    // --- First-round knockout tie points (based on predicted group qualifiers) ---
    let correctTeamInFirstRound = 0;
    allFirstRoundMatches.forEach((match, i) => {
      if (match.status !== 'completed') return;
      const { predHomeId, predAwayId } = firstRoundPredTeams[`${firstRound}_${i}`] ?? {};
      for (const actualTeamId of [match.homeTeamId, match.awayTeamId]) {
        if (!actualTeamId) continue;
        if (predHomeId !== actualTeamId && predAwayId !== actualTeamId) continue;
        correctTeamInFirstRound += config.correct_team_in_knockout_tie;
      }
    });

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
        correctTeamInKnockoutTiePoints: koResult.breakdown.correctTeamInKnockoutTie + correctTeamInFirstRound,
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

export async function triggerBonusScoring(questionId: string, tournamentId: string): Promise<void> {
  const [question] = await db
    .select()
    .from(bonusQuestions)
    .where(eq(bonusQuestions.id, questionId))
    .limit(1);
  if (!question || !question.correctAnswer) return;

  // Score answers for this question across all competitions in the tournament
  const allAnswers = await db
    .select()
    .from(bonusAnswers)
    .where(eq(bonusAnswers.questionId, questionId));

  const correctAnswers = parseCorrectAnswers(question.correctAnswer);
  for (const answer of allAnswers) {
    const isCorrect = correctAnswers.some(ca => answer.answer.trim().toLowerCase() === ca.trim().toLowerCase());
    await db
      .update(bonusAnswers)
      .set({ points: isCorrect ? question.points : 0 })
      .where(eq(bonusAnswers.id, answer.id));
  }

  // Recalculate bonusQuestionPoints for all affected competitions
  const allComps = await db
    .select()
    .from(competitions)
    .where(eq(competitions.tournamentId, tournamentId));

  for (const comp of allComps) {
    const memberIds = await getMemberUserIds(comp.id);
    for (const userId of memberIds) {
      const bonusRows = await db
        .select({ points: bonusAnswers.points })
        .from(bonusAnswers)
        .where(and(eq(bonusAnswers.competitionId, comp.id), eq(bonusAnswers.userId, userId)));
      const bonusPts = bonusRows.reduce((sum, r) => sum + (r.points ?? 0), 0);

      await db
        .update(competitionMembers)
        .set({ bonusQuestionPoints: bonusPts })
        .where(and(eq(competitionMembers.competitionId, comp.id), eq(competitionMembers.userId, userId)));
    }
  }
  notifyLeaderboardUpdate(allComps.map(c => c.id));
}
