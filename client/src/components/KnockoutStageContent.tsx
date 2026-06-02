import { useState, useRef, useEffect, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type {
  Competition,
  Tournament,
  Prediction,
  MatchStage,
  KnockoutFirstRound,
  KnockoutConfig,
  BracketMatchPrediction,
  BracketPredictions,
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
}: {
  matchKey: string;
  homeTeam: TeamStat | null;
  awayTeam: TeamStat | null;
  prediction: BracketMatchPrediction | undefined;
  onUpdate: (key: string, pred: BracketMatchPrediction) => void;
  isFinal?: boolean;
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

  return (
    <div className="rounded-xl border-2 bg-card shadow-sm overflow-hidden w-full max-w-xs mx-auto">
      <div
        className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${homeWins && !isHomeChampion ? 'bg-primary/5' : ''}`}
        style={isHomeChampion ? { animation: 'ko_winner_glow 1.8s ease-in-out infinite' } : undefined}
      >
        {homeTeam ? (
          <>
            {homeTeam.imageUrl ? (
              <img src={homeTeam.imageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
            ) : (
              <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
            )}
            <span className={`flex-1 text-sm truncate ${homeWins ? 'font-semibold' : 'font-medium'}`}>
              {homeTeam.teamName}
            </span>
            {isHomeChampion && (
              <span style={{ animation: 'ko_trophy_pop 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
                🏆
              </span>
            )}
          </>
        ) : (
          <span className="flex-1 text-sm text-muted-foreground italic">TBD</span>
        )}
        <input
          type="text"
          inputMode="numeric"
          value={homeStr}
          onChange={e => handleScoreChange('home', e.target.value)}
          disabled={disabled}
          className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
          placeholder="–"
        />
      </div>

      <div className="h-px bg-border" />

      <div
        className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${awayWins && !isAwayChampion ? 'bg-primary/5' : ''}`}
        style={isAwayChampion ? { animation: 'ko_winner_glow 1.8s ease-in-out infinite' } : undefined}
      >
        {awayTeam ? (
          <>
            {awayTeam.imageUrl ? (
              <img src={awayTeam.imageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
            ) : (
              <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
            )}
            <span className={`flex-1 text-sm truncate ${awayWins ? 'font-semibold' : 'font-medium'}`}>
              {awayTeam.teamName}
            </span>
            {isAwayChampion && (
              <span style={{ animation: 'ko_trophy_pop 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
                🏆
              </span>
            )}
          </>
        ) : (
          <span className="flex-1 text-sm text-muted-foreground italic">TBD</span>
        )}
        <input
          type="text"
          inputMode="numeric"
          value={awayStr}
          onChange={e => handleScoreChange('away', e.target.value)}
          disabled={disabled}
          className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
          placeholder="–"
        />
      </div>

      {isDraw && homeTeam && awayTeam && (
        <>
          <div className="h-px bg-border" />
          <div className="p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground text-center font-medium">
              Who advances after extra time / penalties?
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
                {homeTeam.teamName}
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
                {awayTeam.teamName}
              </button>
            </div>
          </div>
        </>
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
}: {
  knockoutConfig: KnockoutConfig;
  resolvedSlots: Record<string, TeamStat | null>;
  bracketPreds: BracketPredictions;
  onUpdate: (key: string, pred: BracketMatchPrediction) => void;
  predsLoaded: boolean;
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

  const [currentIdx, setCurrentIdx] = useState(0);
  const [slideDir, setSlideDir] = useState<'fromRight' | 'fromLeft'>('fromRight');
  const [animKey, setAnimKey] = useState(0);
  const initedRef = useRef(false);
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initedRef.current || !predsLoaded) return;
    initedRef.current = true;
    const firstIncomplete = allMatches.findIndex(m => {
      if (m.isBronze) return false;
      const teams = matchTeams[m.bracketKey];
      if (!teams?.home || !teams?.away) return false;
      return !isPredComplete(bracketPreds[m.predKey], teams);
    });
    if (firstIncomplete > 0) {
      setCurrentIdx(firstIncomplete);
    }
  }, [predsLoaded, allMatches, matchTeams, bracketPreds]);

  function goTo(idx: number) {
    const dir = idx > currentIdx ? 'fromRight' : 'fromLeft';
    setSlideDir(dir);
    setAnimKey(k => k + 1);
    setCurrentIdx(idx);
  }

  function handleUpdate(key: string, pred: BracketMatchPrediction) {
    onUpdate(key, pred);

    const current = allMatches[currentIdx];
    if (!current || current.isBronze) return;

    const updatedTeams = matchTeams[current.bracketKey];
    if (!isPredComplete(pred, updatedTeams)) return;

    const newPreds = { ...bracketPreds, [key]: pred };
    const roundMatches = allMatches.filter(m => m.round === current.round && !m.isBronze);
    const roundAllDone = roundMatches.every(m =>
      isPredComplete(newPreds[m.predKey], matchTeams[m.bracketKey])
    );

    if (roundAllDone) {
      // After semi-finals, go to bronze final first (if present), then the regular final
      const bronzeIdx = current.round === 'semi_final'
        ? allMatches.findIndex(m => m.isBronze)
        : -1;
      const nextIdx = bronzeIdx !== -1
        ? bronzeIdx
        : allMatches.findIndex((m, idx) => idx > currentIdx && m.round !== current.round && !m.isBronze);
      if (nextIdx !== -1) {
        if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
        autoAdvanceTimer.current = setTimeout(() => goTo(nextIdx), 600);
      }
    }
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

  const currentRoundLabel = current.isBronze ? 'Bronze Final' : ROUND_LABELS[current.round];

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
              {ROUND_LABELS[round]}
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
                Bronze Final
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
              Match {current.matchIdxInRound + 1} of {current.matchCountInRound}
            </p>
          )}
        </div>

        {roundMatchesForDots.length > 1 && (
          <div className="flex justify-center gap-1.5 mb-5">
            {roundMatchesForDots.map(m => {
              const flatIdx = allMatches.indexOf(m);
              const isCurrent = flatIdx === currentIdx;
              const isDone = isPredComplete(bracketPreds[m.predKey], matchTeams[m.bracketKey]);
              return (
                <button
                  key={m.predKey}
                  type="button"
                  onClick={() => goTo(flatIdx)}
                  className={`rounded-full transition-all duration-200 ${
                    isCurrent
                      ? 'w-5 h-2.5 bg-primary'
                      : isDone
                      ? 'w-2.5 h-2.5 bg-green-500'
                      : 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                  }`}
                  aria-label={`Match ${m.matchIdxInRound + 1}`}
                />
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => canGoPrev && goTo(currentIdx - 1)}
            disabled={!canGoPrev}
            className="flex-shrink-0 h-10 w-10 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
            aria-label="Previous match"
          >
            ←
          </button>

          <div
            key={animKey}
            className="flex-1"
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
            />
          </div>

          <button
            type="button"
            onClick={() => showNextArrow && goTo(currentIdx + 1)}
            disabled={!showNextArrow}
            className={`flex-shrink-0 h-10 w-10 rounded-full border flex items-center justify-center transition-all duration-200 ${
              showNextArrow
                ? 'border-primary text-primary hover:bg-primary/10 shadow-sm'
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

// ── Main exported component ───────────────────────────────────────────────────

export default function KnockoutStageContent({
  competitionId,
  onAllComplete,
}: {
  competitionId: string;
  onAllComplete?: () => void;
}) {
  const id = competitionId;

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
    queryKey: ['competitions', id, 'predictions'],
    queryFn: () => api.get<Prediction[]>(`/competitions/${id}/predictions`),
    enabled: !!competition,
  });

  const { data: savedBracketPreds } = useQuery({
    queryKey: ['competitions', id, 'bracket-predictions'],
    queryFn: () => api.get<BracketPredictions>(`/competitions/${id}/bracket-predictions`),
    enabled: !!competition,
  });

  const { data: savedTiebreakerChoices } = useQuery({
    queryKey: ['competitions', id, 'tiebreak-choices'],
    queryFn: () => api.get<{ groupChoices: DisciplinaryChoices; luckyLoserChoices: DisciplinaryChoices }>(`/competitions/${id}/tiebreak-choices`),
    enabled: !!competition,
  });

  const [localPreds, setLocalPreds] = useState<BracketPredictions>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [initialized, setInitialized] = useState(false);
  const [tiebreakerInitialized, setTiebreakerInitialized] = useState(false);
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
    if (savedTiebreakerChoices && !tiebreakerInitialized) {
      if (savedTiebreakerChoices.groupChoices) setGroupDisciplinaryChoices(savedTiebreakerChoices.groupChoices);
      if (savedTiebreakerChoices.luckyLoserChoices) setLuckyLoserDisciplinaryChoices(savedTiebreakerChoices.luckyLoserChoices);
      setTiebreakerInitialized(true);
    }
  }, [savedTiebreakerChoices, tiebreakerInitialized]);

  const saveTiebreakerChoicesMutation = useMutation({
    mutationFn: (body: { groupChoices?: DisciplinaryChoices; luckyLoserChoices?: DisciplinaryChoices }) =>
      api.post(`/competitions/${id}/tiebreak-choices`, body),
  });

  const saveMutation = useMutation({
    mutationFn: (predictions: BracketPredictions) =>
      api.post(`/competitions/${id}/bracket-predictions`, { predictions }),
    onSuccess: () => setSaveStatus('saved'),
    onError: () => setSaveStatus('error'),
  });

  function updatePrediction(key: string, pred: BracketMatchPrediction) {
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

  const { groupStandings, effectiveGroupResults } = useMemo(() => {
    const groupMatches = matchList.filter(m => m.stage === 'group');
    const teamMap = new Map<string, TeamStat>();

    for (const m of groupMatches) {
      const g = m.groupName;
      if (!g) continue;
      if (m.homeTeamId && m.homeTeamName && !teamMap.has(m.homeTeamId)) {
        teamMap.set(m.homeTeamId, { teamId: m.homeTeamId, teamName: m.homeTeamName, imageUrl: m.homeTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
      }
      if (m.awayTeamId && m.awayTeamName && !teamMap.has(m.awayTeamId)) {
        teamMap.set(m.awayTeamId, { teamId: m.awayTeamId, teamName: m.awayTeamName, imageUrl: m.awayTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
      }
    }

    const groupResultsMap = new Map<string, MatchResult[]>();

    for (const m of groupMatches) {
      if (!m.homeTeamId || !m.awayTeamId || !m.groupName) continue;
      let hs: number | null = null, as_: number | null = null;
      if (m.status === 'completed') {
        hs = m.homeScore; as_ = m.awayScore;
      } else {
        const pred = predMap[m.id];
        if (pred) { hs = pred.homeScore; as_ = pred.awayScore; }
      }
      if (hs === null || as_ === null) continue;
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
      const tiebreakerStats = teams.map(t => ({ teamId: t.teamId, points: t.W * 3 + t.D, gd: t.GF - t.GA, gf: t.GF }));
      const sortedIds = sortGroupTeams(tiebreakerStats, results, groupDisciplinaryChoices).map(s => s.teamId);
      teams.sort((a, b) => sortedIds.indexOf(a.teamId) - sortedIds.indexOf(b.teamId));
    }

    return {
      groupStandings: [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)),
      effectiveGroupResults: groupResultsMap,
    };
  }, [matchList, predMap, groupDisciplinaryChoices]);

  const knockoutConfig = tournament?.knockoutConfig ?? null;

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
    const groupNames = groupStandings.map(([name]) => name);
    return computeLuckyLoserLabels(
      FIRST_ROUND_COUNTS[knockoutConfig.firstRound],
      knockoutConfig.bracketSlots,
      groupNames,
      knockoutConfig.directQualifiers,
    );
  }, [knockoutConfig, groupStandings]);

  const resolvedSlots = useMemo(() => {
    if (!knockoutConfig) return {};
    return resolveSlots(
      knockoutConfig.bracketSlots,
      luckyLoserLabels,
      groupStandings,
      knockoutConfig.directQualifiers,
      FIRST_ROUND_COUNTS[knockoutConfig.firstRound],
      luckyLoserDisciplinaryChoices,
    );
  }, [knockoutConfig, luckyLoserLabels, groupStandings, luckyLoserDisciplinaryChoices]);

  const groupDisciplinaryTies = useMemo(() => {
    const directQualifiers = knockoutConfig?.directQualifiers ?? 2;
    const result: Array<{ groupName: string; teams: TeamStat[]; key: string; requiredRankings: number }> = [];
    for (const [groupName, teams] of groupStandings) {
      const results = effectiveGroupResults.get(groupName) ?? [];
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
  }, [groupStandings, effectiveGroupResults, groupDisciplinaryChoices, knockoutConfig]);

  const luckyLoserDisciplinaryTies = useMemo(() => {
    if (!knockoutConfig) return [];
    const third = groupStandings
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
  }, [groupStandings, knockoutConfig, luckyLoserDisciplinaryChoices]);

  function handleDisciplinaryChoice(
    choices: DisciplinaryChoices,
    setChoices: (c: DisciplinaryChoices) => void,
    key: string,
    teamId: string,
  ) {
    const ranking = [...(choices[key] ?? [])];
    const idx = ranking.indexOf(teamId);
    if (idx !== -1) ranking.splice(idx, 1);
    else ranking.push(teamId);
    setChoices({ ...choices, [key]: ranking });
  }

  function confirmGroupTiebreaker(key: string, allTeamIds: string[]) {
    const ranked = groupDisciplinaryChoices[key] ?? [];
    const remaining = allTeamIds.filter(id => !ranked.includes(id)).sort();
    const next = { ...groupDisciplinaryChoices, [key]: [...ranked, ...remaining] };
    setGroupDisciplinaryChoices(next);
    saveTiebreakerChoicesMutation.mutate({ groupChoices: next });
  }

  function confirmLuckyLoserTiebreaker(key: string, allTeamIds: string[]) {
    const ranked = luckyLoserDisciplinaryChoices[key] ?? [];
    const remaining = allTeamIds.filter(id => !ranked.includes(id)).sort();
    const next = { ...luckyLoserDisciplinaryChoices, [key]: [...ranked, ...remaining] };
    setLuckyLoserDisciplinaryChoices(next);
    saveTiebreakerChoicesMutation.mutate({ luckyLoserChoices: next });
  }

  if (isLoading) return <p className="py-4 text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    const msg = error instanceof ApiError ? error.message : 'Failed to load';
    return <p className="py-4 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

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

      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-muted-foreground">
          Teams shown are based on your group stage predictions. Enter scores for each match — a draw
          prompts you to pick who advances.
        </p>
        <span className={`text-xs flex-shrink-0 ml-4 ${
          saveStatus === 'saving' ? 'text-muted-foreground' :
          saveStatus === 'saved' ? 'text-green-600' :
          saveStatus === 'error' ? 'text-destructive' : 'invisible'
        }`}>
          {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Save failed' : '.'}
        </span>
      </div>

      {hasPendingTies && (
        <div className="mb-6 space-y-3">
          {groupDisciplinaryTies.map(tie => {
            const ranked = groupDisciplinaryChoices[tie.key] ?? [];
            const enoughRanked = ranked.length >= tie.requiredRankings;
            return (
              <div key={tie.key} className="rounded-lg border border-amber-400/40 bg-amber-50/10 p-3 text-xs">
                <p className="font-semibold text-amber-700 dark:text-amber-400 mb-1">
                  Disciplinary tiebreaker — Group {tie.groupName}
                </p>
                <p className="text-muted-foreground mb-2">
                  {enoughRanked
                    ? `Selected: ${ranked.slice(0, tie.requiredRankings).map(id => tie.teams.find(t => t.teamId === id)?.teamName).join(' › ')}`
                    : `Select ${tie.requiredRankings} team${tie.requiredRankings > 1 ? 's' : ''} with the best fair play record (fewest cards), in order:`}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {tie.teams.map(t => {
                    const rank = ranked.indexOf(t.teamId);
                    const isRanked = rank !== -1;
                    const isLocked = !isRanked && enoughRanked;
                    return (
                      <button
                        key={t.teamId}
                        onClick={() => !isLocked && handleDisciplinaryChoice(groupDisciplinaryChoices, setGroupDisciplinaryChoices, tie.key, t.teamId)}
                        disabled={isLocked}
                        className={`flex items-center gap-1 rounded border px-2 py-1 transition-colors ${
                          isRanked
                            ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300'
                            : isLocked
                            ? 'border-border opacity-30 cursor-not-allowed'
                            : 'border-border hover:border-amber-400 hover:bg-amber-50/20'
                        }`}
                      >
                        {isRanked && <span className="font-bold text-amber-600 dark:text-amber-400">{rank + 1}.</span>}
                        {t.imageUrl && <img src={t.imageUrl} alt="" className="h-3.5 w-3.5 rounded-sm" />}
                        {t.teamName}
                      </button>
                    );
                  })}
                  {enoughRanked && (
                    <button
                      onClick={() => confirmGroupTiebreaker(tie.key, tie.teams.map(t => t.teamId))}
                      className="rounded border border-green-500/50 bg-green-50/20 px-2 py-1 font-medium text-green-700 dark:text-green-400 hover:bg-green-50/40 transition-colors"
                    >
                      Confirm ✓
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {luckyLoserDisciplinaryTies.map(tie => {
            const ranked = luckyLoserDisciplinaryChoices[tie.key] ?? [];
            const requiredRankings = Math.max(1, tie.teams.length - 1);
            const enoughRanked = ranked.length >= requiredRankings;
            return (
              <div key={tie.key} className="rounded-lg border border-amber-400/40 bg-amber-50/10 p-3 text-xs">
                <p className="font-semibold text-amber-700 dark:text-amber-400 mb-1">
                  Disciplinary tiebreaker — Lucky Losers
                </p>
                <p className="text-muted-foreground mb-2">
                  {enoughRanked
                    ? `Selected: ${ranked.slice(0, requiredRankings).map(id => tie.teams.find(t => t.teamId === id)?.teamName).join(' › ')}`
                    : `Select ${requiredRankings} team${requiredRankings > 1 ? 's' : ''} with the best fair play record (fewest cards), in order:`}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {tie.teams.map(t => {
                    const rank = ranked.indexOf(t.teamId);
                    const isRanked = rank !== -1;
                    const isLocked = !isRanked && enoughRanked;
                    return (
                      <button
                        key={t.teamId}
                        onClick={() => !isLocked && handleDisciplinaryChoice(luckyLoserDisciplinaryChoices, setLuckyLoserDisciplinaryChoices, tie.key, t.teamId)}
                        disabled={isLocked}
                        className={`flex items-center gap-1 rounded border px-2 py-1 transition-colors ${
                          isRanked
                            ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300'
                            : isLocked
                            ? 'border-border opacity-30 cursor-not-allowed'
                            : 'border-border hover:border-amber-400 hover:bg-amber-50/20'
                        }`}
                      >
                        {isRanked && <span className="font-bold text-amber-600 dark:text-amber-400">{rank + 1}.</span>}
                        {t.imageUrl && <img src={t.imageUrl} alt="" className="h-3.5 w-3.5 rounded-sm" />}
                        {t.teamName}
                      </button>
                    );
                  })}
                  {enoughRanked && (
                    <button
                      onClick={() => confirmLuckyLoserTiebreaker(tie.key, tie.teams.map(t => t.teamId))}
                      className="rounded border border-green-500/50 bg-green-50/20 px-2 py-1 font-medium text-green-700 dark:text-green-400 hover:bg-green-50/40 transition-colors"
                    >
                      Confirm ✓
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {knockoutConfig ? (
        <div className={hasPendingTies ? 'relative' : ''}>
          <FocusedBracketView
            knockoutConfig={knockoutConfig}
            resolvedSlots={resolvedSlots}
            bracketPreds={localPreds}
            onUpdate={updatePrediction}
            predsLoaded={initialized}
          />
          {hasPendingTies && (
            <div className="absolute inset-0 bg-background/70 rounded-xl flex items-center justify-center backdrop-blur-[2px]">
              <p className="text-sm font-medium text-muted-foreground text-center px-6">
                Resolve the tiebreakers above before filling in knockout predictions.
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          The knockout bracket hasn't been configured yet.
        </p>
      )}
    </>
  );
}
