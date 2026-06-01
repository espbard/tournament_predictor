import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import type { Tournament, Group, KnockoutConfig, KnockoutFirstRound, Match } from '@tournament-predictor/shared';

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

const TIE_LABELS: Record<KnockoutFirstRound, string> = {
  round_of_32: 'R32',
  round_of_16: 'R16',
  quarter_final: 'QF',
  semi_final: 'SF',
  final: 'F',
};

const FIRST_ROUND_COUNTS: Record<KnockoutFirstRound, number> = {
  round_of_32: 16,
  round_of_16: 8,
  quarter_final: 4,
  semi_final: 2,
  final: 1,
};


const MATCH_W = 152;
const MATCH_H = 60;
const MATCH_GAP = 16;
const ROW_GAP = 48;
const UNIT = MATCH_W + MATCH_GAP;
const LABEL_COL_W = 92;

const DEFAULT_CONFIG: KnockoutConfig = {
  firstRound: 'round_of_16',
  hasBronzeFinal: false,
  directQualifiers: 2,
  luckyLosers: 0,
  bracketSlots: {},
};

// ── Types ─────────────────────────────────────────────────────────────────────

type MatchWithTeams = Match & {
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamImageUrl?: string | null;
  awayTeamImageUrl?: string | null;
};

// ── Lucky loser labels ────────────────────────────────────────────────────────

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

function computeLuckyLoserLabels(
  firstRoundMatchCount: number,
  bracketSlots: Record<string, string>,
  groups: Group[],
  directQualifiers: number,
): Record<string, string> {
  const existingGroups = new Set(groups.map(g => g.name));
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

// ── Config bracket sub-components ─────────────────────────────────────────────

function BracketSlot({
  slotId, label, luckyLoserLabel, onClear,
}: {
  slotId: string; label: string | null; luckyLoserLabel?: string; onClear: () => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `slot_${slotId}` });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-1 px-2 transition-colors ${isOver ? 'bg-primary/10' : ''}`}
      style={{ height: (MATCH_H - 1) / 2 }}
    >
      {label ? (
        <>
          <span className="text-xs font-mono font-semibold flex-1 truncate">{label}</span>
          <button type="button" onClick={onClear} className="flex-shrink-0 text-muted-foreground hover:text-foreground text-xs leading-none px-0.5">×</button>
        </>
      ) : isOver ? (
        <span className="text-xs text-muted-foreground">↓ drop</span>
      ) : luckyLoserLabel ? (
        <span className="text-xs font-mono text-muted-foreground/60 italic flex-1 truncate">{luckyLoserLabel}</span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}

function TbdSlot({ label }: { label?: string }) {
  return (
    <div className="flex items-center px-2 text-xs text-muted-foreground italic truncate" style={{ height: (MATCH_H - 1) / 2 }}>
      {label ?? 'TBD'}
    </div>
  );
}

function DraggableQualifier({ label, isUsed }: { label: string; isUsed: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: label });
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`cursor-grab active:cursor-grabbing touch-none select-none rounded border px-2.5 py-1 text-xs font-mono font-semibold transition-opacity ${isDragging ? 'opacity-30' : ''} ${isUsed ? 'border-primary/40 bg-primary/10 text-primary' : 'bg-card hover:bg-muted'}`}
    >
      {label}
    </div>
  );
}

function BracketVisualization({
  firstRound, hasBronzeFinal, bracketSlots, onClearSlot, luckyLoserLabels,
}: {
  firstRound: KnockoutFirstRound;
  hasBronzeFinal: boolean;
  bracketSlots: Record<string, string>;
  onClearSlot: (slotId: string) => void;
  luckyLoserLabels: Record<string, string>;
}) {
  const startIdx = ROUND_ORDER.indexOf(firstRound);
  const rounds = [...ROUND_ORDER.slice(startIdx)].reverse();
  const maxRoundIdx = rounds.length - 1;
  const firstRoundMatchCount = FIRST_ROUND_COUNTS[firstRound];
  const totalWidth = firstRoundMatchCount * UNIT - MATCH_GAP;

  const centersMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (let i = 0; i < firstRoundMatchCount; i++) map[`${maxRoundIdx}_${i}`] = i * UNIT + MATCH_W / 2;
    for (let R = maxRoundIdx - 1; R >= 0; R--) {
      const num = Math.pow(2, R);
      for (let i = 0; i < num; i++) map[`${R}_${i}`] = (map[`${R + 1}_${2 * i}`] + map[`${R + 1}_${2 * i + 1}`]) / 2;
    }
    return map;
  }, [firstRoundMatchCount, maxRoundIdx]);

  const getRowY = (R: number) => R * (MATCH_H + ROW_GAP);
  const mainBracketH = getRowY(maxRoundIdx) + MATCH_H;
  const totalH = mainBracketH + (hasBronzeFinal ? ROW_GAP + MATCH_H : 0);

  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <div className="flex gap-3">
        <div className="flex-shrink-0" style={{ width: LABEL_COL_W }}>
          {rounds.map((round, R) => (
            <div key={round} style={{ height: MATCH_H, marginBottom: R < maxRoundIdx ? ROW_GAP : 0 }} className="flex items-center justify-end">
              <span className="text-xs font-medium text-muted-foreground text-right leading-tight">{ROUND_LABELS[round]}</span>
            </div>
          ))}
          {hasBronzeFinal && (
            <div style={{ height: MATCH_H, marginTop: ROW_GAP }} className="flex items-center justify-end">
              <span className="text-xs font-medium text-muted-foreground text-right leading-tight">Bronze Final</span>
            </div>
          )}
        </div>
        <div className="overflow-x-auto flex-1">
          <div className="relative" style={{ width: totalWidth, height: totalH }}>
            <svg style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }} width={totalWidth} height={mainBracketH}>
              {rounds.slice(0, -1).flatMap((_, R) => {
                const numMatches = Math.pow(2, R);
                return Array.from({ length: numMatches }).map((_, i) => {
                  const pCX = centersMap[`${R}_${i}`];
                  const lCX = centersMap[`${R + 1}_${2 * i}`];
                  const rCX = centersMap[`${R + 1}_${2 * i + 1}`];
                  const pBotY = getRowY(R) + MATCH_H;
                  const cTopY = getRowY(R + 1);
                  const yMid = (pBotY + cTopY) / 2;
                  const d = [`M ${pCX} ${pBotY} L ${pCX} ${yMid}`, `M ${lCX} ${yMid} L ${rCX} ${yMid}`, `M ${lCX} ${yMid} L ${lCX} ${cTopY}`, `M ${rCX} ${yMid} L ${rCX} ${cTopY}`].join(' ');
                  return <path key={`c_${R}_${i}`} d={d} fill="none" stroke="hsl(var(--border))" strokeWidth="1" />;
                });
              })}
            </svg>
            {rounds.flatMap((_, R) => {
              const numMatches = Math.pow(2, R);
              const rowY = getRowY(R);
              const isFirstRound = R === maxRoundIdx;
              return Array.from({ length: numMatches }).map((_, i) => {
                const cardLeft = centersMap[`${R}_${i}`] - MATCH_W / 2;
                const homeSlotId = `m${i + 1}_home`;
                const awaySlotId = `m${i + 1}_away`;
                return (
                  <div key={`${R}_${i}`} style={{ position: 'absolute', left: cardLeft, top: rowY, width: MATCH_W, height: MATCH_H }}>
                    <div className="h-full rounded border bg-card overflow-hidden flex flex-col">
                      {isFirstRound ? (
                        <>
                          <BracketSlot slotId={homeSlotId} label={bracketSlots[homeSlotId] ?? null} luckyLoserLabel={bracketSlots[homeSlotId] ? undefined : luckyLoserLabels[homeSlotId]} onClear={() => onClearSlot(homeSlotId)} />
                          <div className="border-t" />
                          <BracketSlot slotId={awaySlotId} label={bracketSlots[awaySlotId] ?? null} luckyLoserLabel={bracketSlots[awaySlotId] ? undefined : luckyLoserLabels[awaySlotId]} onClear={() => onClearSlot(awaySlotId)} />
                        </>
                      ) : (
                        <>
                          <TbdSlot label={`W. ${TIE_LABELS[rounds[R + 1]]} ${2 * i + 1}`} />
                          <div className="border-t" />
                          <TbdSlot label={`W. ${TIE_LABELS[rounds[R + 1]]} ${2 * i + 2}`} />
                        </>
                      )}
                    </div>
                  </div>
                );
              });
            })}
            {hasBronzeFinal && (
              <div style={{ position: 'absolute', left: totalWidth / 2 - MATCH_W / 2, top: mainBracketH + ROW_GAP, width: MATCH_W, height: MATCH_H }}>
                <div className="h-full rounded border border-dashed bg-card overflow-hidden flex flex-col">
                  <TbdSlot /><div className="border-t border-dashed" /><TbdSlot />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Admin focused results ──────────────────────────────────────────────────────

interface FlatAdminMatch {
  stage: string;
  match: MatchWithTeams | null;
  isBronze: boolean;
  matchIdxInRound: number;
  matchCountInRound: number;
}

function FocusedAdminMatchCard({
  match,
  onSave,
  isSaving,
}: {
  match: MatchWithTeams | null;
  onSave: (home: number, away: number, progressingTeamId: string | null) => void;
  isSaving: boolean;
}) {
  const [homeStr, setHomeStr] = useState('');
  const [awayStr, setAwayStr] = useState('');
  const [selectedWinnerId, setSelectedWinnerId] = useState<string | null>(null);
  const prevMatchIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (match?.id !== prevMatchIdRef.current) {
      prevMatchIdRef.current = match?.id ?? null;
      setHomeStr(match?.homeScore != null ? String(match.homeScore) : '');
      setAwayStr(match?.awayScore != null ? String(match.awayScore) : '');
      setSelectedWinnerId(null);
    }
  }, [match?.id]);

  useEffect(() => {
    setHomeStr(match?.homeScore != null ? String(match.homeScore) : '');
    setAwayStr(match?.awayScore != null ? String(match.awayScore) : '');
  }, [match?.homeScore, match?.awayScore]);

  const homeNum = homeStr === '' ? null : parseInt(homeStr, 10);
  const awayNum = awayStr === '' ? null : parseInt(awayStr, 10);
  const bothValid = homeNum !== null && awayNum !== null && !isNaN(homeNum) && !isNaN(awayNum) && homeNum >= 0 && awayNum >= 0;
  const isDrawEntry = bothValid && homeNum === awayNum;
  const hasTeams = !!(match?.homeTeamId && match?.awayTeamId);
  const isCompleted = match?.status === 'completed';
  const homeWins = isCompleted && match!.homeScore! > match!.awayScore!;
  const awayWins = isCompleted && match!.awayScore! > match!.homeScore!;

  // Show tiebreaker while entering equal scores, or for a completed draw without a resolved winner
  const showTiebreaker = hasTeams && (
    isDrawEntry ||
    (isCompleted && match!.homeScore === match!.awayScore && !match!.progressingTeamId)
  );

  function handleSave() {
    if (!bothValid) return;
    onSave(homeNum!, awayNum!, isDrawEntry ? (selectedWinnerId ?? null) : null);
  }

  if (!match) {
    return (
      <div className="rounded-xl border-2 bg-card/50 shadow-sm p-8 w-full max-w-xs mx-auto text-center text-sm text-muted-foreground italic">
        TBD
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 bg-card shadow-sm overflow-hidden w-full max-w-xs mx-auto">
      {/* Home */}
      <div className={`flex items-center gap-3 px-4 py-3.5 ${homeWins ? 'bg-primary/5' : ''}`}>
        {match.homeTeamImageUrl
          ? <img src={match.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
          : <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
        }
        <span className={`flex-1 text-sm truncate ${match.homeTeamName ? (homeWins ? 'font-semibold' : 'font-medium') : 'text-muted-foreground italic'}`}>
          {match.homeTeamName ?? 'TBD'}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={homeStr}
          onChange={e => setHomeStr(e.target.value.replace(/\D/g, '').slice(0, 2))}
          onKeyDown={e => e.key === 'Enter' && !showTiebreaker && bothValid && handleSave()}
          disabled={!hasTeams || isSaving}
          className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
          placeholder="–"
        />
      </div>

      <div className="h-px bg-border" />

      {/* Away */}
      <div className={`flex items-center gap-3 px-4 py-3.5 ${awayWins ? 'bg-primary/5' : ''}`}>
        {match.awayTeamImageUrl
          ? <img src={match.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
          : <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
        }
        <span className={`flex-1 text-sm truncate ${match.awayTeamName ? (awayWins ? 'font-semibold' : 'font-medium') : 'text-muted-foreground italic'}`}>
          {match.awayTeamName ?? 'TBD'}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={awayStr}
          onChange={e => setAwayStr(e.target.value.replace(/\D/g, '').slice(0, 2))}
          onKeyDown={e => e.key === 'Enter' && !showTiebreaker && bothValid && handleSave()}
          disabled={!hasTeams || isSaving}
          className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
          placeholder="–"
        />
      </div>

      {/* Tiebreaker picker — shown when scores are equal */}
      {showTiebreaker && (
        <>
          <div className="h-px bg-border" />
          <div className="p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground text-center font-medium">
              Who advances after extra time / penalties?
            </p>
            <div className="flex gap-2">
              {[
                { id: match.homeTeamId!, name: match.homeTeamName },
                { id: match.awayTeamId!, name: match.awayTeamName },
              ].map(team => (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => setSelectedWinnerId(team.id)}
                  className={`flex-1 text-xs py-2 rounded-lg border font-medium transition-colors truncate px-1 ${
                    selectedWinnerId === team.id
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'hover:bg-primary hover:text-primary-foreground hover:border-primary'
                  }`}
                >
                  {team.name ?? (team.id === match.homeTeamId ? 'Home' : 'Away')}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Save button */}
      {hasTeams && (
        <>
          <div className="h-px bg-border" />
          <div className="px-4 py-3">
            <button
              onClick={handleSave}
              disabled={!bothValid || isSaving || (isDrawEntry && !selectedWinnerId)}
              className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {isSaving ? 'Saving…' : isCompleted ? 'Update Result' : 'Save Result'}
            </button>
            {isDrawEntry && !selectedWinnerId && (
              <p className="text-[11px] text-muted-foreground text-center mt-1.5">Select who advances to save</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FocusedAdminResults({
  tournamentId,
  knockoutMatches,
  firstRound,
  hasBronzeFinal,
}: {
  tournamentId: string;
  knockoutMatches: MatchWithTeams[];
  firstRound: KnockoutFirstRound;
  hasBronzeFinal: boolean;
}) {
  const queryClient = useQueryClient();
  const [currentIdx, setCurrentIdx] = useState(0);
  const [slideDir, setSlideDir] = useState<'fromRight' | 'fromLeft'>('fromRight');
  const [animKey, setAnimKey] = useState(0);
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initedRef = useRef(false);

  const startIdx = ROUND_ORDER.indexOf(firstRound);
  const stages = ROUND_ORDER.slice(startIdx);

  const matchesByStage = useMemo(() => {
    const map = new Map<string, MatchWithTeams[]>();
    for (const m of knockoutMatches) {
      if (!map.has(m.stage as string)) map.set(m.stage as string, []);
      map.get(m.stage as string)!.push(m);
    }
    for (const [, ms] of map) {
      ms.sort((a, b) => {
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      });
    }
    return map;
  }, [knockoutMatches]);

  const allFlatMatches = useMemo<FlatAdminMatch[]>(() => {
    const list: FlatAdminMatch[] = [];
    for (const stage of stages) {
      const stageMs = matchesByStage.get(stage) ?? [];
      if (stage === 'final' && hasBronzeFinal) {
        const bronzeMs = matchesByStage.get('bronze_final') ?? [];
        list.push({ stage: 'bronze_final', match: bronzeMs[0] ?? null, isBronze: true, matchIdxInRound: 0, matchCountInRound: 1 });
      }
      for (let i = 0; i < stageMs.length; i++) {
        list.push({ stage, match: stageMs[i] ?? null, isBronze: false, matchIdxInRound: i, matchCountInRound: stageMs.length });
      }
    }
    return list;
  }, [matchesByStage, stages, hasBronzeFinal]);

  useEffect(() => {
    if (initedRef.current || knockoutMatches.length === 0) return;
    initedRef.current = true;
    const firstIncomplete = allFlatMatches.findIndex(
      m => m.match && m.match.homeTeamId && m.match.awayTeamId && m.match.status !== 'completed'
    );
    if (firstIncomplete > 0) setCurrentIdx(firstIncomplete);
  }, [knockoutMatches.length, allFlatMatches]);

  const updateScoreMutation = useMutation({
    mutationFn: ({ matchId, home, away, progressingTeamId }: { matchId: string; home: number; away: number; progressingTeamId: string | null }) =>
      api.patch<Match>(`/matches/${matchId}`, { homeScore: home, awayScore: away, progressingTeamId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] });
      if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
      autoAdvanceTimer.current = setTimeout(() => {
        setCurrentIdx(prev => {
          const next = allFlatMatches.findIndex((m, idx) => idx > prev && m.match?.status !== 'completed' && m.match?.homeTeamId && m.match?.awayTeamId);
          return next !== -1 ? next : Math.min(prev + 1, allFlatMatches.length - 1);
        });
        setSlideDir('fromRight');
        setAnimKey(k => k + 1);
      }, 500);
    },
  });

  function goTo(idx: number) {
    setSlideDir(idx > currentIdx ? 'fromRight' : 'fromLeft');
    setAnimKey(k => k + 1);
    setCurrentIdx(idx);
  }

  const current = allFlatMatches[currentIdx];
  if (!current) return <p className="text-sm text-muted-foreground">No knockout matches yet.</p>;

  const currentMatch = current.match;
  const isCompleted = currentMatch?.status === 'completed';
  const hasTbdTeams = !currentMatch?.homeTeamId || !currentMatch?.awayTeamId;
  const canGoNext = currentIdx < allFlatMatches.length - 1 && (isCompleted || hasTbdTeams);
  const canGoPrev = currentIdx > 0;
  const isSaving = updateScoreMutation.isPending;

  const currentStageLabel = current.isBronze ? 'Bronze Final' : ROUND_LABELS[current.stage as KnockoutFirstRound];
  const roundMatchesForDots = current.isBronze ? [] : allFlatMatches.filter(m => m.stage === current.stage && !m.isBronze);

  return (
    <div className="space-y-5">
      <style>{`
        @keyframes ko_slide_fromRight { from { opacity: 0; transform: translateX(36px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes ko_slide_fromLeft  { from { opacity: 0; transform: translateX(-36px); } to { opacity: 1; transform: translateX(0); } }
      `}</style>

      {/* Round tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {stages.map(stage => {
          const isActive = current.stage === stage && !current.isBronze;
          const stageMs = allFlatMatches.filter(m => m.stage === stage && !m.isBronze);
          const allDone = stageMs.length > 0 && stageMs.every(m => m.match?.status === 'completed');
          const firstIdx = allFlatMatches.findIndex(m => m.stage === stage && !m.isBronze);
          const btn = (
            <button
              key={stage}
              type="button"
              onClick={() => firstIdx !== -1 && goTo(firstIdx)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${isActive ? 'bg-primary text-primary-foreground' : allDone ? 'bg-green-500/15 text-green-700 border border-green-500/30' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
            >
              {ROUND_LABELS[stage as KnockoutFirstRound]}
              {allDone && <span className="ml-1 text-green-600">✓</span>}
            </button>
          );
          if (stage === 'final' && hasBronzeFinal) {
            const bronzeIdx = allFlatMatches.findIndex(m => m.isBronze);
            const bronzeDone = allFlatMatches.find(m => m.isBronze)?.match?.status === 'completed';
            const bronzeBtn = (
              <button
                key="bronze_final"
                type="button"
                onClick={() => bronzeIdx !== -1 && goTo(bronzeIdx)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${current.isBronze ? 'bg-primary text-primary-foreground' : bronzeDone ? 'bg-green-500/15 text-green-700 border border-green-500/30' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
              >
                Bronze Final
                {bronzeDone && <span className="ml-1 text-green-600">✓</span>}
              </button>
            );
            return [bronzeBtn, btn];
          }
          return btn;
        })}
      </div>

      {/* Match navigation area */}
      <div className="rounded-xl border bg-muted/20 p-5">
        <div className="text-center mb-4">
          <h2 className="text-base font-semibold">{currentStageLabel}</h2>
          {!current.isBronze && roundMatchesForDots.length > 1 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Match {current.matchIdxInRound + 1} of {current.matchCountInRound}
            </p>
          )}
        </div>

        {roundMatchesForDots.length > 1 && (
          <div className="flex justify-center gap-1.5 mb-5">
            {roundMatchesForDots.map(m => {
              const flatIdx = allFlatMatches.indexOf(m);
              const isCurrent = flatIdx === currentIdx;
              const isDone = m.match?.status === 'completed';
              return (
                <button
                  key={m.match?.id ?? flatIdx}
                  type="button"
                  onClick={() => goTo(flatIdx)}
                  className={`rounded-full transition-all duration-200 ${isCurrent ? 'w-5 h-2.5 bg-primary' : isDone ? 'w-2.5 h-2.5 bg-green-500' : 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'}`}
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

          <div key={animKey} className="flex-1" style={{ animation: `ko_slide_${slideDir} 0.22s ease-out` }}>
            <FocusedAdminMatchCard
              match={currentMatch ?? null}
              onSave={(home, away, progressingTeamId) => currentMatch && updateScoreMutation.mutate({ matchId: currentMatch.id, home, away, progressingTeamId })}
              isSaving={isSaving}
            />
          </div>

          <button
            type="button"
            onClick={() => canGoNext && goTo(currentIdx + 1)}
            disabled={!canGoNext}
            className={`flex-shrink-0 h-10 w-10 rounded-full border flex items-center justify-center transition-all duration-200 ${canGoNext ? 'border-primary text-primary hover:bg-primary/10 shadow-sm' : 'opacity-0 pointer-events-none'}`}
            aria-label="Next match"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TournamentKnockoutPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const isAdmin = user?.isAdmin ?? false;

  const { data: tournament, isLoading } = useQuery({
    queryKey: ['tournament', id],
    queryFn: () => api.get<Tournament>(`/tournaments/${id}`),
    enabled: !!id,
  });

  const { data: groupList = [] } = useQuery({
    queryKey: ['groups', id],
    queryFn: () => api.get<Group[]>(`/tournaments/${id}/groups`),
    enabled: !!id,
  });

  const { data: allMatches = [] } = useQuery({
    queryKey: ['matches', id],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${id}/matches`),
    enabled: !!id,
  });

  const knockoutStages = new Set(['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final']);
  const knockoutMatches = allMatches.filter(m => knockoutStages.has(m.stage as string));

  // Config state
  const [firstRound, setFirstRound] = useState<KnockoutFirstRound>(DEFAULT_CONFIG.firstRound);
  const [hasBronzeFinal, setHasBronzeFinal] = useState(DEFAULT_CONFIG.hasBronzeFinal);
  const [directQualifiers, setDirectQualifiers] = useState(DEFAULT_CONFIG.directQualifiers);
  const [luckyLosers, setLuckyLosers] = useState(DEFAULT_CONFIG.luckyLosers);
  const [bracketSlots, setBracketSlots] = useState<Record<string, string>>({});
  const [configDirty, setConfigDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [activeQualifier, setActiveQualifier] = useState<string | null>(null);

  useEffect(() => {
    if (tournament && !initialized) {
      const cfg = tournament.knockoutConfig;
      if (cfg) {
        setFirstRound(cfg.firstRound);
        setHasBronzeFinal(cfg.hasBronzeFinal);
        setDirectQualifiers(cfg.directQualifiers);
        setLuckyLosers(cfg.luckyLosers);
        setBracketSlots(cfg.bracketSlots ?? {});
      }
      setInitialized(true);
    }
  }, [tournament, initialized]);

  const saveConfigMutation = useMutation({
    mutationFn: (config: Partial<KnockoutConfig>) =>
      api.patch<KnockoutConfig>(`/tournaments/${id}/knockout-config`, config),
    onSuccess: data => {
      queryClient.setQueryData<Tournament>(['tournament', id], old =>
        old ? { ...old, knockoutConfig: data } : old
      );
    },
  });

  const simulateKnockoutMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${id}/simulate-knockout`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', id] }),
  });

  const clearKnockoutMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${id}/clear-knockout`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', id] }),
  });

  const sortedGroups = useMemo(
    () => [...groupList].sort((a: Group, b: Group) => a.name.localeCompare(b.name)),
    [groupList]
  );

  const qualifierLabels = useMemo(() => {
    const labels: string[] = [];
    for (const g of sortedGroups) {
      for (let d = 1; d <= directQualifiers; d++) labels.push(`${d}${g.name}`);
    }
    return labels;
  }, [sortedGroups, directQualifiers]);

  const firstRoundMatchCount = FIRST_ROUND_COUNTS[firstRound];
  const totalSlots = firstRoundMatchCount * 2;
  const usedQualifiers = useMemo(() => new Set(Object.values(bracketSlots)), [bracketSlots]);

  const luckyLoserLabels = useMemo(
    () => luckyLosers > 0 ? computeLuckyLoserLabels(firstRoundMatchCount, bracketSlots, sortedGroups, directQualifiers) : {},
    [firstRoundMatchCount, bracketSlots, sortedGroups, directQualifiers, luckyLosers]
  );

  function handleConfigSave() {
    const newSlots: Record<string, string> = {};
    setBracketSlots(newSlots);
    setConfigDirty(false);
    saveConfigMutation.mutate({ firstRound, hasBronzeFinal, directQualifiers, luckyLosers, bracketSlots: newSlots });
  }

  function handleClearSlot(slotId: string) {
    const newSlots = { ...bracketSlots };
    delete newSlots[slotId];
    setBracketSlots(newSlots);
    saveConfigMutation.mutate({ bracketSlots: newSlots });
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveQualifier(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveQualifier(null);
    const { active, over } = event;
    if (!over) return;
    const qualifier = String(active.id);
    const targetId = String(over.id);
    if (!targetId.startsWith('slot_')) return;
    const slotId = targetId.slice(5);
    const newSlots = { ...bracketSlots };
    for (const [k, v] of Object.entries(newSlots)) {
      if (v === qualifier) delete newSlots[k];
    }
    newSlots[slotId] = qualifier;
    setBracketSlots(newSlots);
    saveConfigMutation.mutate({ bracketSlots: newSlots });
  }

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!tournament) return <div className="p-8 text-sm">Tournament not found.</div>;

  const qualifiersMatch = qualifierLabels.length + luckyLosers === totalSlots;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <Link to="/admin/tournaments" className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground">
        ← Back to Tournaments
      </Link>

      {/* Stage tabs */}
      <div className="flex border-b mb-6">
        <Link to={`/admin/tournaments/${id}`} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
          Group Stage
        </Link>
        <div className="px-4 py-2 text-sm font-medium border-b-2 border-primary -mb-px">
          Knockout Stage
        </div>
      </div>

      {/* Header */}
      <div className="mb-8 flex flex-wrap items-center gap-3">
        {tournament.imageUrl && (
          <img src={tournament.imageUrl} alt={tournament.name} className="h-10 w-10 rounded-lg object-cover" />
        )}
        <h1 className="text-2xl font-bold">{tournament.name} — Knockout Stage</h1>
        {isAdmin && (
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => simulateKnockoutMutation.mutate()}
              disabled={simulateKnockoutMutation.isPending}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {simulateKnockoutMutation.isPending ? 'Simulating…' : 'Simulate Knockout Results'}
            </button>
            <button
              onClick={() => clearKnockoutMutation.mutate()}
              disabled={clearKnockoutMutation.isPending}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {clearKnockoutMutation.isPending ? 'Clearing…' : 'Clear Knockout Results'}
            </button>
          </div>
        )}
      </div>

      {/* Settings panel */}
      <section className="mb-8 rounded-lg border p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Knockout Settings
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">First Knockout Round</label>
            <select
              value={firstRound}
              onChange={e => { setFirstRound(e.target.value as KnockoutFirstRound); setConfigDirty(true); }}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="round_of_32">Round of 32 (32 teams)</option>
              <option value="round_of_16">Round of 16 (16 teams)</option>
              <option value="quarter_final">Quarter-finals (8 teams)</option>
              <option value="semi_final">Semi-finals (4 teams)</option>
              <option value="final">Final only (2 teams)</option>
            </select>
          </div>
          <div className="flex items-end pb-0.5">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={hasBronzeFinal} onChange={e => { setHasBronzeFinal(e.target.checked); setConfigDirty(true); }} className="h-4 w-4 rounded" />
              <span className="text-sm">Bronze Final (3rd place match)</span>
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Direct Qualifiers per Group</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4].map(n => (
                <button key={n} type="button" onClick={() => { setDirectQualifiers(n); setConfigDirty(true); }}
                  className={`h-9 w-9 rounded-md border text-sm font-semibold transition-colors ${directQualifiers === n ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'}`}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Lucky Losers <span className="font-normal">(best teams just outside direct spots)</span>
            </label>
            <input type="number" min="0" max="32" value={luckyLosers}
              onChange={e => { setLuckyLosers(Math.max(0, parseInt(e.target.value) || 0)); setConfigDirty(true); }}
              className="w-24 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t">
          <div className="text-sm">
            {sortedGroups.length === 0 ? (
              <span className="text-muted-foreground">Add groups first to configure qualifiers</span>
            ) : (
              <>
                <span className={`font-medium ${qualifiersMatch ? 'text-green-600' : 'text-amber-600'}`}>
                  {qualifierLabels.length} direct qualifiers{luckyLosers > 0 && ` + ${luckyLosers} lucky losers (auto)`}
                </span>
                <span className="text-muted-foreground"> / {totalSlots} bracket slots</span>
                {!qualifiersMatch && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({totalSlots > qualifierLabels.length + luckyLosers
                      ? `need ${totalSlots - qualifierLabels.length - luckyLosers} more`
                      : `${qualifierLabels.length + luckyLosers - totalSlots} too many`})
                  </span>
                )}
              </>
            )}
          </div>
          {configDirty && (
            <button onClick={handleConfigSave} disabled={saveConfigMutation.isPending}
              className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {saveConfigMutation.isPending ? 'Saving…' : 'Save Settings'}
            </button>
          )}
          {!configDirty && saveConfigMutation.isSuccess && <span className="text-xs text-green-600">Saved</span>}
        </div>
      </section>

      <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {/* Bracket Setup */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bracket Setup</h2>
            {Object.keys(bracketSlots).length > 0 && (
              <button type="button" onClick={() => { setBracketSlots({}); saveConfigMutation.mutate({ bracketSlots: {} }); }} className="text-xs text-muted-foreground hover:text-destructive">
                Clear all slots
              </button>
            )}
          </div>
          <BracketVisualization firstRound={firstRound} hasBronzeFinal={hasBronzeFinal} bracketSlots={bracketSlots} onClearSlot={handleClearSlot} luckyLoserLabels={luckyLoserLabels} />
        </section>

        {/* Qualifier pool */}
        {qualifierLabels.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Direct Qualifiers</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Drag into bracket slots above.{' '}
              <span className="font-medium text-foreground">{usedQualifiers.size}/{qualifierLabels.length} placed</span>
              {luckyLosers > 0 && <span> · Lucky loser slots auto-fill in the bracket</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              {qualifierLabels.map(label => (
                <DraggableQualifier key={label} label={label} isUsed={usedQualifiers.has(label)} />
              ))}
            </div>
          </section>
        )}

        {qualifierLabels.length === 0 && sortedGroups.length > 0 && (
          <p className="text-sm text-muted-foreground mb-8">Set direct qualifiers and lucky losers above to generate the qualifier pool.</p>
        )}

        <DragOverlay dropAnimation={null}>
          {activeQualifier && (
            <div className="rounded border bg-primary px-2.5 py-1 text-xs font-mono font-semibold text-primary-foreground shadow-lg">{activeQualifier}</div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Results */}
      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Results</h2>

        {knockoutMatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No knockout matches yet. Generate the first round from the Group Stage tab once all group matches are complete.
          </p>
        ) : (
          <FocusedAdminResults
            tournamentId={id!}
            knockoutMatches={knockoutMatches}
            firstRound={firstRound}
            hasBronzeFinal={hasBronzeFinal}
          />
        )}
      </section>
    </main>
  );
}
