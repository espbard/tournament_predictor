import { eq, and, inArray } from 'drizzle-orm';
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
} from '../db/schema.js';
import {
  calculateMatchPoints,
  computeGroupStandings,
  calculateGroupPositionPoints,
  calculateKnockoutPoints,
  getUserPredictedTeamForKnockoutSlot,
  type TeamStat,
  type KnockoutMatchSlot,
} from './scoring.js';
import type { KnockoutConfig, BracketPredictions, ScoringConfig } from '@tournament-predictor/shared';

// Resolve "1A" / "2B" bracket label against predicted standings → team ID
function resolveQualLabel(label: string, standings: Map<string, TeamStat[]>): string | null {
  const m = label.match(/^(\d+)([A-Z])$/);
  if (!m) return null;
  const pos = parseInt(m[1]) - 1;
  return standings.get(m[2])?.[pos]?.teamId ?? null;
}

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
    const result = calculateMatchPoints(
      { homeScore: pred.homeScore, awayScore: pred.awayScore, progressingTeamId: pred.progressingTeamId },
      { homeScore: match.homeScore, awayScore: match.awayScore, stage: match.stage, actualProgressingTeamId: match.progressingTeamId },
      config,
    );
    await db.update(predictions).set({ points: result.points }).where(eq(predictions.id, pred.id));
  }
}

// ── Mark flipped predictions for a single knockout match ─────────────────────

async function markFlippedKnockoutPredictions(
  matchId: string,
  match: { stage: string; homeTeamId: string | null; awayTeamId: string | null },
  allKoMatches: KnockoutMatchSlot[],
  firstRound: string,
  competitionId: string,
): Promise<void> {
  if (match.stage === firstRound || match.stage === 'bronze_final') return;
  if (!match.homeTeamId || !match.awayTeamId) return;

  const matchesByStage = new Map<string, KnockoutMatchSlot[]>();
  for (const m of allKoMatches) {
    if (!matchesByStage.has(m.stage)) matchesByStage.set(m.stage, []);
    matchesByStage.get(m.stage)!.push(m);
  }

  const stageMatches = matchesByStage.get(match.stage) ?? [];
  const matchIndex = stageMatches.findIndex(sm => sm.id === matchId);
  if (matchIndex < 0) return;

  const predKey = `${match.stage}_${matchIndex}`;
  const memberIds = await getMemberUserIds(competitionId);

  for (const userId of memberIds) {
    const [bpRow] = await db
      .select()
      .from(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, competitionId), eq(bracketPredictions.userId, userId)));
    if (!bpRow) continue;

    const userPreds: BracketPredictions = bpRow.predictions ?? {};
    const pred = userPreds[predKey];
    if (!pred) continue;

    const predictedHome = getUserPredictedTeamForKnockoutSlot(
      match.stage, matchIndex, 'home', firstRound, matchesByStage, userPreds,
    );
    const predictedAway = getUserPredictedTeamForKnockoutSlot(
      match.stage, matchIndex, 'away', firstRound, matchesByStage, userPreds,
    );

    const homeInActualHome = predictedHome === match.homeTeamId;
    const homeInActualAway = predictedHome === match.awayTeamId;
    const awayInActualHome = predictedAway === match.homeTeamId;
    const awayInActualAway = predictedAway === match.awayTeamId;
    const homeCorrect = homeInActualHome || homeInActualAway;
    const awayCorrect = awayInActualAway || awayInActualHome;
    const correctCount = (homeCorrect ? 1 : 0) + (awayCorrect ? 1 : 0);

    let shouldFlip = false;
    if (correctCount === 2) shouldFlip = homeInActualAway && awayInActualHome;
    else if (correctCount === 1) shouldFlip = homeCorrect ? homeInActualAway : awayInActualHome;

    if (!shouldFlip) continue;

    const updatedPreds: BracketPredictions = {
      ...userPreds,
      [predKey]: { ...pred, flipped: true },
    };

    await db
      .update(bracketPredictions)
      .set({ predictions: updatedPreds, updatedAt: new Date() })
      .where(and(eq(bracketPredictions.competitionId, competitionId), eq(bracketPredictions.userId, userId)));
  }
}

// ── Recompute all per-source breakdown columns for every member ───────────────

async function recomputeAllMemberBreakdowns(
  tournamentId: string,
  competitionId: string,
  config: ScoringConfig,
  firstRound: string,
  bracketSlots: Record<string, string> = {},
): Promise<void> {
  // --- Group stage data ---
  const completedGroupMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed')));

  const allGroupMatches = await db
    .select({ status: matches.status })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group')));
  const allGroupDone = allGroupMatches.length > 0 && allGroupMatches.every(m => m.status === 'completed');

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
  const actualStandings = computeGroupStandings(completedGroupMatches, teamGroupMap);
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

  const memberIds = await getMemberUserIds(competitionId);

  for (const userId of memberIds) {
    // --- Group match prediction breakdown ---
    const userGroupPreds = groupMatchIds.length > 0
      ? await db
          .select()
          .from(predictions)
          .where(and(
            eq(predictions.competitionId, competitionId),
            eq(predictions.userId, userId),
            inArray(predictions.matchId, groupMatchIds),
          ))
      : [];
    const groupPredMap = new Map(userGroupPreds.map(p => [p.matchId, p]));

    let groupExactScore = 0;
    let groupCorrectResult = 0;
    let groupCorrectTeamProgresses = 0;

    for (const m of completedGroupMatches) {
      const pred = groupPredMap.get(m.id);
      if (!pred || m.homeScore === null || m.awayScore === null) continue;
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
    const simulatedMatches = completedGroupMatches
      .filter(m => m.homeTeamId && m.awayTeamId)
      .flatMap(m => {
        const pred = groupPredMap.get(m.id);
        if (!pred) return [];
        return [{ homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId!, homeScore: pred.homeScore, awayScore: pred.awayScore }];
      });
    const predictedStandings = computeGroupStandings(simulatedMatches, teamGroupMap);

    // --- Group position points ---
    let groupPositionPts = 0;
    if (allGroupDone) {
      groupPositionPts = calculateGroupPositionPoints(actualStandings, predictedStandings, config);
    }

    // --- Knockout bracket breakdown ---
    const [bpRow] = await db
      .select()
      .from(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, competitionId), eq(bracketPredictions.userId, userId)));
    const userBracketPreds: BracketPredictions = bpRow?.predictions ?? {};

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
    );

    // --- First-round knockout tie points (based on predicted group qualifiers) ---
    let correctTeamInFirstRound = 0;
    const allFirstRoundMatches = allKoMatches.filter(m => m.stage === firstRound);
    allFirstRoundMatches.forEach((match, i) => {
      if (match.status !== 'completed') return;
      const homeLabel = bracketSlots[`m${i + 1}_home`];
      const awayLabel = bracketSlots[`m${i + 1}_away`];
      const predHomeId = homeLabel ? resolveQualLabel(homeLabel, predictedStandings) : null;
      const predAwayId = awayLabel ? resolveQualLabel(awayLabel, predictedStandings) : null;
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

  // Build sorted knockout match list for bracket index lookups
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

    if (isKnockout) {
      await markFlippedKnockoutPredictions(
        matchId,
        { stage: match.stage, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId },
        allKoMatches,
        firstRound,
        comp.id,
      );
    }

    // Recompute all per-source breakdown columns for all members
    await recomputeAllMemberBreakdowns(tournamentId, comp.id, config, firstRound, bracketSlots);
  }
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

  const completedGroupMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed')));

  const allKoMatchesFull = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES])));
  allKoMatchesFull.sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });
  const completedKoMatches = allKoMatchesFull.filter(
    m => m.status === 'completed' && m.homeTeamId && m.awayTeamId,
  );

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

    for (const match of completedKoMatches) {
      await markFlippedKnockoutPredictions(
        match.id,
        { stage: match.stage, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId },
        allKoMatchesFull,
        firstRound,
        comp.id,
      );
    }

    await recomputeAllMemberBreakdowns(tournamentId, comp.id, config, firstRound, bracketSlotsFull);
  }
}

// ── Bonus question scoring (called when admin sets correctAnswer) ─────────────

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

  for (const answer of allAnswers) {
    const isCorrect = answer.answer.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
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
}
