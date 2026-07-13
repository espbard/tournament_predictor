export interface PointSource {
  id: string;
  label: string;
  pointsByUser: Record<string, number>;
}

interface MatchLike {
  id: string;
  stage: string;
  scheduledAt: string | null;
  status: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
}

interface PredictionLike {
  matchId: string;
  userId: string;
  breakdown: { correctResult: number; exactScore: number };
}

function completedGroupMatches(matches: MatchLike[]): MatchLike[] {
  return matches.filter(
    m => m.stage === 'group' && m.status === 'completed' && m.homeTeamId && m.awayTeamId && m.scheduledAt
  );
}

// Group stage "rounds" aren't a stored concept — infer them from how many group
// matches each team has played, then bucket each team's matches chronologically
// into that many rounds (one match per team per round, as in a round-robin).
function groupStageRoundCount(groupMatches: MatchLike[]): number {
  const matchCountByTeam = new Map<string, number>();
  for (const m of groupMatches) {
    matchCountByTeam.set(m.homeTeamId!, (matchCountByTeam.get(m.homeTeamId!) ?? 0) + 1);
    matchCountByTeam.set(m.awayTeamId!, (matchCountByTeam.get(m.awayTeamId!) ?? 0) + 1);
  }
  const freqByCount = new Map<number, number>();
  for (const count of matchCountByTeam.values()) {
    freqByCount.set(count, (freqByCount.get(count) ?? 0) + 1);
  }
  let bestCount = 0;
  let bestFreq = -1;
  for (const [count, freq] of freqByCount) {
    if (freq > bestFreq) {
      bestCount = count;
      bestFreq = freq;
    }
  }
  return bestCount;
}

function groupStageRoundMatchIds(groupMatches: MatchLike[], numRounds: number): Map<number, Set<string>> {
  const matchesByTeam = new Map<string, MatchLike[]>();
  for (const m of groupMatches) {
    for (const teamId of [m.homeTeamId!, m.awayTeamId!]) {
      if (!matchesByTeam.has(teamId)) matchesByTeam.set(teamId, []);
      matchesByTeam.get(teamId)!.push(m);
    }
  }
  for (const list of matchesByTeam.values()) {
    list.sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime());
  }

  const roundByMatchId = new Map<string, number>();
  for (const m of groupMatches) {
    if (roundByMatchId.has(m.id)) continue;
    let idx = (matchesByTeam.get(m.homeTeamId!) ?? []).findIndex(hm => hm.id === m.id);
    if (idx === -1) idx = (matchesByTeam.get(m.awayTeamId!) ?? []).findIndex(am => am.id === m.id);
    if (idx === -1) continue;
    const round = idx + 1;
    if (round >= 1 && round <= numRounds) roundByMatchId.set(m.id, round);
  }

  const result = new Map<number, Set<string>>();
  for (let r = 1; r <= numRounds; r++) result.set(r, new Set());
  for (const [matchId, round] of roundByMatchId) result.get(round)!.add(matchId);
  return result;
}

export function buildGroupStageRoundPointSources(
  matches: MatchLike[],
  predictions: PredictionLike[],
  userIds: string[],
  labels: { round: (n: number) => string; correctResult: string; exactScore: string },
): PointSource[] {
  const groupMatches = completedGroupMatches(matches);
  const numRounds = groupStageRoundCount(groupMatches);
  if (numRounds === 0) return [];

  const roundMatchIds = groupStageRoundMatchIds(groupMatches, numRounds);

  const predictionsByMatch = new Map<string, PredictionLike[]>();
  for (const p of predictions) {
    if (!predictionsByMatch.has(p.matchId)) predictionsByMatch.set(p.matchId, []);
    predictionsByMatch.get(p.matchId)!.push(p);
  }

  const sources: PointSource[] = [];
  for (let r = 1; r <= numRounds; r++) {
    const matchIds = roundMatchIds.get(r) ?? new Set<string>();
    const correctResultPoints: Record<string, number> = {};
    const exactScorePoints: Record<string, number> = {};
    for (const uid of userIds) {
      correctResultPoints[uid] = 0;
      exactScorePoints[uid] = 0;
    }
    for (const matchId of matchIds) {
      for (const p of predictionsByMatch.get(matchId) ?? []) {
        if (!(p.userId in correctResultPoints)) continue;
        correctResultPoints[p.userId] += p.breakdown.correctResult ?? 0;
        exactScorePoints[p.userId] += p.breakdown.exactScore ?? 0;
      }
    }
    sources.push({
      id: `group-r${r}-result`,
      label: `${labels.round(r)} — ${labels.correctResult}`,
      pointsByUser: correctResultPoints,
    });
    sources.push({
      id: `group-r${r}-exact`,
      label: `${labels.round(r)} — ${labels.exactScore}`,
      pointsByUser: exactScorePoints,
    });
  }
  return sources;
}
