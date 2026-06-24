import type { ScoringConfig, BracketPredictions } from '@tournament-predictor/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PredictionInput {
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
}

interface MatchResult {
  homeScore: number;
  awayScore: number;
  stage: string;
  actualProgressingTeamId?: string | null;
}

interface ScoreBreakdown {
  exactScore: number;
  correctResult: number;
  correctTeamProgresses: number;
}

export interface ScoreResult {
  points: number;
  breakdown: ScoreBreakdown;
}

// ── Per-match scoring ─────────────────────────────────────────────────────────

export function calculateMatchPoints(
  prediction: PredictionInput,
  match: MatchResult,
  config: ScoringConfig,
): ScoreResult {
  const breakdown: ScoreBreakdown = { exactScore: 0, correctResult: 0, correctTeamProgresses: 0 };

  if (prediction.homeScore === match.homeScore && prediction.awayScore === match.awayScore) {
    breakdown.exactScore = config.exact_score;
  }

  const actualResult = Math.sign(match.homeScore - match.awayScore);
  const predictedResult = Math.sign(prediction.homeScore - prediction.awayScore);
  if (actualResult === predictedResult) {
    breakdown.correctResult = config.correct_result;
  }

  if (match.stage !== 'group' && match.actualProgressingTeamId) {
    if (prediction.progressingTeamId === match.actualProgressingTeamId) {
      breakdown.correctTeamProgresses = config.correct_team_progresses;
    }
  }

  return {
    points: breakdown.exactScore + breakdown.correctResult + breakdown.correctTeamProgresses,
    breakdown,
  };
}

// ── Group standings helpers ───────────────────────────────────────────────────

export type TeamStat = { teamId: string; points: number; gd: number; gf: number };
export type RawMatch = {
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeScore: number | null;
  awayScore: number | null;
};

function computeH2HStats(
  teamIds: string[],
  matchList: RawMatch[],
): Map<string, { points: number; gd: number; gf: number }> {
  const teamSet = new Set(teamIds);
  const stats = new Map(teamIds.map(id => [id, { points: 0, gd: 0, gf: 0 }]));
  for (const m of matchList) {
    if (!m.homeTeamId || !m.awayTeamId || m.homeScore === null || m.awayScore === null) continue;
    if (!teamSet.has(m.homeTeamId) || !teamSet.has(m.awayTeamId)) continue;
    const home = stats.get(m.homeTeamId)!;
    const away = stats.get(m.awayTeamId)!;
    home.gf += m.homeScore; home.gd += m.homeScore - m.awayScore;
    away.gf += m.awayScore; away.gd += m.awayScore - m.homeScore;
    if (m.homeScore > m.awayScore) home.points += 3;
    else if (m.homeScore === m.awayScore) { home.points += 1; away.points += 1; }
    else away.points += 3;
  }
  return stats;
}

function sortGroupTeamsWithH2H(
  teamList: TeamStat[],
  groupMatches: RawMatch[],
  disciplinaryChoices: Record<string, string[]> = {},
): TeamStat[] {
  if (teamList.length <= 1) return [...teamList];
  const byPoints = new Map<number, TeamStat[]>();
  for (const t of teamList) {
    if (!byPoints.has(t.points)) byPoints.set(t.points, []);
    byPoints.get(t.points)!.push(t);
  }
  const result: TeamStat[] = [];
  for (const [, group] of [...byPoints].sort(([a], [b]) => b - a)) {
    if (group.length === 1) { result.push(group[0]); continue; }
    const h2h = computeH2HStats(group.map(t => t.teamId), groupMatches);
    const key = [...group.map(t => t.teamId)].sort().join('|');
    const ranking = disciplinaryChoices[key];
    const sorted = [...group].sort((a, b) => {
      const ha = h2h.get(a.teamId)!; const hb = h2h.get(b.teamId)!;
      if (hb.points !== ha.points) return hb.points - ha.points;
      if (hb.gd !== ha.gd) return hb.gd - ha.gd;
      if (hb.gf !== ha.gf) return hb.gf - ha.gf;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      if (ranking) {
        const da = ranking.indexOf(a.teamId);
        const db = ranking.indexOf(b.teamId);
        if (da !== -1 && db !== -1 && da !== db) return da - db;
      }
      return a.teamId.localeCompare(b.teamId);
    });
    result.push(...sorted);
  }
  return result;
}

export function computeGroupStandings(
  matchList: RawMatch[],
  teamGroupMap: Map<string, string>,
  disciplinaryChoices: Record<string, string[]> = {},
): Map<string, TeamStat[]> {
  const groupStats = new Map<string, Map<string, TeamStat>>();
  const groupMatchesMap = new Map<string, RawMatch[]>();

  for (const m of matchList) {
    if (!m.homeTeamId || !m.awayTeamId || m.homeScore === null || m.awayScore === null) continue;
    const homeGroup = teamGroupMap.get(m.homeTeamId);
    const awayGroup = teamGroupMap.get(m.awayTeamId);
    if (!homeGroup || !awayGroup || homeGroup !== awayGroup) continue;

    if (!groupStats.has(homeGroup)) {
      groupStats.set(homeGroup, new Map());
      groupMatchesMap.set(homeGroup, []);
    }
    const statsMap = groupStats.get(homeGroup)!;
    groupMatchesMap.get(homeGroup)!.push(m);

    if (!statsMap.has(m.homeTeamId)) statsMap.set(m.homeTeamId, { teamId: m.homeTeamId, points: 0, gd: 0, gf: 0 });
    if (!statsMap.has(m.awayTeamId)) statsMap.set(m.awayTeamId, { teamId: m.awayTeamId, points: 0, gd: 0, gf: 0 });

    const home = statsMap.get(m.homeTeamId)!;
    const away = statsMap.get(m.awayTeamId)!;
    home.gf += m.homeScore; home.gd += m.homeScore - m.awayScore;
    away.gf += m.awayScore; away.gd += m.awayScore - m.homeScore;
    if (m.homeScore > m.awayScore) home.points += 3;
    else if (m.homeScore === m.awayScore) { home.points += 1; away.points += 1; }
    else away.points += 3;
  }

  const result = new Map<string, TeamStat[]>();
  for (const [groupName, statsMap] of groupStats) {
    const groupMatches = groupMatchesMap.get(groupName) ?? [];
    result.set(groupName, sortGroupTeamsWithH2H([...statsMap.values()], groupMatches, disciplinaryChoices));
  }
  return result;
}

// ── Group position scoring ────────────────────────────────────────────────────

export function calculateGroupPositionPoints(
  actualStandings: Map<string, TeamStat[]>,
  predictedStandings: Map<string, TeamStat[]>,
  config: ScoringConfig,
): number {
  let points = 0;
  for (const [group, actualTeams] of actualStandings) {
    const predictedTeams = predictedStandings.get(group) ?? [];
    for (let i = 0; i < actualTeams.length; i++) {
      if (predictedTeams[i]?.teamId === actualTeams[i].teamId) {
        points += config.correct_group_position;
      }
    }
  }
  return points;
}

// ── Knockout bracket scoring ──────────────────────────────────────────────────

export type KnockoutMatchSlot = {
  id: string;
  stage: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
};

// Bracket stage order — bronze_final is outside the progression tree
const BRACKET_STAGE_ORDER = [
  'round_of_32',
  'round_of_16',
  'quarter_final',
  'semi_final',
  'final',
] as const;

/**
 * Recursively resolves which team the user predicted would fill a given slot
 * in the knockout bracket, by tracing their progression picks back to the
 * first round (which uses the actual drawn teams).
 */
export function getUserPredictedTeamForKnockoutSlot(
  stage: string,
  matchIndex: number,
  slot: 'home' | 'away',
  firstRound: string,
  matchesByStage: Map<string, KnockoutMatchSlot[]>,
  userBracketPredictions: BracketPredictions,
): string | null {
  const stageMatches = matchesByStage.get(stage);
  if (!stageMatches) return null;
  const match = stageMatches[matchIndex];
  if (!match) return null;

  // Base case: first round teams come from the actual draw
  if (stage === firstRound) {
    return slot === 'home' ? match.homeTeamId : match.awayTeamId;
  }

  const stageIdx = BRACKET_STAGE_ORDER.indexOf(stage as typeof BRACKET_STAGE_ORDER[number]);
  const firstRoundIdx = BRACKET_STAGE_ORDER.indexOf(firstRound as typeof BRACKET_STAGE_ORDER[number]);
  if (stageIdx < 0 || firstRoundIdx < 0 || stageIdx <= firstRoundIdx) return null;

  const prevStage = BRACKET_STAGE_ORDER[stageIdx - 1];
  const feederIndex = slot === 'home' ? matchIndex * 2 : matchIndex * 2 + 1;
  const pred = userBracketPredictions[`${prevStage}_${feederIndex}`];
  if (!pred) return null;

  const predictedHome = getUserPredictedTeamForKnockoutSlot(
    prevStage, feederIndex, 'home', firstRound, matchesByStage, userBracketPredictions,
  );
  const predictedAway = getUserPredictedTeamForKnockoutSlot(
    prevStage, feederIndex, 'away', firstRound, matchesByStage, userBracketPredictions,
  );

  if (pred.progressingTeamId) return pred.progressingTeamId;
  if (pred.homeScore > pred.awayScore) return predictedHome;
  if (pred.awayScore > pred.homeScore) return predictedAway;
  return null;
}

export type CompletedKnockoutMatch = KnockoutMatchSlot & {
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
  status: string;
};

export interface KnockoutScoreBreakdown {
  exactScore: number;
  correctResult: number;
  correctTeamProgresses: number;
  correctTeamInKnockoutTie: number;
  correctTeamInFinal: number;
  correctWinner: number;
}

export interface KnockoutScoreResult {
  total: number;
  breakdown: KnockoutScoreBreakdown;
}

export type FirstRoundPredTeams = Record<string, { predHomeId: string | null; predAwayId: string | null }>;

/**
 * Calculates all knockout points for one user across all completed knockout
 * matches. Includes exact_score, correct_result, correct_team_progresses
 * (from bracketPredictions), plus correct_team_in_knockout_tie / _in_final /
 * correct_winner for rounds after the first.
 *
 * allKnockoutMatches must include ALL matches (completed and shell) sorted by
 * scheduledAt within each stage, so bracket indices stay consistent.
 */
export function calculateKnockoutPoints(
  allKnockoutMatches: CompletedKnockoutMatch[],
  firstRound: string,
  userBracketPredictions: BracketPredictions,
  config: ScoringConfig,
  predictedFirstRoundTeams?: FirstRoundPredTeams,
): KnockoutScoreResult {
  const breakdown: KnockoutScoreBreakdown = {
    exactScore: 0,
    correctResult: 0,
    correctTeamProgresses: 0,
    correctTeamInKnockoutTie: 0,
    correctTeamInFinal: 0,
    correctWinner: 0,
  };

  // Build matchesByStage from ALL matches (needed for trajectory lookups)
  const matchesByStage = new Map<string, KnockoutMatchSlot[]>();
  for (const m of allKnockoutMatches) {
    if (!matchesByStage.has(m.stage)) matchesByStage.set(m.stage, []);
    matchesByStage.get(m.stage)!.push(m);
  }

  for (const m of allKnockoutMatches) {
    if (m.status !== 'completed') continue;

    const stage = m.stage;
    const stageMatches = matchesByStage.get(stage) ?? [];
    const matchIndex = stageMatches.findIndex(sm => sm.id === m.id);
    if (matchIndex < 0) continue;

    const predKey = `${stage}_${matchIndex}`;
    const pred = userBracketPredictions[predKey];

    // Resolve which teams the user predicted for each slot, then detect whether
    // the score should be evaluated "flipped". Flip applies when a team that
    // appears in the actual match was predicted on the opposite side
    // (predictedHome === actualAway OR predictedAway === actualHome).
    // For the first round, predicted teams come from the caller-supplied
    // predictedFirstRoundTeams map (resolved from bracket slots + group standings).
    // For later rounds they are traced through the user's bracket picks.
    let predictedHome: string | null = null;
    let predictedAway: string | null = null;
    let shouldFlip = false;

    if (stage !== 'bronze_final') {
      if (stage === firstRound) {
        if (predictedFirstRoundTeams) {
          predictedHome = predictedFirstRoundTeams[predKey]?.predHomeId ?? null;
          predictedAway = predictedFirstRoundTeams[predKey]?.predAwayId ?? null;
        }
      } else {
        predictedHome = getUserPredictedTeamForKnockoutSlot(
          stage, matchIndex, 'home', firstRound, matchesByStage, userBracketPredictions,
        );
        predictedAway = getUserPredictedTeamForKnockoutSlot(
          stage, matchIndex, 'away', firstRound, matchesByStage, userBracketPredictions,
        );
      }

      if (m.homeTeamId && m.awayTeamId) {
        // Flip when a team from the actual match is predicted on the wrong side:
        // predicted home is actually the away team, OR predicted away is actually the home team.
        shouldFlip =
          (predictedHome !== null && predictedHome === m.awayTeamId) ||
          (predictedAway !== null && predictedAway === m.homeTeamId);
      }
    }

    // 1. Basic match scoring (exact_score, correct_result, correct_team_progresses)
    if (pred) {
      const scoredMatch = shouldFlip
        ? { homeScore: m.awayScore, awayScore: m.homeScore, stage, actualProgressingTeamId: m.progressingTeamId }
        : { homeScore: m.homeScore, awayScore: m.awayScore, stage, actualProgressingTeamId: m.progressingTeamId };
      const result = calculateMatchPoints(pred, scoredMatch, config);
      breakdown.exactScore += result.breakdown.exactScore;
      breakdown.correctResult += result.breakdown.correctResult;
      breakdown.correctTeamProgresses += result.breakdown.correctTeamProgresses;
    }

    // 2. Knockout tie scoring — skip first round (teams come from draw) and bronze_final
    if (stage === firstRound || stage === 'bronze_final') continue;

    // Determine which team the user predicted to win the final (team identity, not home/away side).
    // Must match both: correct team in the final AND correct team to win.
    let userPredictedWinner: string | null = null;
    if (stage === 'final' && pred) {
      if (pred.progressingTeamId) {
        userPredictedWinner = pred.progressingTeamId;
      } else if (!shouldFlip) {
        if (pred.homeScore > pred.awayScore) userPredictedWinner = predictedHome;
        else if (pred.awayScore > pred.homeScore) userPredictedWinner = predictedAway;
      } else {
        // shouldFlip: user's home maps to the actual away team, so invert which predicted team wins
        if (pred.homeScore > pred.awayScore) userPredictedWinner = predictedAway;
        else if (pred.awayScore > pred.homeScore) userPredictedWinner = predictedHome;
      }
    }

    for (const actualTeamId of [m.homeTeamId, m.awayTeamId]) {
      if (!actualTeamId) continue;
      if (predictedHome !== actualTeamId && predictedAway !== actualTeamId) continue;

      if (stage === 'final') {
        breakdown.correctTeamInFinal += config.correct_team_in_final;
        if (actualTeamId === m.progressingTeamId && actualTeamId === userPredictedWinner) {
          breakdown.correctWinner += config.correct_winner;
        }
      } else {
        breakdown.correctTeamInKnockoutTie += config.correct_team_in_knockout_tie;
      }
    }
  }

  const total = breakdown.exactScore + breakdown.correctResult + breakdown.correctTeamProgresses
    + breakdown.correctTeamInKnockoutTie + breakdown.correctTeamInFinal + breakdown.correctWinner;

  return { total, breakdown };
}
