import { useState, useRef, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
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

function sortTeams(teams: TeamStat[]): TeamStat[] {
  return [...teams].sort((a, b) => {
    const pa = a.W * 3 + a.D, pb = b.W * 3 + b.D;
    if (pb !== pa) return pb - pa;
    const gda = a.GF - a.GA, gdb = b.GF - b.GA;
    if (gdb !== gda) return gdb - gda;
    return b.GF - a.GF;
  });
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
}: {
  matchKey: string;
  homeTeam: TeamStat | null;
  awayTeam: TeamStat | null;
  prediction: BracketMatchPrediction | undefined;
  onUpdate: (key: string, pred: BracketMatchPrediction) => void;
}) {
  const [homeStr, setHomeStr] = useState('');
  const [awayStr, setAwayStr] = useState('');
  const [synced, setSynced] = useState(false);

  // Sync from loaded prediction once per mount
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
      {/* Home row */}
      <div className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${homeWins ? 'bg-primary/5' : ''}`}>
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

      {/* Away row */}
      <div className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${awayWins ? 'bg-primary/5' : ''}`}>
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

      {/* Draw progressing picker */}
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

  // Compute teams for every bracket position (same logic as before, moved here)
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

  // Flat chronological match list
  const allMatches = useMemo<FlatMatch[]>(() => {
    const list: FlatMatch[] = [];
    chronoRounds.forEach((round, chronoR) => {
      const bracketR = maxRoundIdx - chronoR;
      const count = Math.pow(2, bracketR);
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
    if (hasBronzeFinal) {
      list.push({
        round: 'semi_final' as KnockoutFirstRound,
        matchIdxInRound: 0,
        matchCountInRound: 1,
        predKey: 'bronze_final_0',
        bracketKey: '',
        isBronze: true,
      });
    }
    return list;
  }, [chronoRounds, maxRoundIdx, hasBronzeFinal]);

  // Navigation state
  const [currentIdx, setCurrentIdx] = useState(0);
  const [slideDir, setSlideDir] = useState<'fromRight' | 'fromLeft'>('fromRight');
  const [animKey, setAnimKey] = useState(0);
  const initedRef = useRef(false);
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Jump to first incomplete match once predictions are loaded
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

    // Check if all matches in the current round are now complete
    const newPreds = { ...bracketPreds, [key]: pred };
    const roundMatches = allMatches.filter(m => m.round === current.round && !m.isBronze);
    const roundAllDone = roundMatches.every(m =>
      isPredComplete(newPreds[m.predKey], matchTeams[m.bracketKey])
    );

    if (roundAllDone) {
      // Auto-advance to first match of the next round
      const nextRoundFirstIdx = allMatches.findIndex(
        (m, idx) => idx > currentIdx && m.round !== current.round && !m.isBronze
      );
      if (nextRoundFirstIdx !== -1) {
        if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
        autoAdvanceTimer.current = setTimeout(() => goTo(nextRoundFirstIdx), 600);
      }
    }
  }

  const current = allMatches[currentIdx];
  if (!current) return null;

  const currentTeams = current.isBronze
    ? { home: null, away: null }
    : (matchTeams[current.bracketKey] ?? { home: null, away: null });
  const currentPred = bracketPreds[current.predKey];
  const isComplete = isPredComplete(currentPred, currentTeams);
  const teamsAreTbd = !currentTeams.home || !currentTeams.away;
  const showNextArrow = currentIdx < allMatches.length - 1 && (isComplete || teamsAreTbd);
  const canGoPrev = currentIdx > 0;

  // Matches in the current round for progress dots
  const roundMatchesForDots = current.isBronze
    ? []
    : allMatches.filter(m => m.round === current.round && !m.isBronze);

  const currentRoundLabel = current.isBronze ? 'Bronze Final' : ROUND_LABELS[current.round];

  return (
    <div className="space-y-5">
      {/* Round tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {chronoRounds.map(round => {
          const isActive = current.round === round && !current.isBronze;
          const roundMs = allMatches.filter(m => m.round === round && !m.isBronze);
          const doneCount = roundMs.filter(m =>
            isPredComplete(bracketPreds[m.predKey], matchTeams[m.bracketKey])
          ).length;
          const allDone = doneCount === roundMs.length && roundMs.length > 0;
          const firstIdx = allMatches.findIndex(m => m.round === round && !m.isBronze);
          return (
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
        })}
        {hasBronzeFinal && (
          <button
            type="button"
            onClick={() => {
              const bronzeIdx = allMatches.findIndex(m => m.isBronze);
              if (bronzeIdx !== -1) goTo(bronzeIdx);
            }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              current.isBronze
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            Bronze Final
          </button>
        )}
      </div>

      {/* Match navigation area */}
      <div className="rounded-xl border bg-muted/20 p-5">
        {/* Round + match header */}
        <div className="text-center mb-4">
          <h2 className="text-base font-semibold">{currentRoundLabel}</h2>
          {!current.isBronze && roundMatchesForDots.length > 1 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Match {current.matchIdxInRound + 1} of {current.matchCountInRound}
            </p>
          )}
        </div>

        {/* Progress dots */}
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

        {/* Card + arrows row */}
        <div className="flex items-center gap-2">
          {/* Left arrow — always rendered, fades when unavailable */}
          <button
            type="button"
            onClick={() => canGoPrev && goTo(currentIdx - 1)}
            disabled={!canGoPrev}
            className="flex-shrink-0 h-10 w-10 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
            aria-label="Previous match"
          >
            ←
          </button>

          {/* Animated match card */}
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
            />
          </div>

          {/* Right arrow — appears only when match is complete or TBD */}
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function KnockoutStagePredictionsPage() {
  const { id } = useParams<{ id: string }>();

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

  const [localPreds, setLocalPreds] = useState<BracketPredictions>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [initialized, setInitialized] = useState(false);
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

  const groupStandings = useMemo(() => {
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
    }

    const byGroup = new Map<string, TeamStat[]>();
    for (const t of teamMap.values()) {
      if (!byGroup.has(t.group)) byGroup.set(t.group, []);
      byGroup.get(t.group)!.push(t);
    }
    for (const teams of byGroup.values()) {
      teams.sort((a, b) => {
        const pa = a.W * 3 + a.D, pb = b.W * 3 + b.D;
        if (pb !== pa) return pb - pa;
        const gda = a.GF - a.GA, gdb = b.GF - b.GA;
        if (gdb !== gda) return gdb - gda;
        return b.GF - a.GF;
      });
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [matchList, predMap]);

  const knockoutConfig = tournament?.knockoutConfig ?? null;

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
    );
  }, [knockoutConfig, luckyLoserLabels, groupStandings]);

  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    const msg = error instanceof ApiError ? error.message : 'Failed to load';
    return <p className="p-8 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <style>{`
        @keyframes ko_slide_fromRight {
          from { opacity: 0; transform: translateX(36px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes ko_slide_fromLeft {
          from { opacity: 0; transform: translateX(-36px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      <div className="mb-2 text-sm text-muted-foreground">
        <Link to={`/competitions/${id}`} className="hover:underline">
          ← Group Stage
        </Link>
      </div>

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold">Knockout Stage</h1>
        <span className={`text-xs ${
          saveStatus === 'saving' ? 'text-muted-foreground' :
          saveStatus === 'saved' ? 'text-green-600' :
          saveStatus === 'error' ? 'text-destructive' : 'invisible'
        }`}>
          {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Save failed' : '.'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-8">
        Teams shown are based on your group stage predictions. Enter scores for each match — a draw
        prompts you to pick who advances.
      </p>

      {knockoutConfig ? (
        <FocusedBracketView
          knockoutConfig={knockoutConfig}
          resolvedSlots={resolvedSlots}
          bracketPreds={localPreds}
          onUpdate={updatePrediction}
          predsLoaded={initialized}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          The knockout bracket hasn't been configured yet.
        </p>
      )}
    </main>
  );
}
