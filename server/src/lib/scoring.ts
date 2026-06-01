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

function sortGroupTeamsWithH2H(teamList: TeamStat[], groupMatches: RawMatch[]): TeamStat[] {
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
    const sorted = [...group].sort((a, b) => {
      const ha = h2h.get(a.teamId)!; const hb = h2h.get(b.teamId)!;
      if (hb.points !== ha.points) return hb.points - ha.points;
      if (hb.gd !== ha.gd) return hb.gd - ha.gd;
      if (hb.gf !== ha.gf) return hb.gf - ha.gf;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      return a.teamId.localeCompare(b.teamId);
    });
    result.push(...sorted);
  }
  return result;
}

export function computeGroupStandings(
  matchList: RawMatch[],
  teamGroupMap: Map<string, string>,
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
    result.set(groupName, sortGroupTeamsWithH2H([...statsMap.values()], groupMatches));
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
): number {
  // Build matchesByStage from ALL matches (needed for trajectory lookups)
  const matchesByStage = new Map<string, KnockoutMatchSlot[]>();
  for (const m of allKnockoutMatches) {
    if (!matchesByStage.has(m.stage)) matchesByStage.set(m.stage, []);
    matchesByStage.get(m.stage)!.push(m);
  }

  let total = 0;

  for (const m of allKnockoutMatches) {
    if (m.status !== 'completed') continue;

    const stage = m.stage;
    const stageMatches = matchesByStage.get(stage) ?? [];
    const matchIndex = stageMatches.findIndex(sm => sm.id === m.id);
    if (matchIndex < 0) continue;

    // bracket_predictions key is `${stage}_${matchIndex}` on the client
    const predKey = `${stage}_${matchIndex}`;
    const pred = userBracketPredictions[predKey];

    // 1. Basic match scoring (exact_score, correct_result, correct_team_progresses)
    if (pred) {
      const result = calculateMatchPoints(
        pred,
        { homeScore: m.homeScore, awayScore: m.awayScore, stage, actualProgressingTeamId: m.progressingTeamId },
        config,
      );
      total += result.points;
    }

    // 2. Knockout tie scoring — skip first round (teams come from draw) and bronze_final
    if (stage === firstRound || stage === 'bronze_final') continue;

    const predictedHome = getUserPredictedTeamForKnockoutSlot(
      stage, matchIndex, 'home', firstRound, matchesByStage, userBracketPredictions,
    );
    const predictedAway = getUserPredictedTeamForKnockoutSlot(
      stage, matchIndex, 'away', firstRound, matchesByStage, userBracketPredictions,
    );

    for (const actualTeamId of [m.homeTeamId, m.awayTeamId]) {
      if (!actualTeamId) continue;
      if (predictedHome !== actualTeamId && predictedAway !== actualTeamId) continue;

      if (stage === 'final') {
        // correct_winner replaces correct_team_in_final for the winning team
        if (actualTeamId === m.progressingTeamId) {
          total += config.correct_winner;
        } else {
          total += config.correct_team_in_final;
        }
      } else {
        total += config.correct_team_in_knockout_tie;
      }
    }
  }

  return total;
}
