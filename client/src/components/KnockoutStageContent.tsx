import { useState, useRef, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import { useTeamName } from '@/lib/teamTranslations';
import type {
  Competition,
  Tournament,
  Prediction,
  MatchStage,
  KnockoutFirstRound,
  KnockoutConfig,
  BracketMatchPrediction,
  BracketPredictions,
  ScoringConfig,
} from '@tournament-predictor/shared';
import {
  sortGroupTeams,
  sortLuckyLosers,
  findGroupDisciplinaryTies,
  findLuckyLoserDisciplinaryTies,
  makeDisciplinaryKey,
  type MatchResult,
  type DisciplinaryChoices,
} from '@/lib/tiebreakers';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MatchWithTeams {
  id: string;
  tournamentId: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamImageUrl: string | null;
  awayTeamImageUrl: string | null;
  stage: MatchStage;
  scheduledAt: string | null;
  status: 'scheduled' | 'completed';
  homeScore: number | null;
  awayScore: number | null;
  progressingTeamId: string | null;
  groupName: string | null;
}

type TeamStat = {
  teamId: string;
  teamName: string;
  imageUrl: string | null;
  group: string;
  P: number; W: number; D: number; L: number; GF: number; GA: number;
};

interface FlatMatch {
  round: KnockoutFirstRound;
  matchIdxInRound: number;
  matchCountInRound: number;
  predKey: string;
  bracketKey: string;
  isBronze: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROUND_ORDER: KnockoutFirstRound[] = [
  'round_of_32',
  'round_of_16',
  'quarter_final',
  'semi_final',
  'final',
];

const ROUND_LABELS: Record<KnockoutFirstRound, string> = {
  round_of_32: 'Round of 32',
  round_of_16: 'Round of 16',
  quarter_final: 'Quarter-finals',
  semi_final: 'Semi-finals',
  final: 'Final',
};

const FIRST_ROUND_COUNTS: Record<KnockoutFirstRound, number> = {
  round_of_32: 16,
  round_of_16: 8,
  quarter_final: 4,
  semi_final: 2,
  final: 1,
};

const WC2026_LUCKY_LOSER_COMBOS: string[][] = [
  ['A', 'B', 'C', 'D', 'F'],
  ['C', 'D', 'F', 'G', 'H'],
  ['B', 'E', 'F', 'I', 'J'],
  ['A', 'E', 'H', 'I', 'J'],
  ['C', 'E', 'F', 'H', 'I'],
  ['E', 'H', 'I', 'J', 'K'],
  ['E', 'F', 'G', 'I', 'J'],
  ['D', 'E', 'I', 'J', 'L'],
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sortTeams(teams: TeamStat[], choices: DisciplinaryChoices = {}): TeamStat[] {
  const stats = teams.map(t => ({ teamId: t.teamId, points: t.W * 3 + t.D, gd: t.GF - t.GA, gf: t.GF }));
  const sortedIds = sortLuckyLosers(stats, choices).map(s => s.teamId);
  return sortedIds.map(id => teams.find(t => t.teamId === id)!);
}

function parseQualifierLabel(label: string): { position: number; groups: string[] } {
  const m = label.match(/^(\d+)([A-Z]+)$/);
  if (!m) return { position: 1, groups: [] };
  return { position: parseInt(m[1], 10), groups: m[2].split('') };
}

function computeLuckyLoserLabels(
  firstRoundMatchCount: number,
  bracketSlots: Record<string, string>,
  groupNames: string[],
  directQualifiers: number,
): Record<string, string> {
  const existingGroups = new Set(groupNames);
  const emptySlots: string[] = [];
  for (let i = 0; i < firstRoundMatchCount; i++) {
    for (const side of ['home', 'away'] as const) {
      const slotId = `m${i + 1}_${side}`;
      if (!bracketSlots[slotId]) emptySlots.push(slotId);
    }
  }
  const result: Record<string, string> = {};
  for (let si = 0; si < emptySlots.length; si++) {
    if (si >= WC2026_LUCKY_LOSER_COMBOS.length) break;
    const validGroups = WC2026_LUCKY_LOSER_COMBOS[si].filter(g => existingGroups.has(g));
    if (validGroups.length > 0) {
      result[emptySlots[si]] = `${directQualifiers + 1}${validGroups.join('')}`;
    }
  }
  return result;
}

function maxBipartiteMatching(slots: Array<Set<string>>, teams: TeamStat[]): number {
  const matchTeam = new Array<number>(teams.length).fill(-1);
  function augment(si: number, visited: boolean[]): boolean {
    for (let ti = 0; ti < teams.length; ti++) {
      if (visited[ti] || !slots[si].has(teams[ti].group)) continue;
      visited[ti] = true;
      if (matchTeam[ti] === -1 || augment(matchTeam[ti], visited)) {
        matchTeam[ti] = si;
        return true;
      }
    }
    return false;
  }
  let count = 0;
  for (let si = 0; si < slots.length; si++) {
    if (augment(si, new Array<boolean>(teams.length).fill(false))) count++;
  }
  return count;
}

function resolveSlots(
  bracketSlots: Record<string, string>,
  luckyLoserLabels: Record<string, string>,
  groupStandings: [string, TeamStat[]][],
  directQualifiers: number,
  firstRoundMatchCount: number,
  luckyLoserChoices: DisciplinaryChoices = {},
): Record<string, TeamStat | null> {
  const byGroup = new Map(groupStandings);
  const resolved: Record<string, TeamStat | null> = {};

  for (const [slotId, label] of Object.entries(bracketSlots)) {
    const { position, groups } = parseQualifierLabel(label);
    if (position <= directQualifiers && groups.length === 1) {
      resolved[slotId] = byGroup.get(groups[0])?.[position - 1] ?? null;
    }
  }

  const llSlots: Array<{ slotId: string; groups: Set<string> }> = [];
  for (let i = 0; i < firstRoundMatchCount; i++) {
    for (const side of ['home', 'away'] as const) {
      const slotId = `m${i + 1}_${side}`;
      const label = luckyLoserLabels[slotId];
      if (!label) continue;
      const { groups } = parseQualifierLabel(label);
      llSlots.push({ slotId, groups: new Set(groups) });
    }
  }

  const allLL = sortTeams(
    groupStandings
      .filter(([, t]) => t.length > directQualifiers)
      .map(([, t]) => t[directQualifiers]),
    luckyLoserChoices,
  );

  function solve(slotIdx: number, available: TeamStat[]): void {
    if (slotIdx === llSlots.length) return;
    const { slotId, groups } = llSlots[slotIdx];
    const M = maxBipartiteMatching(llSlots.slice(slotIdx).map(s => s.groups), available);
    const candidates = available.filter(t => groups.has(t.group));
    for (const candidate of candidates) {
      const remaining = available.filter(t => t.teamId !== candidate.teamId);
      const Mrem = maxBipartiteMatching(llSlots.slice(slotIdx + 1).map(s => s.groups), remaining);
      if (Mrem >= M - 1) {
        resolved[slotId] = candidate;
        solve(slotIdx + 1, remaining);
        return;
      }
    }
    resolved[slotId] = null;
    solve(slotIdx + 1, available);
  }

  solve(0, allLL);
  return resolved;
}

function getWinner(
  teams: { home: TeamStat | null; away: TeamStat | null } | undefined,
  pred: BracketMatchPrediction | undefined,
): TeamStat | null {
  if (!teams || !pred) return null;
  const { homeScore, awayScore, progressingTeamId } = pred;
  if (homeScore > awayScore) return teams.home;
  if (awayScore > homeScore) return teams.away;
  if (progressingTeamId === teams.home?.teamId) return teams.home;
  if (progressingTeamId === teams.away?.teamId) return teams.away;
  return null;
}

function getLoser(
  teams: { home: TeamStat | null; away: TeamStat | null } | undefined,
  pred: BracketMatchPrediction | undefined,
): TeamStat | null {
  if (!teams || !pred) return null;
  const { homeScore, awayScore, progressingTeamId } = pred;
  if (homeScore > awayScore) return teams.away;
  if (awayScore > homeScore) return teams.home;
  if (progressingTeamId === teams.home?.teamId) return teams.away;
  if (progressingTeamId === teams.away?.teamId) return teams.home;
  return null;
}

function isPredComplete(
  pred: BracketMatchPrediction | undefined,
  teams: { home: TeamStat | null; away: TeamStat | null } | undefined,
): boolean {
  if (!pred || !teams?.home || !teams?.away) return false;
  if (pred.homeScore === pred.awayScore && !pred.progressingTeamId) return false;
  return true;
}

// ── Focused match card ────────────────────────────────────────────────────────

function FocusedMatchCard({
  matchKey,
  homeTeam,
  awayTeam,
  prediction,
  onUpdate,
  isFinal,
  actualMatch,
  isFirstRound,
  scoringConfig,
  predictedFirstRoundTeams,
  readOnly,
  editOverride,
  teamPageCompetitionId,
  teamPageUserId,
}: {
  matchKey: string;
  homeTeam: TeamStat | null;
  awayTeam: TeamStat | null;
  prediction: BracketMatchPrediction | undefined;
  onUpdate: (key: string, pred: BracketMatchPrediction) => void;
  isFinal?: boolean;
  actualMatch?: MatchWithTeams;
  isFirstRound?: boolean;
  scoringConfig?: ScoringConfig;
  predictedFirstRoundTeams?: { predHomeId: string | null; predAwayId: string | null };
  readOnly?: boolean;
  editOverride?: boolean;
  teamPageCompetitionId?: string;
  teamPageUserId?: string;
}) {
  const [homeStr, setHomeStr] = useState('');
  const [awayStr, setAwayStr] = useState('');
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!synced && prediction) {
      setHomeStr(prediction.homeScore.toString());
      setAwayStr(prediction.awayScore.toString());
      setSynced(true);
    }
  }, [prediction, synced]);

  const homeNum = homeStr === '' ? null : parseInt(homeStr);
  const awayNum = awayStr === '' ? null : parseInt(awayStr);
  const bothValid = homeNum !== null && awayNum !== null && !isNaN(homeNum) && !isNaN(awayNum);
  const isDraw = bothValid && homeNum === awayNum;
  const disabled = !homeTeam || !awayTeam;

  // Compute points awarded for this match once result is in
  const pointsInfo = useMemo(() => {
    if (!actualMatch || actualMatch.status !== 'completed' || !prediction || !scoringConfig) return null;
    const h = actualMatch.homeScore ?? 0;
    const a = actualMatch.awayScore ?? 0;

    // Determine if predicted home/away are flipped relative to actual match sides
    let predH = prediction.homeScore;
    let predA = prediction.awayScore;
    const predHomeId = homeTeam?.teamId ?? null;
    const predAwayId = awayTeam?.teamId ?? null;
    const actHomeId = actualMatch.homeTeamId;
    const actAwayId = actualMatch.awayTeamId;

    if (actHomeId && actAwayId) {
      const flip =
        (predHomeId !== null && predHomeId === actAwayId) ||
        (predAwayId !== null && predAwayId === actHomeId);
      if (flip) { predH = prediction.awayScore; predA = prediction.homeScore; }
    }

    const exactScore = predH === h && predA === a ? scoringConfig.exact_score : 0;
    const correctResult = Math.sign(predH - predA) === Math.sign(h - a) ? scoringConfig.correct_result : 0;
    const correctTeamProgresses =
      actualMatch.progressingTeamId && prediction.progressingTeamId === actualMatch.progressingTeamId
        ? scoringConfig.correct_team_progresses : 0;

    let correctTeamInKnockoutTie = 0, correctTeamInFinal = 0, correctWinner = 0;
    let isActualHomeTeamCorrect = false, isActualAwayTeamCorrect = false;
    const isBronzeFinal = matchKey.startsWith('bronze_final');

    if (!isBronzeFinal) {
      // For the first knockout round, compare against predicted qualifiers derived from
      // the user's group stage score predictions. For later rounds, use bracket trajectory.
      const effectivePredHomeId = isFirstRound ? (predictedFirstRoundTeams?.predHomeId ?? null) : predHomeId;
      const effectivePredAwayId = isFirstRound ? (predictedFirstRoundTeams?.predAwayId ?? null) : predAwayId;
      const hasPreds = isFirstRound ? !!predictedFirstRoundTeams : true;

      if (hasPreds) {
        for (const teamId of [actHomeId, actAwayId]) {
          if (!teamId) continue;
          if (effectivePredHomeId !== teamId && effectivePredAwayId !== teamId) continue;
          if (isFinal) {
            if (teamId === actualMatch.progressingTeamId && prediction.progressingTeamId === actualMatch.progressingTeamId) correctWinner = scoringConfig.correct_winner;
            else correctTeamInFinal += scoringConfig.correct_team_in_final;
          } else {
            correctTeamInKnockoutTie += scoringConfig.correct_team_in_knockout_tie;
          }
          if (teamId === actHomeId) isActualHomeTeamCorrect = true;
          if (teamId === actAwayId) isActualAwayTeamCorrect = true;
        }
      }
    }

    const total = exactScore + correctResult + correctTeamProgresses + correctTeamInKnockoutTie + correctTeamInFinal + correctWinner;
    return { exactScore, correctResult, correctTeamProgresses, correctTeamInKnockoutTie, correctTeamInFinal, correctWinner, total, isActualHomeTeamCorrect, isActualAwayTeamCorrect };
  }, [actualMatch, prediction, scoringConfig, homeTeam, awayTeam, isFinal, isFirstRound]);
  const { t } = useT();
  const { tn } = useTeamName();

  // Visual flags — computed directly from score comparison so they don't depend on
  // scoringConfig values being non-zero.
  const { isCorrectResult, isExactScore } = useMemo(() => {
    if (!actualMatch || actualMatch.status !== 'completed' || !prediction)
      return { isCorrectResult: false, isExactScore: false };
    const h = actualMatch.homeScore ?? 0;
    const a = actualMatch.awayScore ?? 0;
    let predH = prediction.homeScore;
    let predA = prediction.awayScore;
    const predHomeId = homeTeam?.teamId ?? null;
    const predAwayId = awayTeam?.teamId ?? null;
    const actHomeId = actualMatch.homeTeamId;
    const actAwayId = actualMatch.awayTeamId;
    if (actHomeId && actAwayId) {
      const flip =
        (predHomeId !== null && predHomeId === actAwayId) ||
        (predAwayId !== null && predAwayId === actHomeId);
      if (flip) { predH = prediction.awayScore; predA = prediction.homeScore; }
    }
    return {
      isExactScore: predH === h && predA === a,
      isCorrectResult: Math.sign(predH - predA) === Math.sign(h - a),
    };
  }, [actualMatch, prediction, homeTeam, awayTeam]);
  const homeWins = bothValid && homeNum! > awayNum!;
  const awayWins = bothValid && awayNum! > homeNum!;
  const isHomeChampion = isFinal && (homeWins || (isDraw && prediction?.progressingTeamId === homeTeam?.teamId));
  const isAwayChampion = isFinal && (awayWins || (isDraw && prediction?.progressingTeamId === awayTeam?.teamId));

  function handleScoreChange(side: 'home' | 'away', raw: string) {
    const val = raw.replace(/\D/g, '').slice(0, 2);
    const newHomeStr = side === 'home' ? val : homeStr;
    const newAwayStr = side === 'away' ? val : awayStr;
    if (side === 'home') setHomeStr(val);
    else setAwayStr(val);

    const h = newHomeStr === '' ? null : parseInt(newHomeStr);
    const a = newAwayStr === '' ? null : parseInt(newAwayStr);
    if (h === null || a === null || isNaN(h) || isNaN(a)) return;

    let progressingTeamId: string | null = prediction?.progressingTeamId ?? null;
    if (h > a) progressingTeamId = homeTeam?.teamId ?? null;
    else if (a > h) progressingTeamId = awayTeam?.teamId ?? null;
    else progressingTeamId = null;

    onUpdate(matchKey, { homeScore: h, awayScore: a, progressingTeamId });
  }

  function handleProgressing(teamId: string) {
    if (homeNum === null || awayNum === null) return;
    onUpdate(matchKey, { homeScore: homeNum, awayScore: awayNum, progressingTeamId: teamId });
  }

  const isCompleted = actualMatch?.status === 'completed';
  const forceEditable = !!editOverride && !readOnly;

  // Detect flip client-side (same rule as server): a team from the actual match
  // was predicted on the opposite side.
  const clientSideFlip = useMemo(() => {
    if (!isCompleted || !actualMatch || !prediction) return false;
    const predHomeId = homeTeam?.teamId ?? null;
    const predAwayId = awayTeam?.teamId ?? null;
    const actHomeId = actualMatch.homeTeamId;
    const actAwayId = actualMatch.awayTeamId;
    if (!actHomeId || !actAwayId) return false;
    return (
      (predHomeId !== null && predHomeId === actAwayId) ||
      (predAwayId !== null && predAwayId === actHomeId)
    );
  }, [isCompleted, actualMatch, prediction, homeTeam, awayTeam]);

  const isFlipped = isCompleted && (!!prediction?.flipped || clientSideFlip);

  const isDisplayHomeTeamCorrect = isCompleted && (isFlipped ? pointsInfo?.isActualAwayTeamCorrect : pointsInfo?.isActualHomeTeamCorrect) === true;
  const isDisplayAwayTeamCorrect = isCompleted && (isFlipped ? pointsInfo?.isActualHomeTeamCorrect : pointsInfo?.isActualAwayTeamCorrect) === true;

  // When flipped: swap teams and scores so the prediction card mirrors the
  // actual result card's home/away layout.
  const displayHomeTeam = isFlipped ? awayTeam : homeTeam;
  const displayAwayTeam = isFlipped ? homeTeam : awayTeam;
  const displayHomeScore = isFlipped ? prediction?.awayScore : prediction?.homeScore;
  const displayAwayScore = isFlipped ? prediction?.homeScore : prediction?.awayScore;
  const displayHomeWins = isFlipped ? awayWins : homeWins;
  const displayAwayWins = isFlipped ? homeWins : awayWins;
  const isDisplayHomeChampion = isFlipped ? isAwayChampion : isHomeChampion;
  const isDisplayAwayChampion = isFlipped ? isHomeChampion : isAwayChampion;

  // Highlight the team the prediction has progressing on a drawn scoreline.
  const predHomeProgresses = isDraw && prediction?.progressingTeamId === homeTeam?.teamId;
  const predAwayProgresses = isDraw && prediction?.progressingTeamId === awayTeam?.teamId;
  const isDisplayHomeProgressing = (isFlipped ? predAwayProgresses : predHomeProgresses) && !isDisplayHomeChampion;
  const isDisplayAwayProgressing = (isFlipped ? predHomeProgresses : predAwayProgresses) && !isDisplayAwayChampion;

  // Highlight the team the actual result has progressing on a drawn scoreline.
  const actualIsDraw = !!actualMatch && actualMatch.homeScore === actualMatch.awayScore;
  const actualHomeProgresses = actualIsDraw && actualMatch!.progressingTeamId === actualMatch!.homeTeamId;
  const actualAwayProgresses = actualIsDraw && actualMatch!.progressingTeamId === actualMatch!.awayTeamId;

  const goldenBorderClass = 'ring-2 ring-inset ring-amber-400 bg-amber-50/40 dark:bg-amber-900/15';

  // The "who advances" section only renders when editing a draw, so the away row is the
  // last item in the prediction card when completed (and not force-editable) or read-only.
  const predCardAwayIsLast = (isCompleted && !forceEditable) || !!readOnly || !homeTeam || !awayTeam;

  return (
    <div className="space-y-3 w-full">
      {/* ── Predicted card ─────────────────────────────────── */}
      <div>
        {isCompleted && (
          <p className="text-xs text-muted-foreground text-center mb-1.5 font-medium">
            {t('knockoutContent.yourPrediction')}
          </p>
        )}
        <div className={`rounded-xl border-2 shadow-sm overflow-hidden ${isCorrectResult ? 'border-green-400 bg-green-50/60 dark:bg-green-950/25' : 'bg-card'}`}>
          {/* Home row */}
          <div
            className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${isDisplayHomeProgressing ? goldenBorderClass + ' rounded-t-xl' : displayHomeWins && !isDisplayHomeChampion ? 'bg-primary/5' : ''}`}
            style={isDisplayHomeChampion ? { animation: 'ko_winner_glow 1.8s ease-in-out infinite' } : undefined}
          >
            {displayHomeTeam ? (
              <>
                {displayHomeTeam.imageUrl ? (
                  <img src={displayHomeTeam.imageUrl} alt="" className={`h-7 w-7 rounded-full object-cover flex-shrink-0${isDisplayHomeTeamCorrect ? ' ring-2 ring-green-400' : ''}`} />
                ) : (
                  <div className={`h-7 w-7 rounded-full bg-muted flex-shrink-0${isDisplayHomeTeamCorrect ? ' ring-2 ring-green-400' : ''}`} />
                )}
                {teamPageCompetitionId && displayHomeTeam.teamId ? (
                  <Link to={`/competitions/${teamPageCompetitionId}/team/${displayHomeTeam.teamId}${teamPageUserId ? `?userId=${teamPageUserId}` : ''}`} className={`flex-1 text-sm truncate hover:underline ${displayHomeWins ? 'font-semibold' : 'font-medium'}`}>
                    {tn(displayHomeTeam.teamName)}
                  </Link>
                ) : (
                  <span className={`flex-1 text-sm truncate ${displayHomeWins ? 'font-semibold' : 'font-medium'}`}>
                    {tn(displayHomeTeam.teamName)}
                  </span>
                )}
                {isDisplayHomeChampion && (
                  <span style={{ animation: 'ko_trophy_pop 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
                    🏆
                  </span>
                )}
              </>
            ) : (
              <span className="flex-1 text-sm text-muted-foreground italic">TBD</span>
            )}
            {isCompleted && !forceEditable ? (
              <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>
                {prediction != null ? displayHomeScore : '—'}
              </span>
            ) : readOnly ? (
              <span className="w-11 h-9 flex items-center justify-center text-xl font-bold flex-shrink-0 text-muted-foreground">
                {prediction != null ? prediction.homeScore : '—'}
              </span>
            ) : (
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => handleScoreChange('home', String(Math.max(0, (parseInt(homeStr || '0') || 0) - 1)))}
                  className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >−</button>
                <input
                  type="text"
                  inputMode="numeric"
                  value={homeStr}
                  onChange={e => handleScoreChange('home', e.target.value)}
                  disabled={disabled}
                  className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
                  placeholder="–"
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => handleScoreChange('home', String(Math.min(99, (parseInt(homeStr || '0') || 0) + 1)))}
                  className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >+</button>
              </div>
            )}
          </div>

          <div className="h-px bg-border" />

          {/* Away row */}
          <div
            className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${isDisplayAwayProgressing ? goldenBorderClass + (predCardAwayIsLast ? ' rounded-b-xl' : '') : displayAwayWins && !isDisplayAwayChampion ? 'bg-primary/5' : ''}`}
            style={isDisplayAwayChampion ? { animation: 'ko_winner_glow 1.8s ease-in-out infinite' } : undefined}
          >
            {displayAwayTeam ? (
              <>
                {displayAwayTeam.imageUrl ? (
                  <img src={displayAwayTeam.imageUrl} alt="" className={`h-7 w-7 rounded-full object-cover flex-shrink-0${isDisplayAwayTeamCorrect ? ' ring-2 ring-green-400' : ''}`} />
                ) : (
                  <div className={`h-7 w-7 rounded-full bg-muted flex-shrink-0${isDisplayAwayTeamCorrect ? ' ring-2 ring-green-400' : ''}`} />
                )}
                {teamPageCompetitionId && displayAwayTeam.teamId ? (
                  <Link to={`/competitions/${teamPageCompetitionId}/team/${displayAwayTeam.teamId}${teamPageUserId ? `?userId=${teamPageUserId}` : ''}`} className={`flex-1 text-sm truncate hover:underline ${displayAwayWins ? 'font-semibold' : 'font-medium'}`}>
                    {tn(displayAwayTeam.teamName)}
                  </Link>
                ) : (
                  <span className={`flex-1 text-sm truncate ${displayAwayWins ? 'font-semibold' : 'font-medium'}`}>
                    {tn(displayAwayTeam.teamName)}
                  </span>
                )}
                {isDisplayAwayChampion && (
                  <span style={{ animation: 'ko_trophy_pop 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
                    🏆
                  </span>
                )}
              </>
            ) : (
              <span className="flex-1 text-sm text-muted-foreground italic">TBD</span>
            )}
            {isCompleted && !forceEditable ? (
              <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>
                {prediction != null ? displayAwayScore : '—'}
              </span>
            ) : readOnly ? (
              <span className="w-11 h-9 flex items-center justify-center text-xl font-bold flex-shrink-0 text-muted-foreground">
                {prediction != null ? prediction.awayScore : '—'}
              </span>
            ) : (
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => handleScoreChange('away', String(Math.max(0, (parseInt(awayStr || '0') || 0) - 1)))}
                  className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >−</button>
                <input
                  type="text"
                  inputMode="numeric"
                  value={awayStr}
                  onChange={e => handleScoreChange('away', e.target.value)}
                  disabled={disabled}
                  className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
                  placeholder="–"
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => handleScoreChange('away', String(Math.min(99, (parseInt(awayStr || '0') || 0) + 1)))}
                  className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >+</button>
              </div>
            )}
          </div>

          {/* Who advances — only while editing is allowed */}
          {isDraw && homeTeam && awayTeam && (!isCompleted || forceEditable) && !readOnly && (
            <>
              <div className="h-px bg-border" />
              <div className="p-3 space-y-2">
                <p className="text-[11px] text-muted-foreground text-center font-medium">
                  {t('knockoutContent.whoAdvances')}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleProgressing(homeTeam.teamId)}
                    className={`flex-1 text-xs py-2 rounded-lg border font-medium transition-colors truncate px-1 ${
                      prediction?.progressingTeamId === homeTeam.teamId
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'hover:bg-muted text-muted-foreground'
                    }`}
                  >
                    {isFlipped ? tn(awayTeam.teamName) : tn(homeTeam.teamName)}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleProgressing(awayTeam.teamId)}
                    className={`flex-1 text-xs py-2 rounded-lg border font-medium transition-colors truncate px-1 ${
                      prediction?.progressingTeamId === awayTeam.teamId
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'hover:bg-muted text-muted-foreground'
                    }`}
                  >
                    {isFlipped ? tn(homeTeam.teamName) : tn(awayTeam.teamName)}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {isFlipped && (
        <p className="text-xs text-muted-foreground text-center px-2">
          ⟳ {t('knockoutContent.predictionFlipped')}
        </p>
      )}

      {/* ── Actual result card ─────────────────────────────── */}
      {isCompleted && actualMatch && (
        <div>
          <p className="text-xs text-muted-foreground text-center mb-1.5 font-medium">
            {t('knockoutContent.result')}
          </p>
          <div className="rounded-xl border-2 bg-card shadow-sm overflow-hidden">
            {/* Home row */}
            <div className={`flex items-center gap-3 px-4 py-3.5 ${actualHomeProgresses ? goldenBorderClass + ' rounded-t-xl' : ''}`}>
              {actualMatch.homeTeamImageUrl ? (
                <img src={actualMatch.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
              )}
              <span className={`flex-1 text-sm truncate ${(actualMatch.homeScore ?? 0) > (actualMatch.awayScore ?? 0) ? 'font-semibold' : 'font-medium'}`}>
                {tn(actualMatch.homeTeamName)}
              </span>
              <span className="w-11 h-9 flex items-center justify-center text-xl font-bold flex-shrink-0 tabular-nums">
                {actualMatch.homeScore}
              </span>
            </div>
            <div className="h-px bg-border" />
            {/* Away row */}
            <div className={`flex items-center gap-3 px-4 py-3.5 ${actualAwayProgresses ? goldenBorderClass : ''}`}>
              {actualMatch.awayTeamImageUrl ? (
                <img src={actualMatch.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
              )}
              <span className={`flex-1 text-sm truncate ${(actualMatch.awayScore ?? 0) > (actualMatch.homeScore ?? 0) ? 'font-semibold' : 'font-medium'}`}>
                {tn(actualMatch.awayTeamName)}
              </span>
              <span className="w-11 h-9 flex items-center justify-center text-xl font-bold flex-shrink-0 tabular-nums">
                {actualMatch.awayScore}
              </span>
            </div>
            {/* Extra time / penalties winner */}
            {actualMatch.homeScore === actualMatch.awayScore && actualMatch.progressingTeamId && (
              <>
                <div className="h-px bg-border" />
                <p className="px-4 py-2 text-xs text-muted-foreground text-center">
                  {actualMatch.progressingTeamId === actualMatch.homeTeamId
                    ? tn(actualMatch.homeTeamName)
                    : tn(actualMatch.awayTeamName)} {t('knockoutContent.advances')}
                </p>
              </>
            )}
          </div>
          {/* Points breakdown */}
          {pointsInfo !== null && (
            <div className="mt-1.5 flex flex-wrap justify-center items-center gap-x-2 gap-y-0.5 text-xs">
              <span className={`font-semibold ${pointsInfo.total > 0 ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                {pointsInfo.total > 0 ? `+${pointsInfo.total} pts` : '0 pts'}
              </span>
              {pointsInfo.correctResult > 0 && <span className="text-muted-foreground">+{pointsInfo.correctResult} {t('knockoutContent.correctResult')}</span>}
              {pointsInfo.exactScore > 0 && <span className="text-muted-foreground">+{pointsInfo.exactScore} {t('knockoutContent.correctExactScore')}</span>}
              {pointsInfo.correctTeamProgresses > 0 && <span className="text-muted-foreground">+{pointsInfo.correctTeamProgresses} {t('knockoutContent.advances')}</span>}
              {pointsInfo.correctTeamInKnockoutTie > 0 && <span className="text-muted-foreground">+{pointsInfo.correctTeamInKnockoutTie} {t('knockoutContent.correctTeamInTie')}</span>}
              {pointsInfo.correctTeamInFinal > 0 && <span className="text-muted-foreground">+{pointsInfo.correctTeamInFinal} {t('knockoutContent.correctTeamInFinal')}</span>}
              {pointsInfo.correctWinner > 0 && <span className="text-muted-foreground">+{pointsInfo.correctWinner} {t('knockoutContent.correctWinner')}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Focused bracket view ──────────────────────────────────────────────────────

function FocusedBracketView({
  knockoutConfig,
  resolvedSlots,
  bracketPreds,
  onUpdate,
  predsLoaded,
  actualMatchMap,
  scoringConfig,
  predictedFirstRoundMap,
  readOnly,
  editOverride,
  teamPageCompetitionId,
  teamPageUserId,
  onFocusedKeyChange,
}: {
  knockoutConfig: KnockoutConfig;
  resolvedSlots: Record<string, TeamStat | null>;
  bracketPreds: BracketPredictions;
  onUpdate: (key: string, pred: BracketMatchPrediction) => void;
  predsLoaded: boolean;
  actualMatchMap: Record<string, MatchWithTeams>;
  scoringConfig: ScoringConfig;
  predictedFirstRoundMap: Record<string, { predHomeId: string | null; predAwayId: string | null }>;
  readOnly?: boolean;
  editOverride?: boolean;
  teamPageCompetitionId?: string;
  teamPageUserId?: string;
  onFocusedKeyChange?: (key: string) => void;
}) {
  const { firstRound, hasBronzeFinal } = knockoutConfig;
  const startIdx = ROUND_ORDER.indexOf(firstRound);
  const chronoRounds = ROUND_ORDER.slice(startIdx);
  const reversedRounds = [...chronoRounds].reverse();
  const maxRoundIdx = chronoRounds.length - 1;
  const firstRoundMatchCount = FIRST_ROUND_COUNTS[firstRound];

  const matchTeams = useMemo(() => {
    const result: Record<string, { home: TeamStat | null; away: TeamStat | null }> = {};
    for (let i = 0; i < firstRoundMatchCount; i++) {
      result[`${maxRoundIdx}_${i}`] = {
        home: resolvedSlots[`m${i + 1}_home`] ?? null,
        away: resolvedSlots[`m${i + 1}_away`] ?? null,
      };
    }
    for (let R = maxRoundIdx - 1; R >= 0; R--) {
      const numMatches = Math.pow(2, R);
      for (let i = 0; i < numMatches; i++) {
        const leftKey = `${R + 1}_${2 * i}`;
        const rightKey = `${R + 1}_${2 * i + 1}`;
        const leftPredKey = `${reversedRounds[R + 1]}_${2 * i}`;
        const rightPredKey = `${reversedRounds[R + 1]}_${2 * i + 1}`;
        result[`${R}_${i}`] = {
          home: getWinner(result[leftKey], bracketPreds[leftPredKey]),
          away: getWinner(result[rightKey], bracketPreds[rightPredKey]),
        };
      }
    }
    return result;
  }, [resolvedSlots, bracketPreds, maxRoundIdx, reversedRounds, firstRoundMatchCount]);

  const bronzeTeams = useMemo(() => ({
    home: getLoser(matchTeams['1_0'], bracketPreds['semi_final_0']),
    away: getLoser(matchTeams['1_1'], bracketPreds['semi_final_1']),
  }), [matchTeams, bracketPreds]);

  const allMatches = useMemo<FlatMatch[]>(() => {
    const list: FlatMatch[] = [];
    chronoRounds.forEach((round, chronoR) => {
      const bracketR = maxRoundIdx - chronoR;
      const count = Math.pow(2, bracketR);
      if (hasBronzeFinal && round === 'final') {
        list.push({
          round: 'semi_final' as KnockoutFirstRound,
          matchIdxInRound: 0,
          matchCountInRound: 1,
          predKey: 'bronze_final_0',
          bracketKey: '',
          isBronze: true,
        });
      }
      for (let i = 0; i < count; i++) {
        list.push({
          round,
          matchIdxInRound: i,
          matchCountInRound: count,
          predKey: `${round}_${i}`,
          bracketKey: `${bracketR}_${i}`,
          isBronze: false,
        });
      }
    });
    return list;
  }, [chronoRounds, maxRoundIdx, hasBronzeFinal]);

  const { t } = useT();
  const getRoundLabel = (round: KnockoutFirstRound) => t(`knockout.rounds.${round}` as any) || ROUND_LABELS[round] || round;

  const [currentIdx, setCurrentIdx] = useState(0);
  const [slideDir, setSlideDir] = useState<'fromRight' | 'fromLeft'>('fromRight');
  const [animKey, setAnimKey] = useState(0);
  const initedRef = useRef(false);

  useEffect(() => {
    onFocusedKeyChange?.(allMatches[currentIdx]?.predKey ?? '');
  }, [currentIdx, allMatches, onFocusedKeyChange]);

  useEffect(() => {
    if (initedRef.current || !predsLoaded) return;
    initedRef.current = true;
  }, [predsLoaded]);

  function goTo(idx: number) {
    const dir = idx > currentIdx ? 'fromRight' : 'fromLeft';
    setSlideDir(dir);
    setAnimKey(k => k + 1);
    setCurrentIdx(idx);
  }

  function handleUpdate(key: string, pred: BracketMatchPrediction) {
    if (readOnly) return;
    onUpdate(key, pred);

    const current = allMatches[currentIdx];
    if (!current || current.isBronze) return;

    const updatedTeams = matchTeams[current.bracketKey];
    if (!isPredComplete(pred, updatedTeams)) return;

  }

  const current = allMatches[currentIdx];
  if (!current) return null;

  const currentTeams = current.isBronze
    ? bronzeTeams
    : (matchTeams[current.bracketKey] ?? { home: null, away: null });
  const currentPred = bracketPreds[current.predKey];
  const isComplete = isPredComplete(currentPred, currentTeams);
  const teamsAreTbd = !currentTeams.home || !currentTeams.away;
  const showNextArrow = currentIdx < allMatches.length - 1 && (isComplete || teamsAreTbd);
  const canGoPrev = currentIdx > 0;

  const roundMatchesForDots = current.isBronze
    ? []
    : allMatches.filter(m => m.round === current.round && !m.isBronze);

  const currentRoundLabel = current.isBronze ? t('knockoutContent.bronzeFinal') : getRoundLabel(current.round);

  return (
    <div className="space-y-5">
      <div className="flex gap-1.5 flex-wrap">
        {chronoRounds.map(round => {
          const isActive = current.round === round && !current.isBronze;
          const roundMs = allMatches.filter(m => m.round === round && !m.isBronze);
          const doneCount = roundMs.filter(m =>
            isPredComplete(bracketPreds[m.predKey], matchTeams[m.bracketKey])
          ).length;
          const allDone = doneCount === roundMs.length && roundMs.length > 0;
          const firstIdx = allMatches.findIndex(m => m.round === round && !m.isBronze);
          const roundBtn = (
            <button
              key={round}
              type="button"
              onClick={() => firstIdx !== -1 && goTo(firstIdx)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : allDone
                  ? 'bg-green-500/15 text-green-700 border border-green-500/30'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {getRoundLabel(round)}
              {allDone && <span className="ml-1 text-green-600">✓</span>}
            </button>
          );
          if (round === 'final' && hasBronzeFinal) {
            const bronzeIdx = allMatches.findIndex(m => m.isBronze);
            const isBronzeDone = isPredComplete(bracketPreds['bronze_final_0'], bronzeTeams);
            const bronzeBtn = (
              <button
                key="bronze_final"
                type="button"
                onClick={() => bronzeIdx !== -1 && goTo(bronzeIdx)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  current.isBronze
                    ? 'bg-primary text-primary-foreground'
                    : isBronzeDone
                    ? 'bg-green-500/15 text-green-700 border border-green-500/30'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {t('knockoutContent.bronzeFinal')}
                {isBronzeDone && <span className="ml-1 text-green-600">✓</span>}
              </button>
            );
            return [bronzeBtn, roundBtn];
          }
          return roundBtn;
        })}
      </div>

      <div className="rounded-xl border bg-muted/20 p-5">
        <div className="text-center mb-4">
          <h2 className="text-base font-semibold">{currentRoundLabel}</h2>
          {!current.isBronze && roundMatchesForDots.length > 1 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('knockoutContent.matchOf', { n: current.matchIdxInRound + 1, total: current.matchCountInRound })}
            </p>
          )}
        </div>

        {roundMatchesForDots.length > 1 && (
          <div className="flex justify-center gap-1.5 mb-5">
            {roundMatchesForDots.map(m => {
              const flatIdx = allMatches.indexOf(m);
              const isCurrent = flatIdx === currentIdx;
              const pred = bracketPreds[m.predKey];
              const teams = matchTeams[m.bracketKey];
              const hasPred = isPredComplete(pred, teams);
              const actualMatch = actualMatchMap[m.predKey];
              const hasActual = !!actualMatch && actualMatch.status === 'completed' && actualMatch.homeScore !== null && actualMatch.awayScore !== null;
              let isCorrectResult = false;
              let isExactScore = false;
              if (hasPred && hasActual && pred) {
                const h = actualMatch.homeScore!;
                const a = actualMatch.awayScore!;
                let predH = pred.homeScore;
                let predA = pred.awayScore;
                const predHomeId = teams?.home?.teamId ?? null;
                const predAwayId = teams?.away?.teamId ?? null;
                const actHomeId = actualMatch.homeTeamId;
                const actAwayId = actualMatch.awayTeamId;
                if (actHomeId && actAwayId) {
                  const flip = (predHomeId !== null && predHomeId === actAwayId) || (predAwayId !== null && predAwayId === actHomeId);
                  if (flip) { predH = pred.awayScore; predA = pred.homeScore; }
                }
                isCorrectResult = Math.sign(predH - predA) === Math.sign(h - a);
                isExactScore = predH === h && predA === a;
              }
              const dotClass = isCurrent
                ? 'w-5 h-2.5 bg-primary dark:bg-blue-400'
                : !hasPred
                ? 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                : !hasActual
                ? 'w-2.5 h-2.5 bg-yellow-300'
                : isExactScore
                ? 'w-2.5 h-2.5 bg-green-500 ring-1 ring-offset-1 ring-offset-background ring-amber-400'
                : isCorrectResult
                ? 'w-2.5 h-2.5 bg-green-500'
                : 'w-2.5 h-2.5 bg-red-500';
              return (
                <button
                  key={m.predKey}
                  type="button"
                  onClick={() => goTo(flatIdx)}
                  className={`rounded-full transition-all duration-200 ${dotClass}`}
                  aria-label={`Match ${m.matchIdxInRound + 1}`}
                />
              );
            })}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <button
            type="button"
            onClick={() => canGoPrev && goTo(currentIdx - 1)}
            disabled={!canGoPrev}
            className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20"
            aria-label="Previous match"
          >
            ←
          </button>

          <div
            key={animKey}
            className="flex-1 min-w-0"
            style={{
              animation: `ko_slide_${slideDir} 0.22s ease-out`,
            }}
          >
            <FocusedMatchCard
              matchKey={current.predKey}
              homeTeam={currentTeams.home}
              awayTeam={currentTeams.away}
              prediction={currentPred}
              onUpdate={handleUpdate}
              isFinal={current.round === 'final' && !current.isBronze}
              actualMatch={actualMatchMap[current.predKey]}
              isFirstRound={current.round === firstRound || current.isBronze}
              scoringConfig={scoringConfig}
              predictedFirstRoundTeams={current.round === firstRound && !current.isBronze ? predictedFirstRoundMap[current.predKey] : undefined}
              readOnly={readOnly}
              editOverride={editOverride}
              teamPageCompetitionId={teamPageCompetitionId}
              teamPageUserId={teamPageUserId}
            />
            <div className="mt-3 flex sm:hidden items-center justify-between">
              <button
                type="button"
                onClick={() => canGoPrev && goTo(currentIdx - 1)}
                disabled={!canGoPrev}
                className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
                aria-label="Previous match"
              >←</button>
              <button
                type="button"
                onClick={() => showNextArrow && goTo(currentIdx + 1)}
                disabled={!showNextArrow}
                className={`h-11 w-11 rounded-full border flex items-center justify-center transition-all duration-200 ${showNextArrow ? 'border-primary text-primary hover:bg-primary/10 shadow-sm dark:border-blue-400 dark:text-blue-400' : 'opacity-0 pointer-events-none'}`}
                aria-label="Next match"
              >→</button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => showNextArrow && goTo(currentIdx + 1)}
            disabled={!showNextArrow}
            className={`hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-all duration-200 ${
              showNextArrow
                ? 'border-primary text-primary hover:bg-primary/10 shadow-sm dark:border-blue-400 dark:text-blue-400'
                : 'opacity-0 pointer-events-none'
            }`}
            aria-label="Next match"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Knockout Bracket Visualizer ───────────────────────────────────────────────

const V_ROW_GAP = 3;
const V_CARD_W = 23;
const V_HPAD = 7;
const V_COL_W = V_CARD_W + V_HPAD * 2; // 37px per column

// Horizontal final card (icons side-by-side, much larger)
const FINAL_ICON = 29;
const FINAL_HPAD = 5;
const FINAL_HCARD_H = FINAL_ICON + FINAL_HPAD * 2; // 39px
const FINAL_HSLOT_W = FINAL_ICON + FINAL_HPAD * 2;  // 39px per team slot
const FINAL_HCARD_W = FINAL_HSLOT_W * 2 + 1;         // 79px total

// Horizontal bronze final card (smaller, also side-by-side)
const BRONZE_ICON = 21;
const BRONZE_HPAD = 4;
const BRONZE_HCARD_H = BRONZE_ICON + BRONZE_HPAD * 2; // 29px
const BRONZE_HSLOT_W = BRONZE_ICON + BRONZE_HPAD * 2;  // 29px per team slot
const BRONZE_HCARD_W = BRONZE_HSLOT_W * 2 + 1;          // 59px total


type VizTeam = { imageUrl: string | null; name: string | null };

// Icon and card height scale progressively toward the final.
// R=0=final (largest), R=maxRoundIdx=first round (smallest).
function vizRoundDims(R: number, maxRoundIdx: number): { icon: number; slot: number; cardH: number } {
  const icon = 17 + (maxRoundIdx - R); // base 17px at first round, +1 per round toward final
  const extraSlot = R === 0 ? 2 : 0;  // final card gets 4px extra height (2px per slot)
  const slot = icon + 4 + extraSlot;
  return { icon, slot, cardH: slot * 2 + 1 };
}


function VizTeamIcon({ team, size }: { team: VizTeam | null; size: number }) {
  if (!team) {
    return (
      <div
        className="rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-muted-foreground"
        style={{ width: size, height: size, fontSize: Math.max(6, Math.round(size * 0.55)), fontWeight: 700 }}
      >
        ?
      </div>
    );
  }
  return team.imageUrl ? (
    <img
      src={team.imageUrl}
      alt=""
      className="rounded-full object-cover flex-shrink-0"
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      className="rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 font-bold text-foreground"
      style={{ width: size, height: size, fontSize: Math.max(6, Math.round(size * 0.45)) }}
    >
      {team.name?.charAt(0) ?? '?'}
    </div>
  );
}

function KnockoutBracketVisualizer({
  knockoutConfig,
  actualMatchMap,
  focusedPredKey = '',
}: {
  knockoutConfig: KnockoutConfig;
  actualMatchMap: Record<string, MatchWithTeams>;
  focusedPredKey?: string;
}) {
  const { t } = useT();
  const { firstRound, hasBronzeFinal } = knockoutConfig;
  const startIdx = ROUND_ORDER.indexOf(firstRound);
  const chronoRounds = ROUND_ORDER.slice(startIdx);
  // reversedRounds[0] = 'final', reversedRounds[maxRoundIdx] = firstRound
  const reversedRounds = [...chronoRounds].reverse();
  const maxRoundIdx = chronoRounds.length - 1;
  const firstRoundMatchCount = FIRST_ROUND_COUNTS[firstRound];
  const halfCount = Math.floor(firstRoundMatchCount / 2);
  const isSingleMatch = firstRoundMatchCount === 1;

  // Spacing is driven by the first-round card height (most matches, most rows).
  // Cards in later rounds are taller but centered on the same yCenter grid.
  const firstRoundDims = vizRoundDims(maxRoundIdx, maxRoundIdx);

  // yCenter[`${R}_${i}`] = vertical midpoint for local index i (0-based within each side).
  const yCenter = useMemo(() => {
    const map: Record<string, number> = {};
    if (isSingleMatch) {
      map['0_0'] = firstRoundDims.cardH / 2;
      return map;
    }
    for (let i = 0; i < halfCount; i++) {
      map[`${maxRoundIdx}_${i}`] = i * (firstRoundDims.cardH + V_ROW_GAP) + firstRoundDims.cardH / 2;
    }
    for (let R = maxRoundIdx - 1; R >= 1; R--) {
      const numSide = Math.pow(2, R - 1);
      for (let i = 0; i < numSide; i++) {
        map[`${R}_${i}`] = (map[`${R + 1}_${2 * i}`] + map[`${R + 1}_${2 * i + 1}`]) / 2;
      }
    }
    // Final y = same as SF y (both halves are symmetric)
    map['0_0'] = map['1_0'] ?? firstRoundDims.cardH / 2;
    return map;
  }, [halfCount, maxRoundIdx, isSingleMatch, firstRoundDims.cardH]);

  const mainH = isSingleMatch
    ? firstRoundDims.cardH
    : halfCount * (firstRoundDims.cardH + V_ROW_GAP) - V_ROW_GAP;

  // Anchor Final and Bronze relative to the SF center so they stay visually adjacent
  // regardless of how tall the overall bracket is.
  const sfGap = 36; // px between Final card bottom and SF center
  const bronzeCardGap = 26; // px between SF card bottom and bronze card top
  const sfDims = maxRoundIdx >= 1 ? vizRoundDims(1, maxRoundIdx) : firstRoundDims;
  const sfCenterInGrid = isSingleMatch ? firstRoundDims.cardH / 2 : (yCenter['0_0'] ?? firstRoundDims.cardH / 2);

  // topOffset shifts the bracket grid down just enough so the Final card (above the SF) stays at y≥0
  const topOffset = isSingleMatch ? 0 : Math.max(0, FINAL_HCARD_H + sfGap - sfCenterInGrid);

  // Absolute Y of the SF center within the bracket area div
  const sfAbsCenterY = isSingleMatch ? firstRoundDims.cardH / 2 : topOffset + sfCenterInGrid;

  // Final card: just above SF center
  const finalTop = isSingleMatch ? 0 : sfAbsCenterY - FINAL_HCARD_H - sfGap;

  // Bronze card: just below the SF card
  const bronzeTop = sfAbsCenterY + sfDims.cardH / 2 + bronzeCardGap;

  const bracketCardsBottom = topOffset + mainH; // bottom edge of the last first-round card
  const totalH = hasBronzeFinal
    ? Math.max(bracketCardsBottom, bronzeTop + BRONZE_HCARD_H + 14) // +14 for "Bronze Final" label below
    : bracketCardsBottom;

  // (2*maxRoundIdx + 1) columns: left side + center (final) + right side
  const totalW = isSingleMatch ? FINAL_HCARD_W : (2 * maxRoundIdx + 1) * V_COL_W;

  // Left side: R=maxRoundIdx at col 0, R=1 at col maxRoundIdx-1
  const cardLeftX_left = (R: number) => (maxRoundIdx - R) * V_COL_W + V_HPAD;
  // Right side: R=1 at col maxRoundIdx+1, R=maxRoundIdx at col 2*maxRoundIdx
  const cardLeftX_right = (R: number) => (maxRoundIdx + R) * V_COL_W + V_HPAD;

  // Horizontal final card: centered on bracket
  const finalCenterX = isSingleMatch ? FINAL_HCARD_W / 2 : maxRoundIdx * V_COL_W + V_COL_W / 2;
  const finalHCardLeft = finalCenterX - FINAL_HCARD_W / 2;
  const bronzeHCardLeft = finalCenterX - BRONZE_HCARD_W / 2;

  function getTeams(side: 'left' | 'right', R: number, localI: number): { home: VizTeam | null; away: VizTeam | null } {
    // Right side: offset local index by half the total matches at round R
    const actualI = side === 'right' ? Math.pow(2, R - 1) + localI : localI;
    const m = actualMatchMap[`${reversedRounds[R]}_${actualI}`];
    return {
      home: m?.homeTeamId ? { imageUrl: m.homeTeamImageUrl, name: m.homeTeamName } : null,
      away: m?.awayTeamId ? { imageUrl: m.awayTeamImageUrl, name: m.awayTeamName } : null,
    };
  }

  function renderCard(
    key: string, left: number, top: number,
    home: VizTeam | null, away: VizTeam | null,
    dims: { icon: number; slot: number; cardH: number },
    opts?: { homeProgressed?: boolean; awayProgressed?: boolean; dashed?: boolean; focused?: boolean },
  ) {
    const { homeProgressed = false, awayProgressed = false, dashed = false, focused = false } = opts ?? {};
    const focusStyle = focused ? { outline: '1.5px dashed #eab308', outlineOffset: '2px' } : {};
    return (
      <div
        key={key}
        style={{ position: 'absolute', left, top, width: V_CARD_W, height: dims.cardH, ...focusStyle }}
        className={`rounded-sm border${dashed ? ' border-dashed' : ''} bg-card overflow-hidden flex flex-col`}
      >
        <div style={{ height: dims.slot, boxShadow: homeProgressed ? 'inset 0 0 0 1.5px #eab308' : undefined }} className="flex items-center justify-center">
          <VizTeamIcon team={home} size={dims.icon} />
        </div>
        <div className="bg-border flex-shrink-0" style={{ height: 1 }} />
        <div style={{ height: dims.slot, boxShadow: awayProgressed ? 'inset 0 0 0 1.5px #eab308' : undefined }} className="flex items-center justify-center">
          <VizTeamIcon team={away} size={dims.icon} />
        </div>
      </div>
    );
  }

  function renderHorizCard(
    key: string, left: number, top: number,
    home: VizTeam | null, away: VizTeam | null,
    iconSize: number, slotW: number, cardH: number,
    opts?: { dashed?: boolean; focused?: boolean; homeProgressed?: boolean; awayProgressed?: boolean },
  ) {
    const { dashed = false, focused = false, homeProgressed = false, awayProgressed = false } = opts ?? {};
    const cardW = slotW * 2 + 1;
    const focusStyle = focused ? { outline: '1.5px dashed #eab308', outlineOffset: '2px' } : {};
    return (
      <div
        key={key}
        style={{ position: 'absolute', left, top, width: cardW, height: cardH, ...focusStyle }}
        className={`rounded-sm border${dashed ? ' border-dashed' : ''} bg-card overflow-hidden flex flex-row`}
      >
        <div style={{ width: slotW, overflow: 'hidden', background: homeProgressed ? 'radial-gradient(circle, rgba(234,179,8,0.35) 0%, transparent 75%)' : undefined, boxShadow: homeProgressed ? 'inset 0 0 0 1.5px #eab308' : undefined }} className="flex items-center justify-center flex-shrink-0 self-stretch">
          <VizTeamIcon team={home} size={iconSize} />
        </div>
        <div className="bg-border flex-shrink-0" style={{ width: 1 }} />
        <div style={{ width: slotW, overflow: 'hidden', background: awayProgressed ? 'radial-gradient(circle, rgba(234,179,8,0.35) 0%, transparent 75%)' : undefined, boxShadow: awayProgressed ? 'inset 0 0 0 1.5px #eab308' : undefined }} className="flex items-center justify-center flex-shrink-0 self-stretch">
          <VizTeamIcon team={away} size={iconSize} />
        </div>
      </div>
    );
  }

  const bronzeMatch = hasBronzeFinal ? actualMatchMap['bronze_final_0'] : undefined;

  // Returns which slot ('home' | 'away') of match (R, side, localI) progressed to the next round,
  // or null if no team from that match appears in the parent match.
  function getProgressedSlot(R: number, side: 'left' | 'right', localI: number): 'home' | 'away' | null {
    if (R === 0) return null;
    const childActualI = side === 'right' ? Math.pow(2, R - 1) + localI : localI;
    const child = actualMatchMap[`${reversedRounds[R]}_${childActualI}`];
    if (!child) return null;

    let parent: MatchWithTeams | undefined;
    if (R === 1) {
      parent = actualMatchMap[`${reversedRounds[0]}_0`]; // SF → Final
    } else {
      const parentLocalI = Math.floor(localI / 2);
      const parentActualI = side === 'right' ? Math.pow(2, R - 2) + parentLocalI : parentLocalI;
      parent = actualMatchMap[`${reversedRounds[R - 1]}_${parentActualI}`];
    }
    if (!parent) return null;

    if (child.homeTeamId && (parent.homeTeamId === child.homeTeamId || parent.awayTeamId === child.homeTeamId)) return 'home';
    if (child.awayTeamId && (parent.homeTeamId === child.awayTeamId || parent.awayTeamId === child.awayTeamId)) return 'away';
    return null;
  }

  const GOLD = '#eab308';
  const BORDER = 'hsl(var(--border))';

  return (
    <div className="flex justify-center">
      <div style={{ width: totalW }}>
        {/* Round labels */}
        <div style={{ height: 14, position: 'relative', marginBottom: 3 }}>
          {!isSingleMatch && Array.from({ length: maxRoundIdx }, (_, idx) => {
            const R = maxRoundIdx - idx;
            const label = t(`knockoutContent.vizRoundLabels.${reversedRounds[R]}`);
            const leftX = idx * V_COL_W + V_COL_W / 2;
            const rightX = (2 * maxRoundIdx - idx) * V_COL_W + V_COL_W / 2;
            return [
              <span key={`lbl_L_${R}`} style={{ position: 'absolute', left: leftX, transform: 'translateX(-50%)', fontSize: 8 }}
                className="text-muted-foreground font-semibold whitespace-nowrap leading-none">{label}</span>,
              <span key={`lbl_R_${R}`} style={{ position: 'absolute', left: rightX, transform: 'translateX(-50%)', fontSize: 8 }}
                className="text-muted-foreground font-semibold whitespace-nowrap leading-none">{label}</span>,
            ];
          }).flat()}
          <span style={{ position: 'absolute', left: finalCenterX, transform: 'translateX(-50%)', fontSize: 8 }}
            className="text-muted-foreground font-semibold whitespace-nowrap leading-none">{t(`knockoutContent.vizRoundLabels.${reversedRounds[0]}`)}</span>
        </div>

        {/* Bracket area */}
        <div style={{ position: 'relative', width: totalW, height: totalH }}>
          {/* SVG connector lines */}
          <svg
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
            width={totalW}
            height={totalH}
          >
            {!isSingleMatch && (
              <>
                {/* Left side: connect each round to its parent, stopping before final */}
                {Array.from({ length: maxRoundIdx - 1 }).flatMap((_, step) => {
                  const childR = maxRoundIdx - step;
                  const parentR = childR - 1;
                  const numParents = Math.pow(2, parentR - 1);
                  return Array.from({ length: numParents }, (_, i) => {
                    const topY = topOffset + yCenter[`${childR}_${2 * i}`];
                    const botY = topOffset + yCenter[`${childR}_${2 * i + 1}`];
                    const parentY = topOffset + yCenter[`${parentR}_${i}`];
                    const childRight = cardLeftX_left(childR) + V_CARD_W;
                    const parentLeft = cardLeftX_left(parentR);
                    const midX = (childRight + parentLeft) / 2;
                    const topGold = getProgressedSlot(childR, 'left', 2 * i) !== null;
                    const botGold = getProgressedSlot(childR, 'left', 2 * i + 1) !== null;
                    const anyGold = topGold || botGold;
                    return [
                      <path key={`Lc_${childR}_${i}_t`} fill="none" strokeWidth={topGold ? 1.5 : 1}
                        stroke={topGold ? GOLD : BORDER} d={`M ${childRight} ${topY} L ${midX} ${topY}`} />,
                      <path key={`Lc_${childR}_${i}_v`} fill="none" strokeWidth="1"
                        stroke={BORDER} d={`M ${midX} ${topY} L ${midX} ${botY}`} />,
                      <path key={`Lc_${childR}_${i}_b`} fill="none" strokeWidth={botGold ? 1.5 : 1}
                        stroke={botGold ? GOLD : BORDER} d={`M ${midX} ${botY} L ${childRight} ${botY}`} />,
                      <path key={`Lc_${childR}_${i}_p`} fill="none" strokeWidth={anyGold ? 1.5 : 1}
                        stroke={anyGold ? GOLD : BORDER} d={`M ${midX} ${parentY} L ${parentLeft} ${parentY}`} />,
                    ];
                  });
                })}
                {/* SF → Final: L-shaped paths meeting at center, vertical up to final card bottom */}
                {(() => {
                  const leftGold = getProgressedSlot(1, 'left', 0) !== null;
                  const rightGold = getProgressedSlot(1, 'right', 0) !== null;
                  const anyGold = leftGold || rightGold;
                  return (
                    <>
                      <path key="Lc_sf_final" fill="none" strokeWidth={leftGold ? 1.5 : 1}
                        stroke={leftGold ? GOLD : BORDER}
                        d={`M ${cardLeftX_left(1) + V_CARD_W} ${sfAbsCenterY} H ${finalCenterX}`} />
                      <path key="Rc_sf_final" fill="none" strokeWidth={rightGold ? 1.5 : 1}
                        stroke={rightGold ? GOLD : BORDER}
                        d={`M ${cardLeftX_right(1)} ${sfAbsCenterY} H ${finalCenterX}`} />
                      <path key="vert_sf_final" fill="none" strokeWidth={anyGold ? 1.5 : 1}
                        stroke={anyGold ? GOLD : BORDER}
                        d={`M ${finalCenterX} ${sfAbsCenterY} V ${finalTop + FINAL_HCARD_H}`} />
                    </>
                  );
                })()}
                {/* Right side: connect each round to its parent (mirrored) */}
                {Array.from({ length: maxRoundIdx - 1 }).flatMap((_, step) => {
                  const childR = maxRoundIdx - step;
                  const parentR = childR - 1;
                  const numParents = Math.pow(2, parentR - 1);
                  return Array.from({ length: numParents }, (_, i) => {
                    const topY = topOffset + yCenter[`${childR}_${2 * i}`];
                    const botY = topOffset + yCenter[`${childR}_${2 * i + 1}`];
                    const parentY = topOffset + yCenter[`${parentR}_${i}`];
                    const childLeft = cardLeftX_right(childR);
                    const parentRight = cardLeftX_right(parentR) + V_CARD_W;
                    const midX = (childLeft + parentRight) / 2;
                    const topGold = getProgressedSlot(childR, 'right', 2 * i) !== null;
                    const botGold = getProgressedSlot(childR, 'right', 2 * i + 1) !== null;
                    const anyGold = topGold || botGold;
                    return [
                      <path key={`Rc_${childR}_${i}_t`} fill="none" strokeWidth={topGold ? 1.5 : 1}
                        stroke={topGold ? GOLD : BORDER} d={`M ${childLeft} ${topY} L ${midX} ${topY}`} />,
                      <path key={`Rc_${childR}_${i}_v`} fill="none" strokeWidth="1"
                        stroke={BORDER} d={`M ${midX} ${topY} L ${midX} ${botY}`} />,
                      <path key={`Rc_${childR}_${i}_b`} fill="none" strokeWidth={botGold ? 1.5 : 1}
                        stroke={botGold ? GOLD : BORDER} d={`M ${midX} ${botY} L ${childLeft} ${botY}`} />,
                      <path key={`Rc_${childR}_${i}_p`} fill="none" strokeWidth={anyGold ? 1.5 : 1}
                        stroke={anyGold ? GOLD : BORDER} d={`M ${midX} ${parentY} L ${parentRight} ${parentY}`} />,
                    ];
                  });
                })}
                {/* Dotted lines: left SF bottom → bronze final top, right SF bottom → bronze final top */}
                {hasBronzeFinal && maxRoundIdx >= 1 && (
                  <path key="bronze_vert"
                    d={`M ${finalCenterX} ${sfAbsCenterY} V ${bronzeTop}`}
                    fill="none" stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray="3 2" />
                )}
              </>
            )}
          </svg>

          {/* Left side match cards */}
          {!isSingleMatch && Array.from({ length: maxRoundIdx }).flatMap((_, step) => {
            const R = maxRoundIdx - step;
            const numSide = R === maxRoundIdx ? halfCount : Math.pow(2, R - 1);
            const dims = vizRoundDims(R, maxRoundIdx);
            return Array.from({ length: numSide }, (_, i) => {
              const { home, away } = getTeams('left', R, i);
              const top = topOffset + yCenter[`${R}_${i}`] - dims.cardH / 2;
              const prog = getProgressedSlot(R, 'left', i);
              const predKey = `${reversedRounds[R]}_${i}`;
              return renderCard(`L_${R}_${i}`, cardLeftX_left(R), top, home, away, dims,
                { homeProgressed: prog === 'home', awayProgressed: prog === 'away', focused: predKey === focusedPredKey });
            });
          })}

          {/* Final label + card */}
          <span
            style={{ position: 'absolute', left: finalCenterX, top: finalTop - 11, transform: 'translateX(-50%)', fontSize: 8 }}
            className="text-muted-foreground font-semibold whitespace-nowrap leading-none"
          >
            {t('stages.final')}
          </span>
          {(() => {
            const m = actualMatchMap[`${reversedRounds[0]}_0`];
            const home = m?.homeTeamId ? { imageUrl: m.homeTeamImageUrl, name: m.homeTeamName } : null;
            const away = m?.awayTeamId ? { imageUrl: m.awayTeamImageUrl, name: m.awayTeamName } : null;
            const homeProgressed = !!m?.progressingTeamId && m.progressingTeamId === m.homeTeamId;
            const awayProgressed = !!m?.progressingTeamId && m.progressingTeamId === m.awayTeamId;
            return renderHorizCard('final', finalHCardLeft, finalTop, home, away, FINAL_ICON, FINAL_HSLOT_W, FINAL_HCARD_H,
              { focused: `${reversedRounds[0]}_0` === focusedPredKey, homeProgressed, awayProgressed });
          })()}

          {/* Right side match cards */}
          {!isSingleMatch && Array.from({ length: maxRoundIdx }).flatMap((_, step) => {
            const R = maxRoundIdx - step;
            const numSide = R === maxRoundIdx ? halfCount : Math.pow(2, R - 1);
            const dims = vizRoundDims(R, maxRoundIdx);
            return Array.from({ length: numSide }, (_, i) => {
              const { home, away } = getTeams('right', R, i);
              const top = topOffset + yCenter[`${R}_${i}`] - dims.cardH / 2;
              const prog = getProgressedSlot(R, 'right', i);
              const predKey = `${reversedRounds[R]}_${Math.pow(2, R - 1) + i}`;
              return renderCard(`R_${R}_${i}`, cardLeftX_right(R), top, home, away, dims,
                { homeProgressed: prog === 'home', awayProgressed: prog === 'away', focused: predKey === focusedPredKey });
            });
          })}

          {/* Bronze final (horizontal, below main bracket, centered) */}
          {hasBronzeFinal && (
            <>
              <span
                style={{ position: 'absolute', left: finalCenterX, top: bronzeTop + BRONZE_HCARD_H + 4, transform: 'translateX(-50%)', fontSize: 8 }}
                className="text-muted-foreground font-semibold whitespace-nowrap leading-none"
              >
                {t('knockoutContent.bronzeFinal')}
              </span>
              {renderHorizCard('bronze', bronzeHCardLeft, bronzeTop,
                bronzeMatch?.homeTeamId ? { imageUrl: bronzeMatch.homeTeamImageUrl, name: bronzeMatch.homeTeamName } : null,
                bronzeMatch?.awayTeamId ? { imageUrl: bronzeMatch.awayTeamImageUrl, name: bronzeMatch.awayTeamName } : null,
                BRONZE_ICON, BRONZE_HSLOT_W, BRONZE_HCARD_H, { dashed: true, focused: focusedPredKey === 'bronze_final_0' })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────

export default function KnockoutStageContent({
  competitionId,
  viewUserId,
  lateAdditionWindowActive,
  onAllComplete,
  onGoToGroupStage,
}: {
  competitionId: string;
  viewUserId?: string;
  lateAdditionWindowActive?: boolean;
  onAllComplete?: () => void;
  onGoToGroupStage?: () => void;
}) {
  const id = competitionId;
  const { user } = useAuthStore();
  const { t } = useT();

  const { data: competition, isLoading, error } = useQuery({
    queryKey: ['competitions', id],
    queryFn: () => api.get<Competition>(`/competitions/${id}`),
  });

  const { data: tournament } = useQuery({
    queryKey: ['tournament', competition?.tournamentId],
    queryFn: () => api.get<Tournament>(`/tournaments/${competition!.tournamentId}`),
    enabled: !!competition,
  });

  const { data: matchList = [] } = useQuery({
    queryKey: ['tournaments', competition?.tournamentId, 'matches'],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${competition!.tournamentId}/matches`),
    enabled: !!competition,
  });

  const { data: savedGroupPredictions = [] } = useQuery({
    queryKey: viewUserId
      ? ['competitions', id, 'predictions', viewUserId]
      : ['competitions', id, 'predictions'],
    queryFn: viewUserId
      ? () => api.get<{ predictions: Prediction[] }>(`/competitions/${id}/predictions/${viewUserId}`).then(r => r.predictions)
      : () => api.get<Prediction[]>(`/competitions/${id}/predictions`),
    // The parent UserPredictionsPage caches the same query key with the full
    // { predictions, username, imageUrl } shape. Normalize to always get an array.
    select: (data: Prediction[] | { predictions: Prediction[] }) =>
      Array.isArray(data) ? data : (data?.predictions ?? []),
    enabled: !!competition,
  });

  const { data: savedBracketPreds } = useQuery({
    queryKey: viewUserId
      ? ['competitions', id, 'bracket-predictions', viewUserId]
      : ['competitions', id, 'bracket-predictions'],
    queryFn: viewUserId
      ? () => api.get<BracketPredictions>(`/competitions/${id}/bracket-predictions/${viewUserId}`)
      : () => api.get<BracketPredictions>(`/competitions/${id}/bracket-predictions`),
    enabled: !!competition,
  });

  const { data: savedTiebreakerChoices } = useQuery({
    queryKey: viewUserId
      ? ['competitions', id, 'tiebreak-choices', viewUserId]
      : ['competitions', id, 'tiebreak-choices'],
    queryFn: viewUserId
      ? () => api.get<{ groupChoices: DisciplinaryChoices; luckyLoserChoices: DisciplinaryChoices }>(`/competitions/${id}/tiebreak-choices/${viewUserId}`)
      : () => api.get<{ groupChoices: DisciplinaryChoices; luckyLoserChoices: DisciplinaryChoices }>(`/competitions/${id}/tiebreak-choices`),
    enabled: !!competition,
  });

  const [localPreds, setLocalPreds] = useState<BracketPredictions>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [initialized, setInitialized] = useState(false);
  const [focusedPredKey, setFocusedPredKey] = useState<string>('');
  const [groupDisciplinaryChoices, setGroupDisciplinaryChoices] = useState<DisciplinaryChoices>({});
  const [luckyLoserDisciplinaryChoices, setLuckyLoserDisciplinaryChoices] = useState<DisciplinaryChoices>({});
  const latestPredsRef = useRef<BracketPredictions>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  latestPredsRef.current = localPreds;

  useEffect(() => {
    if (savedBracketPreds && !initialized) {
      setLocalPreds(savedBracketPreds);
      latestPredsRef.current = savedBracketPreds;
      setInitialized(true);
    }
  }, [savedBracketPreds, initialized]);

  useEffect(() => {
    if (savedTiebreakerChoices) {
      if (savedTiebreakerChoices.groupChoices) setGroupDisciplinaryChoices(savedTiebreakerChoices.groupChoices);
      if (savedTiebreakerChoices.luckyLoserChoices) setLuckyLoserDisciplinaryChoices(savedTiebreakerChoices.luckyLoserChoices);
    }
  }, [savedTiebreakerChoices]);


  const saveMutation = useMutation({
    mutationFn: (predictions: BracketPredictions) =>
      api.post(`/competitions/${id}/bracket-predictions`, { predictions }),
    onSuccess: () => setSaveStatus('saved'),
    onError: () => setSaveStatus('error'),
  });

  const isComparisonUser = !viewUserId && !!user?.isComparisonUser;
  const isReadOnly = !!viewUserId || (!isComparisonUser && !lateAdditionWindowActive && (tournament?.status === 'active' || tournament?.status === 'completed'));

  function updatePrediction(key: string, pred: BracketMatchPrediction) {
    if (isReadOnly) return;
    const next = { ...latestPredsRef.current, [key]: pred };
    latestPredsRef.current = next;
    setLocalPreds(next);
    setSaveStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveMutation.mutate(latestPredsRef.current);
    }, 600);
  }

  const predMap = useMemo(
    () => Object.fromEntries(savedGroupPredictions.map(p => [p.matchId, p])),
    [savedGroupPredictions]
  );

  const knockoutConfig = tournament?.knockoutConfig ?? null;

  // Predicted group standings based solely on the user's group score predictions (not actual results).
  // Used to determine which teams the user expected to qualify for each first-round knockout slot.
  const { predictedGroupStandings, predictedGroupResults } = useMemo(() => {
    const groupMatches = matchList.filter(m => m.stage === 'group');
    const teamMap = new Map<string, TeamStat>();
    for (const m of groupMatches) {
      const g = m.groupName;
      if (!g) continue;
      if (m.homeTeamId && m.homeTeamName && !teamMap.has(m.homeTeamId))
        teamMap.set(m.homeTeamId, { teamId: m.homeTeamId, teamName: m.homeTeamName, imageUrl: m.homeTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
      if (m.awayTeamId && m.awayTeamName && !teamMap.has(m.awayTeamId))
        teamMap.set(m.awayTeamId, { teamId: m.awayTeamId, teamName: m.awayTeamName, imageUrl: m.awayTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
    }
    const groupResultsMap = new Map<string, MatchResult[]>();
    for (const m of groupMatches) {
      if (!m.homeTeamId || !m.awayTeamId || !m.groupName) continue;
      const pred = predMap[m.id];
      if (!pred) continue;
      const hs = pred.homeScore;
      const as_ = pred.awayScore;
      const home = teamMap.get(m.homeTeamId);
      const away = teamMap.get(m.awayTeamId);
      if (home) { home.P++; home.GF += hs; home.GA += as_; if (hs > as_) home.W++; else if (hs === as_) home.D++; else home.L++; }
      if (away) { away.P++; away.GF += as_; away.GA += hs; if (as_ > hs) away.W++; else if (hs === as_) away.D++; else away.L++; }
      if (!groupResultsMap.has(m.groupName)) groupResultsMap.set(m.groupName, []);
      groupResultsMap.get(m.groupName)!.push({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, homeScore: hs, awayScore: as_ });
    }
    const byGroup = new Map<string, TeamStat[]>();
    for (const t of teamMap.values()) {
      if (!byGroup.has(t.group)) byGroup.set(t.group, []);
      byGroup.get(t.group)!.push(t);
    }
    for (const [groupName, teams] of byGroup) {
      const results = groupResultsMap.get(groupName) ?? [];
      const stats = teams.map(t => ({ teamId: t.teamId, points: t.W * 3 + t.D, gd: t.GF - t.GA, gf: t.GF }));
      const sortedIds = sortGroupTeams(stats, results, groupDisciplinaryChoices).map(s => s.teamId);
      teams.sort((a, b) => sortedIds.indexOf(a.teamId) - sortedIds.indexOf(b.teamId));
    }
    return { predictedGroupStandings: byGroup, predictedGroupResults: groupResultsMap };
  }, [matchList, predMap, groupDisciplinaryChoices]);

  const knockoutMatchMap = useMemo(() => {
    const koStages = new Set(['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final']);
    const byStage = new Map<string, MatchWithTeams[]>();
    for (const m of matchList) {
      if (!koStages.has(m.stage)) continue;
      if (!byStage.has(m.stage)) byStage.set(m.stage, []);
      byStage.get(m.stage)!.push(m);
    }
    for (const ms of byStage.values()) {
      ms.sort((a, b) => {
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      });
    }
    const result: Record<string, MatchWithTeams> = {};
    for (const [stage, ms] of byStage) {
      ms.forEach((m, i) => { result[`${stage}_${i}`] = m; });
    }
    return result;
  }, [matchList]);

  const expectedMatchCount = useMemo(() => {
    if (!knockoutConfig) return 0;
    const countByFirstRound: Record<string, number> = {
      round_of_32: 31, round_of_16: 15, quarter_final: 7, semi_final: 3, final: 1,
    };
    return (countByFirstRound[knockoutConfig.firstRound] ?? 0) + (knockoutConfig.hasBronzeFinal ? 1 : 0);
  }, [knockoutConfig]);

  const allKnockoutComplete = useMemo(() =>
    expectedMatchCount > 0 &&
    Object.values(localPreds).filter(p =>
      p.homeScore !== p.awayScore || p.progressingTeamId != null
    ).length >= expectedMatchCount,
    [expectedMatchCount, localPreds]
  );

  useEffect(() => {
    if (allKnockoutComplete) onAllComplete?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allKnockoutComplete]);

  const luckyLoserLabels = useMemo(() => {
    if (!knockoutConfig || !knockoutConfig.luckyLosers) return {};
    const groupNames = [...predictedGroupStandings.keys()];
    return computeLuckyLoserLabels(
      FIRST_ROUND_COUNTS[knockoutConfig.firstRound],
      knockoutConfig.bracketSlots,
      groupNames,
      knockoutConfig.directQualifiers,
    );
  }, [knockoutConfig, predictedGroupStandings]);

  const resolvedSlots = useMemo(() => {
    if (!knockoutConfig) return {};
    return resolveSlots(
      knockoutConfig.bracketSlots,
      luckyLoserLabels,
      [...predictedGroupStandings.entries()],
      knockoutConfig.directQualifiers,
      FIRST_ROUND_COUNTS[knockoutConfig.firstRound],
      luckyLoserDisciplinaryChoices,
    );
  }, [knockoutConfig, luckyLoserLabels, predictedGroupStandings, luckyLoserDisciplinaryChoices]);

  // Maps each first-round predKey (e.g. "round_of_16_0") to the teams the user predicted
  // would qualify for that slot. Derived from resolvedSlots so lucky-loser slots are
  // resolved the same way as the predicted bracket display.
  const predictedFirstRoundMap = useMemo<Record<string, { predHomeId: string | null; predAwayId: string | null }>>(() => {
    if (!knockoutConfig) return {};
    const { firstRound } = knockoutConfig;
    const count = FIRST_ROUND_COUNTS[firstRound];
    const result: Record<string, { predHomeId: string | null; predAwayId: string | null }> = {};
    for (let i = 0; i < count; i++) {
      result[`${firstRound}_${i}`] = {
        predHomeId: resolvedSlots[`m${i + 1}_home`]?.teamId ?? null,
        predAwayId: resolvedSlots[`m${i + 1}_away`]?.teamId ?? null,
      };
    }
    return result;
  }, [knockoutConfig, resolvedSlots]);

  const groupDisciplinaryTies = useMemo(() => {
    const directQualifiers = knockoutConfig?.directQualifiers ?? 2;
    const result: Array<{ groupName: string; teams: TeamStat[]; key: string; requiredRankings: number }> = [];
    for (const [groupName, teams] of predictedGroupStandings) {
      const results = predictedGroupResults.get(groupName) ?? [];
      const tiebreakerStats = teams.map(t => ({ teamId: t.teamId, points: t.W * 3 + t.D, gd: t.GF - t.GA, gf: t.GF }));
      const tiedGroups = findGroupDisciplinaryTies(tiebreakerStats, results);
      for (const tiedGroup of tiedGroups) {
        const key = makeDisciplinaryKey(tiedGroup.map(t => t.teamId));
        const existing = groupDisciplinaryChoices[key] ?? [];
        if (existing.length < tiedGroup.length) {
          const startIndex = Math.min(...tiedGroup.map(t => teams.findIndex(tt => tt.teamId === t.teamId)));
          const K = Math.max(1, Math.min(directQualifiers, startIndex + tiedGroup.length) - startIndex);
          const requiredRankings = Math.min(K, tiedGroup.length - 1);
          result.push({ groupName, teams: tiedGroup.map(s => teams.find(t => t.teamId === s.teamId)!).filter(Boolean), key, requiredRankings });
        }
      }
    }
    return result;
  }, [predictedGroupStandings, predictedGroupResults, groupDisciplinaryChoices, knockoutConfig]);

  const luckyLoserDisciplinaryTies = useMemo(() => {
    if (!knockoutConfig) return [];
    const third = [...predictedGroupStandings.entries()]
      .filter(([, t]) => t.length > knockoutConfig.directQualifiers)
      .map(([, t]) => t[knockoutConfig.directQualifiers]);
    const tiebreakerStats = third.map(t => ({ teamId: t.teamId, points: t.W * 3 + t.D, gd: t.GF - t.GA, gf: t.GF }));
    return findLuckyLoserDisciplinaryTies(tiebreakerStats)
      .filter(group => {
        const key = makeDisciplinaryKey(group.map(t => t.teamId));
        const existing = luckyLoserDisciplinaryChoices[key] ?? [];
        return existing.length < group.length;
      })
      .map(group => ({
        key: makeDisciplinaryKey(group.map(t => t.teamId)),
        teams: group.map(s => third.find(t => t.teamId === s.teamId)!).filter(Boolean),
      }));
  }, [predictedGroupStandings, knockoutConfig, luckyLoserDisciplinaryChoices]);

  if (isLoading) return <LoadingSpinner />;
  if (error) {
    const msg = error instanceof ApiError ? error.message : t('knockoutContent.saveFailed');
    return <p className="py-4 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

  // Count group matches that require a prediction (both teams assigned)
  const groupMatchesWithTeams = matchList.filter(
    m => m.stage === 'group' && m.homeTeamId && m.awayTeamId
  );
  const savedPredMatchIds = new Set(savedGroupPredictions.map(p => p.matchId));
  const missingPredictions = groupMatchesWithTeams.some(m => !savedPredMatchIds.has(m.id));

  if (missingPredictions && !viewUserId && !isReadOnly) {
    return (
      <div className="rounded-xl border bg-muted/20 p-6 text-center space-y-3">
        <p className="font-semibold">{t('knockoutContent.missingGroupPreds')}</p>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          {t('knockoutContent.missingGroupPredsDetail')}
        </p>
        {onGoToGroupStage && (
          <button
            type="button"
            onClick={onGoToGroupStage}
            className="mt-1 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
          >
            {t('knockoutContent.goToGroupStage')}
          </button>
        )}
      </div>
    );
  }

  const hasPendingTies = groupDisciplinaryTies.length > 0 || luckyLoserDisciplinaryTies.length > 0;

  return (
    <>
      <style>{`
        @keyframes ko_slide_fromRight {
          from { opacity: 0; transform: translateX(36px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes ko_slide_fromLeft {
          from { opacity: 0; transform: translateX(-36px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes ko_winner_glow {
          0%, 100% { background-color: rgba(234, 179, 8, 0.08); }
          50%       { background-color: rgba(234, 179, 8, 0.22); }
        }
        @keyframes ko_trophy_pop {
          from { transform: scale(0) rotate(-20deg); opacity: 0; }
          to   { transform: scale(1) rotate(0deg);   opacity: 1; }
        }
      `}</style>

      {isReadOnly && (
        <div className="mb-4 rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {t('knockoutContent.predictionsLocked')}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-muted-foreground">
          {t('knockoutContent.teamsBasedOn')}
        </p>
        {!isReadOnly && (
          <span className={`text-xs flex-shrink-0 ml-4 ${
            saveStatus === 'saving' ? 'text-muted-foreground' :
            saveStatus === 'saved' ? 'text-green-600' :
            saveStatus === 'error' ? 'text-destructive' : 'invisible'
          }`}>
            {saveStatus === 'saving' ? t('knockoutContent.saving') : saveStatus === 'saved' ? t('knockoutContent.saved') : saveStatus === 'error' ? t('knockoutContent.saveFailed') : '.'}
          </span>
        )}
      </div>

      {hasPendingTies && !isReadOnly && (
        <div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-50/10 px-4 py-3 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">{t('knockoutContent.tiebreakerWarning')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('knockoutContent.tiebreakerNote')}
          </p>
        </div>
      )}

      {knockoutConfig ? (
        <>
          <div className={hasPendingTies && !isReadOnly ? 'relative' : ''}>
            <FocusedBracketView
              knockoutConfig={knockoutConfig}
              resolvedSlots={resolvedSlots}
              bracketPreds={localPreds}
              onUpdate={updatePrediction}
              predsLoaded={initialized}
              actualMatchMap={knockoutMatchMap}
              scoringConfig={competition.scoringConfig}
              predictedFirstRoundMap={predictedFirstRoundMap}
              readOnly={isReadOnly}
              editOverride={isComparisonUser}
              teamPageCompetitionId={competitionId}
              teamPageUserId={viewUserId}
              onFocusedKeyChange={setFocusedPredKey}
            />
            {hasPendingTies && !isReadOnly && (
              <div className="absolute inset-0 bg-background/70 rounded-xl flex items-center justify-center backdrop-blur-[2px]">
                <p className="text-sm font-medium text-muted-foreground text-center px-6">
                  {t('knockoutContent.tiebreakerBlur')}
                </p>
              </div>
            )}
          </div>

          <div className="mt-6">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              {t('knockoutContent.bracketOverview')}
            </p>
            <KnockoutBracketVisualizer
              knockoutConfig={knockoutConfig}
              actualMatchMap={knockoutMatchMap}
              focusedPredKey={focusedPredKey}
            />
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('knockoutContent.bracketNotConfigured')}
        </p>
      )}
    </>
  );
}
