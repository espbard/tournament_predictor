export interface PointSource {
  id: string;
  label: string;
  eyebrow?: string;
  subLabel?: string;
  pointsByUser: Record<string, number>;
  answerByUser?: Record<string, string>;
}

interface MatchLike {
  id: string;
  stage: string;
  scheduledAt: string | null;
  status: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
}

interface PredictionBreakdown {
  exactScore: number;
  correctResult: number;
  correctTeamProgresses: number;
  correctTeamInKnockoutTie: number;
  correctTeamInFinal: number;
  correctWinner: number;
}

interface PredictionLike {
  matchId: string;
  userId: string;
  breakdown: PredictionBreakdown;
}

interface LeaderboardLike {
  userId: string;
  breakdown: {
    correctGroupPositionPoints: number;
  };
}

interface BonusQuestionLike {
  id: string;
  question: string;
  correctAnswer: string | null;
}

interface BonusAnswerLike {
  questionId: string;
  userId: string;
  answer: string;
  points: number | null;
}

const KNOCKOUT_STAGE_ORDER = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final'] as const;
type KnockoutStage = typeof KNOCKOUT_STAGE_ORDER[number];

export interface FinalResultsLabels {
  groupRound: (n: number) => string;
  groupRoundCorrectResult: string;
  groupRoundExactScore: string;
  groupTablePosition: string;
  knockoutStage: Record<KnockoutStage, string>;
  bonusQuestionEyebrow: string;
  bonusCorrectAnswer: string;
}

function completedGroupMatches(matches: MatchLike[]): MatchLike[] {
  return matches.filter(
    m => m.stage === 'group' && m.status === 'completed' && m.homeTeamId && m.awayTeamId && m.scheduledAt
  );
}

function zeroFilled(userIds: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const uid of userIds) result[uid] = 0;
  return result;
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
    const correctResultPoints = zeroFilled(userIds);
    const exactScorePoints = zeroFilled(userIds);
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

function buildGroupTablePositionSource(leaderboard: LeaderboardLike[], userIds: string[], label: string): PointSource {
  const pointsByUser = zeroFilled(userIds);
  for (const entry of leaderboard) {
    if (entry.userId in pointsByUser) pointsByUser[entry.userId] = entry.breakdown.correctGroupPositionPoints ?? 0;
  }
  return { id: 'group-table-position', label, pointsByUser };
}

// Knockout rounds award points for several categories at once (correct result, exact
// score, correct team advancing, correct team in the tie/final, correct final winner) —
// unlike the group stage, these aren't split into separate reveal steps.
function buildKnockoutRoundPointSources(
  matches: MatchLike[],
  predictions: PredictionLike[],
  userIds: string[],
  stageLabels: Record<KnockoutStage, string>,
): PointSource[] {
  const predictionsByMatch = new Map<string, PredictionLike[]>();
  for (const p of predictions) {
    if (!predictionsByMatch.has(p.matchId)) predictionsByMatch.set(p.matchId, []);
    predictionsByMatch.get(p.matchId)!.push(p);
  }

  const sources: PointSource[] = [];
  for (const stage of KNOCKOUT_STAGE_ORDER) {
    const stageMatchIds = matches.filter(m => m.stage === stage).map(m => m.id);
    if (stageMatchIds.length === 0) continue;

    const pointsByUser = zeroFilled(userIds);
    for (const matchId of stageMatchIds) {
      for (const p of predictionsByMatch.get(matchId) ?? []) {
        if (!(p.userId in pointsByUser)) continue;
        const b = p.breakdown;
        pointsByUser[p.userId] +=
          (b.correctResult ?? 0) +
          (b.exactScore ?? 0) +
          (b.correctTeamProgresses ?? 0) +
          (b.correctTeamInKnockoutTie ?? 0) +
          (b.correctTeamInFinal ?? 0) +
          (b.correctWinner ?? 0);
      }
    }
    sources.push({ id: `ko-${stage}`, label: stageLabels[stage], pointsByUser });
  }
  return sources;
}

function parseAnswerList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // not JSON — a plain single answer
  }
  return [raw];
}

// One point source per bonus question, so the reveal can show the question itself,
// the correct answer, and what each user answered alongside their points.
function buildBonusQuestionPointSources(
  questions: BonusQuestionLike[],
  answers: BonusAnswerLike[],
  userIds: string[],
  eyebrow: string,
  correctAnswerLabel: string,
): PointSource[] {
  const answersByQuestion = new Map<string, BonusAnswerLike[]>();
  for (const a of answers) {
    if (!answersByQuestion.has(a.questionId)) answersByQuestion.set(a.questionId, []);
    answersByQuestion.get(a.questionId)!.push(a);
  }

  return questions.map(q => {
    const pointsByUser = zeroFilled(userIds);
    const answerByUser: Record<string, string> = {};
    for (const a of answersByQuestion.get(q.id) ?? []) {
      if (!(a.userId in pointsByUser)) continue;
      pointsByUser[a.userId] = a.points ?? 0;
      answerByUser[a.userId] = a.answer;
    }
    const correctAnswers = parseAnswerList(q.correctAnswer);
    return {
      id: `bonus-${q.id}`,
      label: q.question,
      eyebrow,
      subLabel: correctAnswers.length > 0 ? `${correctAnswerLabel}: ${correctAnswers.join(' / ')}` : undefined,
      pointsByUser,
      answerByUser,
    };
  });
}

export function buildFinalResultsPointSources(
  matches: MatchLike[],
  predictions: PredictionLike[],
  leaderboard: LeaderboardLike[],
  bonusQuestions: BonusQuestionLike[],
  bonusAnswers: BonusAnswerLike[],
  userIds: string[],
  labels: FinalResultsLabels,
): PointSource[] {
  return [
    ...buildGroupStageRoundPointSources(matches, predictions, userIds, {
      round: labels.groupRound,
      correctResult: labels.groupRoundCorrectResult,
      exactScore: labels.groupRoundExactScore,
    }),
    buildGroupTablePositionSource(leaderboard, userIds, labels.groupTablePosition),
    ...buildKnockoutRoundPointSources(matches, predictions, userIds, labels.knockoutStage),
    ...buildBonusQuestionPointSources(bonusQuestions, bonusAnswers, userIds, labels.bonusQuestionEyebrow, labels.bonusCorrectAnswer),
  ];
}
