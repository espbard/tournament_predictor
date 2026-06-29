import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import BackButton from '@/components/BackButton';

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
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import { useTeamName } from '@/lib/teamTranslations';
import type { Tournament, Group, KnockoutConfig, KnockoutFirstRound, Match } from '@tournament-predictor/shared';
import { KnockoutBracketVisualizer } from '@/components/KnockoutStageContent';

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
  homeTeamImageUrl: string | null;
  awayTeamImageUrl: string | null;
  groupName: string | null;
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

function toLocalDatetimeStr(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface FlatAdminMatch {
  stage: string;
  match: MatchWithTeams | null;
  isBronze: boolean;
  matchIdxInRound: number;
  matchCountInRound: number;
  bracketPositionIdx: number;
}

function FocusedAdminMatchCard({
  match,
  onQueue,
  queuedScore,
  homeSlotLabel,
  awaySlotLabel,
  onSaveScheduledAt,
}: {
  match: MatchWithTeams | null;
  onQueue: (home: number, away: number, progressingTeamId: string | null) => void;
  queuedScore?: { home: number; away: number; progressingTeamId: string | null } | null;
  homeSlotLabel?: string;
  awaySlotLabel?: string;
  onSaveScheduledAt?: (scheduledAt: string | null) => void;
}) {
  const [homeStr, setHomeStr] = useState('');
  const [awayStr, setAwayStr] = useState('');
  const [selectedWinnerId, setSelectedWinnerId] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduledAtStr, setScheduledAtStr] = useState('');
  const prevMatchIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (match?.id !== prevMatchIdRef.current) {
      prevMatchIdRef.current = match?.id ?? null;
      setEditingSchedule(false);
      if (queuedScore) {
        setHomeStr(String(queuedScore.home));
        setAwayStr(String(queuedScore.away));
        setSelectedWinnerId(queuedScore.progressingTeamId);
      } else {
        setHomeStr(match?.homeScore != null ? String(match.homeScore) : '');
        setAwayStr(match?.awayScore != null ? String(match.awayScore) : '');
        setSelectedWinnerId(null);
      }
    }
  }, [match?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!queuedScore) {
      setHomeStr(match?.homeScore != null ? String(match.homeScore) : '');
      setAwayStr(match?.awayScore != null ? String(match.awayScore) : '');
    }
  }, [match?.homeScore, match?.awayScore, queuedScore]);

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

  const isQueued = !!queuedScore;

  const goldenBorderClass = 'ring-2 ring-inset ring-amber-400 bg-amber-50/40 dark:bg-amber-900/15';

  // Highlight the team selected to progress through a drawn tie.
  const adminHomeProgresses =
    (isQueued && queuedScore!.home === queuedScore!.away && queuedScore!.progressingTeamId === match!.homeTeamId) ||
    (!isQueued && isDrawEntry && selectedWinnerId === match!.homeTeamId) ||
    (isCompleted && match!.homeScore === match!.awayScore && match!.progressingTeamId === match!.homeTeamId);
  const adminAwayProgresses =
    (isQueued && queuedScore!.home === queuedScore!.away && queuedScore!.progressingTeamId === match!.awayTeamId) ||
    (!isQueued && isDrawEntry && selectedWinnerId === match!.awayTeamId) ||
    (isCompleted && match!.homeScore === match!.awayScore && match!.progressingTeamId === match!.awayTeamId);

  // Home row is first only when there's no "staged pending" header above it.
  const adminHomeIsFirst = !isQueued;
  // Away row is last only when there's no tiebreaker section below it.
  const adminAwayIsLast = !showTiebreaker;

  function handleSaveSchedule() {
    if (!onSaveScheduledAt) return;
    onSaveScheduledAt(scheduledAtStr ? new Date(scheduledAtStr).toISOString() : null);
    setEditingSchedule(false);
  }

  function tryAutoQueue(hStr: string, aStr: string, winnerId: string | null) {
    const h = hStr === '' ? null : parseInt(hStr, 10);
    const a = aStr === '' ? null : parseInt(aStr, 10);
    if (h === null || a === null || isNaN(h) || isNaN(a) || h < 0 || a < 0) return;
    const isDraw = h === a;
    if (isDraw && !winnerId) return;
    onQueue(h, a, isDraw ? winnerId : null);
  }

  const { t } = useT();
  const { tn } = useTeamName();

  if (!match) {
    return (
      <div className="rounded-xl border-2 bg-card/50 shadow-sm p-8 w-full max-w-xs mx-auto text-center text-sm text-muted-foreground italic">
        TBD
      </div>
    );
  }

  return (
    <div className={`rounded-xl border-2 shadow-sm overflow-hidden w-full sm:max-w-xs sm:mx-auto ${isQueued ? 'border-amber-400 bg-amber-50/10 dark:bg-amber-900/10' : 'bg-card'}`}>
      {isQueued && (
        <div className="px-4 py-1.5 bg-amber-100/60 dark:bg-amber-900/30 text-[11px] font-medium text-amber-800 dark:text-amber-300 text-center tracking-wide">
          {t('knockout.stagedPending')}
        </div>
      )}

      {/* Date/time */}
      {match.scheduledAt && (
        <div className="px-4 py-1.5 text-[11px] text-muted-foreground text-center bg-muted/30">
          {new Date(match.scheduledAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </div>
      )}

      {/* Home */}
      <div className={`flex items-center gap-3 px-4 py-3.5 ${adminHomeProgresses ? goldenBorderClass + (adminHomeIsFirst ? ' rounded-t-xl' : '') : homeWins ? 'bg-primary/5' : ''}`}>
        {match.homeTeamImageUrl
          ? <img src={match.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
          : <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
        }
        <span className={`flex-1 text-sm truncate ${match.homeTeamName ? (homeWins ? 'font-semibold' : 'font-medium') : 'text-muted-foreground italic'}`}>
          {tn(match.homeTeamName) || homeSlotLabel || 'TBD'}
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            disabled={!hasTeams}
            onClick={() => {
              const cur = parseInt(homeStr || '0') || 0;
              const val = String(Math.max(0, cur - 1));
              setHomeStr(val);
              tryAutoQueue(val, awayStr, selectedWinnerId);
            }}
            className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >−</button>
          <input
            type="text"
            inputMode="numeric"
            value={homeStr}
            onChange={e => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 2);
              setHomeStr(val);
              tryAutoQueue(val, awayStr, selectedWinnerId);
            }}
            disabled={!hasTeams}
            className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
            placeholder="–"
          />
          <button
            type="button"
            disabled={!hasTeams}
            onClick={() => {
              const cur = parseInt(homeStr || '0') || 0;
              const val = String(Math.min(99, cur + 1));
              setHomeStr(val);
              tryAutoQueue(val, awayStr, selectedWinnerId);
            }}
            className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >+</button>
        </div>
      </div>

      <div className="h-px bg-border" />

      {/* Away */}
      <div className={`flex items-center gap-3 px-4 py-3.5 ${adminAwayProgresses ? goldenBorderClass + (adminAwayIsLast ? ' rounded-b-xl' : '') : awayWins ? 'bg-primary/5' : ''}`}>
        {match.awayTeamImageUrl
          ? <img src={match.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
          : <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
        }
        <span className={`flex-1 text-sm truncate ${match.awayTeamName ? (awayWins ? 'font-semibold' : 'font-medium') : 'text-muted-foreground italic'}`}>
          {tn(match.awayTeamName) || awaySlotLabel || 'TBD'}
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            disabled={!hasTeams}
            onClick={() => {
              const cur = parseInt(awayStr || '0') || 0;
              const val = String(Math.max(0, cur - 1));
              setAwayStr(val);
              tryAutoQueue(homeStr, val, selectedWinnerId);
            }}
            className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >−</button>
          <input
            type="text"
            inputMode="numeric"
            value={awayStr}
            onChange={e => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 2);
              setAwayStr(val);
              tryAutoQueue(homeStr, val, selectedWinnerId);
            }}
            disabled={!hasTeams}
            className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
            placeholder="–"
          />
          <button
            type="button"
            disabled={!hasTeams}
            onClick={() => {
              const cur = parseInt(awayStr || '0') || 0;
              const val = String(Math.min(99, cur + 1));
              setAwayStr(val);
              tryAutoQueue(homeStr, val, selectedWinnerId);
            }}
            className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >+</button>
        </div>
      </div>

      {/* Tiebreaker picker — shown when scores are equal */}
      {showTiebreaker && (
        <>
          <div className="h-px bg-border" />
          <div className="p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground text-center font-medium">
              {t('knockout.whoAdvances')}
            </p>
            <div className="flex gap-2">
              {[
                { id: match.homeTeamId!, name: tn(match.homeTeamName) },
                { id: match.awayTeamId!, name: tn(match.awayTeamName) },
              ].map(team => (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => {
                    setSelectedWinnerId(team.id);
                    tryAutoQueue(homeStr, awayStr, team.id);
                  }}
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

      {isDrawEntry && !selectedWinnerId && hasTeams && (
        <p className="text-[11px] text-muted-foreground text-center px-4 pb-3">{t('knockout.selectToStage')}</p>
      )}

      {/* Schedule editor */}
      {onSaveScheduledAt && (
        <>
          <div className="h-px bg-border" />
          {!editingSchedule ? (
            <div className="flex items-center gap-2 px-4 py-2">
              {!match.scheduledAt && (
                <span className="text-xs text-muted-foreground flex-1">No date set</span>
              )}
              <button
                type="button"
                onClick={() => {
                  setScheduledAtStr(match.scheduledAt ? toLocalDatetimeStr(match.scheduledAt) : '');
                  setEditingSchedule(true);
                }}
                className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted shrink-0 ml-auto"
              >
                ✎ Edit
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-2">
              <input
                type="datetime-local"
                value={scheduledAtStr}
                onChange={e => setScheduledAtStr(e.target.value)}
                className="flex-1 min-w-0 text-xs rounded border px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={handleSaveSchedule}
                className="shrink-0 text-xs px-2 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditingSchedule(false)}
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
          )}
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
  bracketSlots,
  luckyLoserLabels,
}: {
  tournamentId: string;
  knockoutMatches: MatchWithTeams[];
  firstRound: KnockoutFirstRound;
  hasBronzeFinal: boolean;
  bracketSlots: Record<string, string>;
  luckyLoserLabels: Record<string, string>;
}) {
  const queryClient = useQueryClient();
  const { t } = useT();
  const [currentIdx, setCurrentIdx] = useState(0);
  const [slideDir, setSlideDir] = useState<'fromRight' | 'fromLeft'>('fromRight');
  const [animKey, setAnimKey] = useState(0);
  const initedRef = useRef(false);

  const getRoundLabel = (round: string) =>
    t(`knockout.rounds.${round}` as any) || ROUND_LABELS[round as KnockoutFirstRound] || round;

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
        if (a.bracketIndex !== null && a.bracketIndex !== undefined &&
            b.bracketIndex !== null && b.bracketIndex !== undefined) {
          return a.bracketIndex - b.bracketIndex;
        }
        if (a.bracketIndex !== null && a.bracketIndex !== undefined) return -1;
        if (b.bracketIndex !== null && b.bracketIndex !== undefined) return 1;
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
      const stageMs = matchesByStage.get(stage) ?? []; // bracket-index order; index = bracketPositionIdx
      if (stage === 'final' && hasBronzeFinal) {
        const bronzeMs = matchesByStage.get('bronze_final') ?? [];
        list.push({ stage: 'bronze_final', match: bronzeMs[0] ?? null, isBronze: true, matchIdxInRound: 0, matchCountInRound: 1, bracketPositionIdx: 0 });
      }
      // Sort by date for display order; bracket position (for slot labels) tracked separately
      const displayOrder = [...stageMs].sort((a, b) => {
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      });
      for (let i = 0; i < displayOrder.length; i++) {
        const m = displayOrder[i];
        list.push({ stage, match: m, isBronze: false, matchIdxInRound: i, matchCountInRound: stageMs.length, bracketPositionIdx: stageMs.indexOf(m) });
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

  const [pendingResults, setPendingResults] = useState<Record<string, { home: number; away: number; progressingTeamId: string | null }>>({});

  // After a date save the display re-sorts; track the saved match ID so we can
  // navigate back to the same match once allFlatMatches recomputes.
  const pendingNavigationMatchIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingNavigationMatchIdRef.current) return;
    const targetId = pendingNavigationMatchIdRef.current;
    const newIdx = allFlatMatches.findIndex(m => m.match?.id === targetId);
    if (newIdx !== -1) {
      pendingNavigationMatchIdRef.current = null;
      setCurrentIdx(newIdx);
    }
  }, [allFlatMatches]);

  const confirmResultsMutation = useMutation({
    mutationFn: async () => {
      for (const [matchId, { home, away, progressingTeamId }] of Object.entries(pendingResults)) {
        await api.patch<Match>(`/matches/${matchId}`, { homeScore: home, awayScore: away, progressingTeamId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] });
      setPendingResults({});
    },
  });

  const scheduleMatchMutation = useMutation({
    mutationFn: ({ matchId, scheduledAt }: { matchId: string; scheduledAt: string | null }) =>
      api.patch<Match>(`/matches/${matchId}`, { scheduledAt }),
    onSuccess: (_data, variables) => {
      pendingNavigationMatchIdRef.current = variables.matchId;
      queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] });
    },
  });

  function queueResult(matchId: string, home: number, away: number, progressingTeamId: string | null) {
    setPendingResults(prev => ({ ...prev, [matchId]: { home, away, progressingTeamId } }));
  }

  function goTo(idx: number) {
    setSlideDir(idx > currentIdx ? 'fromRight' : 'fromLeft');
    setAnimKey(k => k + 1);
    setCurrentIdx(idx);
  }

  const current = allFlatMatches[currentIdx];
  const noMatchesLabel = t('knockout.noKnockoutMatches');
  if (!current) return <p className="text-sm text-muted-foreground">{noMatchesLabel}</p>;

  const currentMatch = current.match;
  const canGoNext = currentIdx < allFlatMatches.length - 1;
  const canGoPrev = currentIdx > 0;
  const pendingCount = Object.keys(pendingResults).length;

  const currentStageLabel = current.isBronze ? t('knockout.rounds.bronze_final') : getRoundLabel(current.stage);
  const roundMatchesForDots = current.isBronze ? [] : allFlatMatches.filter(m => m.stage === current.stage && !m.isBronze);

  return (
    <div className="space-y-5">
      <style>{`
        @keyframes ko_slide_fromRight { from { opacity: 0; transform: translateX(36px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes ko_slide_fromLeft  { from { opacity: 0; transform: translateX(-36px); } to { opacity: 1; transform: translateX(0); } }
      `}</style>

      {/* Confirm Results button */}
      {pendingCount > 0 && (
        <div className="flex justify-end">
          <button
            onClick={() => confirmResultsMutation.mutate()}
            disabled={confirmResultsMutation.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {confirmResultsMutation.isPending ? t('knockout.confirming') : t('knockout.confirmResults', { n: pendingCount })}
          </button>
        </div>
      )}

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
              {getRoundLabel(stage)}
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
                {t('knockout.rounds.bronze_final')}
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
              const isStaged = m.match?.id ? !!pendingResults[m.match.id] : false;
              return (
                <button
                  key={m.match?.id ?? flatIdx}
                  type="button"
                  onClick={() => goTo(flatIdx)}
                  className={`rounded-full transition-all duration-200 ${isCurrent ? 'w-5 h-2.5 bg-primary dark:bg-blue-400' : isDone ? 'w-2.5 h-2.5 bg-green-500' : isStaged ? 'w-2.5 h-2.5 bg-amber-400' : 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'}`}
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
            className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
            aria-label="Previous match"
          >
            ←
          </button>

          <div key={animKey} className="flex-1 min-w-0" style={{ animation: `ko_slide_${slideDir} 0.22s ease-out` }}>
            <FocusedAdminMatchCard
              match={currentMatch ?? null}
              onQueue={(home, away, progressingTeamId) => {
                if (currentMatch) queueResult(currentMatch.id, home, away, progressingTeamId);
              }}
              queuedScore={currentMatch?.id ? pendingResults[currentMatch.id] ?? null : null}
              homeSlotLabel={current.stage === firstRound ? (bracketSlots[`m${current.bracketPositionIdx + 1}_home`] ?? luckyLoserLabels[`m${current.bracketPositionIdx + 1}_home`]) : undefined}
              awaySlotLabel={current.stage === firstRound ? (bracketSlots[`m${current.bracketPositionIdx + 1}_away`] ?? luckyLoserLabels[`m${current.bracketPositionIdx + 1}_away`]) : undefined}
              onSaveScheduledAt={currentMatch ? (scheduledAt) => scheduleMatchMutation.mutate({ matchId: currentMatch.id, scheduledAt }) : undefined}
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
                onClick={() => canGoNext && goTo(currentIdx + 1)}
                disabled={!canGoNext}
                className={`h-11 w-11 rounded-full border flex items-center justify-center transition-all duration-200 ${canGoNext ? 'border-primary text-primary hover:bg-primary/10 shadow-sm dark:border-blue-400 dark:text-blue-400' : 'opacity-0 pointer-events-none'}`}
                aria-label="Next match"
              >→</button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => canGoNext && goTo(currentIdx + 1)}
            disabled={!canGoNext}
            className={`hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-all duration-200 ${canGoNext ? 'border-primary text-primary hover:bg-primary/10 shadow-sm dark:border-blue-400 dark:text-blue-400' : 'opacity-0 pointer-events-none'}`}
            aria-label="Next match"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Admin bracket editor (drag-and-drop team reassignment) ────────────────────

type TeamChipData = { teamId: string; name: string | null; imageUrl: string | null };

function DraggableTeamChip({ teamId, name, imageUrl, isDragOverlay }: TeamChipData & { isDragOverlay?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: teamId });
  const { tn } = useTeamName();
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      style={style}
      {...(isDragOverlay ? {} : listeners)}
      {...(isDragOverlay ? {} : attributes)}
      className={`flex items-center gap-2 rounded-lg border bg-card px-3 py-2 cursor-grab active:cursor-grabbing touch-none select-none transition-opacity ${isDragging && !isDragOverlay ? 'opacity-30' : ''}`}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-6 w-6 rounded-full object-cover flex-shrink-0" />
      ) : (
        <div className="h-6 w-6 rounded-full bg-muted flex-shrink-0 flex items-center justify-center text-[10px] font-bold">
          {name?.charAt(0) ?? '?'}
        </div>
      )}
      <span className="text-sm font-medium truncate">{tn(name) ?? 'TBD'}</span>
    </div>
  );
}

function DroppableSlot({ id, team, label }: { id: string; team: TeamChipData | null; label: string }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-w-0 rounded-lg border-2 border-dashed transition-colors ${isOver ? 'border-primary bg-primary/5' : 'border-border'} ${team ? 'bg-card' : 'bg-muted/20'}`}
      style={{ minHeight: 48 }}
    >
      {team ? (
        <DraggableTeamChip {...team} />
      ) : (
        <div className="flex items-center justify-center h-12 text-xs text-muted-foreground">
          {isOver ? 'Drop here' : label}
        </div>
      )}
    </div>
  );
}

function DroppableBucket({ teams }: { teams: TeamChipData[] }) {
  const { isOver, setNodeRef } = useDroppable({ id: 'bucket' });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-xl border-2 border-dashed p-3 transition-colors min-h-[64px] ${isOver ? 'border-primary bg-primary/5' : 'border-amber-400/50 bg-amber-50/10 dark:bg-amber-900/10'}`}
    >
      <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-2">Temporary Bucket</p>
      {teams.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{isOver ? 'Drop here' : 'Drag teams here while reorganizing'}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {teams.map(t => <DraggableTeamChip key={t.teamId} {...t} />)}
        </div>
      )}
    </div>
  );
}

function AdminBracketEditor({
  tournamentId,
  firstRoundMatches,
  onCancel,
  onConfirmed,
}: {
  tournamentId: string;
  firstRoundMatches: MatchWithTeams[];
  onCancel: () => void;
  onConfirmed: () => void;
}) {
  const queryClient = useQueryClient();

  // Build initial slot map and team data from match assignments
  const initialTeamData = useMemo<Record<string, TeamChipData>>(() => {
    const map: Record<string, TeamChipData> = {};
    for (const m of firstRoundMatches) {
      if (m.homeTeamId) map[m.homeTeamId] = { teamId: m.homeTeamId, name: m.homeTeamName, imageUrl: m.homeTeamImageUrl ?? null };
      if (m.awayTeamId) map[m.awayTeamId] = { teamId: m.awayTeamId, name: m.awayTeamName, imageUrl: m.awayTeamImageUrl ?? null };
    }
    return map;
  }, [firstRoundMatches]);

  const initialSlotMap = useMemo<Record<string, string | null>>(() => {
    const map: Record<string, string | null> = {};
    for (const m of firstRoundMatches) {
      map[`${m.id}_home`] = m.homeTeamId ?? null;
      map[`${m.id}_away`] = m.awayTeamId ?? null;
    }
    return map;
  }, [firstRoundMatches]);

  const [slotMap, setSlotMap] = useState<Record<string, string | null>>(initialSlotMap);
  const [bucket, setBucket] = useState<string[]>([]);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);

  const teamData = initialTeamData;

  const overwriteMutation = useMutation({
    mutationFn: (payload: { matches: Array<{ matchId: string; homeTeamId: string | null; awayTeamId: string | null }> }) =>
      api.post(`/tournaments/${tournamentId}/overwrite-first-round`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] });
      onConfirmed();
    },
  });

  function handleDragStart(event: DragStartEvent) {
    setActiveTeamId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTeamId(null);
    const { active, over } = event;
    if (!over) return;

    const draggedTeamId = String(active.id);
    const destinationId = String(over.id);

    // Find source location
    let sourceKey: string | null = null;
    if (bucket.includes(draggedTeamId)) {
      sourceKey = 'bucket';
    } else {
      for (const [k, v] of Object.entries(slotMap)) {
        if (v === draggedTeamId) { sourceKey = k; break; }
      }
    }

    if (!sourceKey || sourceKey === destinationId) return;

    if (destinationId === 'bucket') {
      // slot → bucket
      setSlotMap(prev => ({ ...prev, [sourceKey!]: null }));
      setBucket(prev => [...prev, draggedTeamId]);
    } else if (destinationId.startsWith('slot_')) {
      const destKey = destinationId.slice(5); // remove 'slot_' prefix
      const displaced = slotMap[destKey] ?? null;

      if (sourceKey === 'bucket') {
        // bucket → slot
        setSlotMap(prev => ({ ...prev, [destKey]: draggedTeamId }));
        setBucket(prev => {
          const next = prev.filter(id => id !== draggedTeamId);
          if (displaced) next.push(displaced);
          return next;
        });
      } else {
        // slot → slot (swap)
        setSlotMap(prev => ({ ...prev, [sourceKey!]: displaced, [destKey]: draggedTeamId }));
      }
    }
  }

  const canConfirm = bucket.length === 0;

  function handleConfirm() {
    const payload = {
      matches: firstRoundMatches.map(m => ({
        matchId: m.id,
        homeTeamId: slotMap[`${m.id}_home`] ?? null,
        awayTeamId: slotMap[`${m.id}_away`] ?? null,
      })),
    };
    overwriteMutation.mutate(payload);
  }

  const activeTeam = activeTeamId ? teamData[activeTeamId] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Edit Bracket — First Round</h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm || overwriteMutation.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            title={!canConfirm ? 'Move all teams from the bucket into matches first' : undefined}
          >
            {overwriteMutation.isPending ? 'Saving…' : 'Confirm Bracket'}
          </button>
        </div>
      </div>

      {overwriteMutation.isError && (
        <p className="text-sm text-destructive">Failed to save bracket. Please try again.</p>
      )}

      <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <DroppableBucket teams={bucket.map(id => teamData[id]).filter(Boolean)} />

        <div className="space-y-2 mt-4">
          {firstRoundMatches.map((m, idx) => {
            const homeTeamId = slotMap[`${m.id}_home`] ?? null;
            const awayTeamId = slotMap[`${m.id}_away`] ?? null;
            const homeTeam = homeTeamId ? (teamData[homeTeamId] ?? null) : null;
            const awayTeam = awayTeamId ? (teamData[awayTeamId] ?? null) : null;
            return (
              <div key={m.id} className="rounded-lg border bg-muted/10 p-3">
                <p className="text-xs text-muted-foreground font-medium mb-2">
                  Match {idx + 1}
                  {m.scheduledAt && (
                    <span className="ml-2">
                      · {new Date(m.scheduledAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <DroppableSlot id={`slot_${m.id}_home`} team={homeTeam} label="Home slot" />
                  <span className="text-xs text-muted-foreground flex-shrink-0">vs</span>
                  <DroppableSlot id={`slot_${m.id}_away`} team={awayTeam} label="Away slot" />
                </div>
              </div>
            );
          })}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTeam && <DraggableTeamChip {...activeTeam} isDragOverlay />}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// ── Knockout tab content (used both inline and on the standalone page) ─────────

export function TournamentKnockoutTabContent({ tournamentId }: { tournamentId: string }) {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const isAdmin = user?.isAdmin ?? false;
  const { t } = useT();

  const { data: tournament, isLoading } = useQuery({
    queryKey: ['tournament', tournamentId],
    queryFn: () => api.get<Tournament>(`/tournaments/${tournamentId}`),
  });

  const { data: groupList = [] } = useQuery({
    queryKey: ['groups', tournamentId],
    queryFn: () => api.get<Group[]>(`/tournaments/${tournamentId}/groups`),
  });

  const { data: allMatches = [] } = useQuery({
    queryKey: ['matches', tournamentId],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${tournamentId}/matches`),
  });

  const knockoutStages = new Set(['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final']);
  const knockoutMatches = allMatches.filter(m => knockoutStages.has(m.stage as string));

  const [firstRound, setFirstRound] = useState<KnockoutFirstRound>(DEFAULT_CONFIG.firstRound);
  const [hasBronzeFinal, setHasBronzeFinal] = useState(DEFAULT_CONFIG.hasBronzeFinal);
  const [directQualifiers, setDirectQualifiers] = useState(DEFAULT_CONFIG.directQualifiers);
  const [luckyLosers, setLuckyLosers] = useState(DEFAULT_CONFIG.luckyLosers);
  const [bracketSlots, setBracketSlots] = useState<Record<string, string>>({});
  const [configDirty, setConfigDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [activeQualifier, setActiveQualifier] = useState<string | null>(null);
  const [isEditingBracket, setIsEditingBracket] = useState(false);

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
      api.patch<KnockoutConfig>(`/tournaments/${tournamentId}/knockout-config`, config),
    onSuccess: data => {
      queryClient.setQueryData<Tournament>(['tournament', tournamentId], old =>
        old ? { ...old, knockoutConfig: data } : old
      );
    },
  });

  const regenerateKnockoutMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${tournamentId}/regenerate-knockout`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] }),
  });

  const simulateKnockoutMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${tournamentId}/simulate-knockout`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] }),
  });

  const clearKnockoutMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${tournamentId}/clear-knockout`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] }),
  });

  const reallocateKnockoutMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${tournamentId}/reallocate-knockout`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] }),
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

  // Build match map keyed by `${stage}_${bracketIndex}` for the bracket visualizer
  const knockoutMatchMap = useMemo(() => {
    const koStages = new Set(['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final']);
    const byStage = new Map<string, MatchWithTeams[]>();
    for (const m of knockoutMatches) {
      if (!koStages.has(m.stage as string)) continue;
      if (!byStage.has(m.stage as string)) byStage.set(m.stage as string, []);
      byStage.get(m.stage as string)!.push(m);
    }
    for (const ms of byStage.values()) {
      ms.sort((a, b) => {
        if (a.bracketIndex != null && b.bracketIndex != null) return a.bracketIndex - b.bracketIndex;
        if (a.bracketIndex != null) return -1;
        if (b.bracketIndex != null) return 1;
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
  }, [knockoutMatches]);

  if (isLoading) return <LoadingSpinner />;
  if (!tournament) return null;

  const isSetupLocked = tournament.status !== 'upcoming';
  const qualifiersMatch = qualifierLabels.length + luckyLosers === totalSlots;

  return (
    <>
      {isAdmin && (
        <div className="flex justify-end gap-2 mb-6">
          {!isSetupLocked && (
            <button
              onClick={() => regenerateKnockoutMutation.mutate()}
              disabled={regenerateKnockoutMutation.isPending}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {regenerateKnockoutMutation.isPending ? t('knockout.regenerating') : t('knockout.regenerate')}
            </button>
          )}
          <button
            onClick={() => simulateKnockoutMutation.mutate()}
            disabled={simulateKnockoutMutation.isPending}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {simulateKnockoutMutation.isPending ? t('knockout.simulating') : t('knockout.simulate')}
          </button>
          <button
            onClick={() => clearKnockoutMutation.mutate()}
            disabled={clearKnockoutMutation.isPending}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {clearKnockoutMutation.isPending ? t('knockout.clearing') : t('knockout.clearResults')}
          </button>
          <button
            onClick={() => {
              if (confirm('Re-allocate teams to their bracket slots based on current group standings? This will update first-round match assignments and clear teams from later rounds. User bracket predictions are not affected.')) {
                reallocateKnockoutMutation.mutate();
              }
            }}
            disabled={reallocateKnockoutMutation.isPending}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {reallocateKnockoutMutation.isPending ? 'Re-allocating…' : 'Re-allocate Teams'}
          </button>
        </div>
      )}

      {isAdmin && isSetupLocked && (
        <>
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {t('knockout.setupLocked')}
          </div>

          {/* Bracket visualization + edit mode */}
          {tournament.knockoutConfig && (
            <section className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Knockout Bracket
                </h2>
                {!isEditingBracket && (
                  <button
                    type="button"
                    onClick={() => setIsEditingBracket(true)}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    Edit Bracket
                  </button>
                )}
              </div>

              {isEditingBracket ? (
                <AdminBracketEditor
                  tournamentId={tournamentId}
                  firstRoundMatches={(() => {
                    const fr = tournament.knockoutConfig!.firstRound;
                    const frMatches = knockoutMatches.filter(m => m.stage === fr);
                    return [...frMatches].sort((a, b) => {
                      if (a.bracketIndex != null && b.bracketIndex != null) return a.bracketIndex - b.bracketIndex;
                      if (a.bracketIndex != null) return -1;
                      if (b.bracketIndex != null) return 1;
                      if (!a.scheduledAt && !b.scheduledAt) return 0;
                      if (!a.scheduledAt) return 1;
                      if (!b.scheduledAt) return -1;
                      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
                    });
                  })()}
                  onCancel={() => setIsEditingBracket(false)}
                  onConfirmed={() => setIsEditingBracket(false)}
                />
              ) : (
                <KnockoutBracketVisualizer
                  knockoutConfig={tournament.knockoutConfig!}
                  actualMatchMap={knockoutMatchMap}
                />
              )}
            </section>
          )}
        </>
      )}

      {!isSetupLocked && (
        <>
          {/* Settings panel */}
          <section className="mb-8 rounded-lg border p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
              {t('knockout.knockoutSettings')}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('knockout.firstKnockoutRound')}</label>
                <select
                  value={firstRound}
                  onChange={e => { setFirstRound(e.target.value as KnockoutFirstRound); setConfigDirty(true); }}
                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="round_of_32">{t('knockout.roundOpts.round_of_32')}</option>
                  <option value="round_of_16">{t('knockout.roundOpts.round_of_16')}</option>
                  <option value="quarter_final">{t('knockout.roundOpts.quarter_final')}</option>
                  <option value="semi_final">{t('knockout.roundOpts.semi_final')}</option>
                  <option value="final">{t('knockout.roundOpts.final')}</option>
                </select>
              </div>
              <div className="flex items-end pb-0.5">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={hasBronzeFinal} onChange={e => { setHasBronzeFinal(e.target.checked); setConfigDirty(true); }} className="h-4 w-4 rounded" />
                  <span className="text-sm">{t('knockout.bronzeFinal')}</span>
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('knockout.directQualifiers')}</label>
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
                  {t('knockout.luckyLosers')} <span className="font-normal">{t('knockout.luckyLosersDesc')}</span>
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
                  <span className="text-muted-foreground">{t('knockout.addGroupsFirst')}</span>
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
                  {saveConfigMutation.isPending ? t('knockout.saving') : t('knockout.saveSettings')}
                </button>
              )}
              {!configDirty && saveConfigMutation.isSuccess && <span className="text-xs text-green-600">Saved</span>}
            </div>
          </section>

          <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            {/* Bracket Setup */}
            <section className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('knockout.bracketSetup')}</h2>
                {Object.keys(bracketSlots).length > 0 && (
                  <button type="button" onClick={() => { setBracketSlots({}); saveConfigMutation.mutate({ bracketSlots: {} }); }} className="text-xs text-muted-foreground hover:text-destructive">
                    {t('knockout.clearAllSlots')}
                  </button>
                )}
              </div>
              <BracketVisualization firstRound={firstRound} hasBronzeFinal={hasBronzeFinal} bracketSlots={bracketSlots} onClearSlot={handleClearSlot} luckyLoserLabels={luckyLoserLabels} />
            </section>

            {/* Qualifier pool */}
            {qualifierLabels.length > 0 && (
              <section className="mb-8">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">{t('knockout.directQualifiersPool')}</h2>
                <p className="text-xs text-muted-foreground mb-3">
                  {t('knockout.dragToBracket')}{' '}
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
        </>
      )}

      {/* Results */}
      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">{t('knockout.results')}</h2>

        {knockoutMatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('knockout.noKnockoutMatches')}
          </p>
        ) : (
          <FocusedAdminResults
            tournamentId={tournamentId}
            knockoutMatches={knockoutMatches}
            firstRound={firstRound}
            hasBronzeFinal={hasBronzeFinal}
            bracketSlots={bracketSlots}
            luckyLoserLabels={luckyLoserLabels}
          />
        )}
      </section>
    </>
  );
}

// ── Standalone page (keeps the /admin/tournaments/:id/knockout route working) ──

export default function TournamentKnockoutPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const { data: tournament, isLoading } = useQuery({
    queryKey: ['tournament', id],
    queryFn: () => api.get<Tournament>(`/tournaments/${id}`),
    enabled: !!id,
  });

  if (isLoading) return <LoadingSpinner />;
  if (!tournament) return <div className="p-8 text-sm">{t('knockout.notFound')}</div>;

  return (
    <main className="mx-auto max-w-5xl lg:max-w-[80%] px-4 pt-2.5 pb-8 sm:pt-8">
      <BackButton href="/admin/tournaments" />

      <div className="flex border-b mb-6">
        <Link to={`/admin/tournaments/${id}`} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
          {t('knockout.groupStageTab')}
        </Link>
        <div className="px-4 py-2 text-sm font-medium border-b-2 border-primary -mb-px">
          {t('knockout.knockoutStageTitle')}
        </div>
      </div>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        {tournament.imageUrl && (
          <img src={tournament.imageUrl} alt={tournament.name} className="h-10 w-10 rounded-lg object-cover" />
        )}
        <h1 className="text-2xl font-bold">{tournament.name} — {t('knockout.knockoutStageTitle')}</h1>
      </div>

      <TournamentKnockoutTabContent tournamentId={id!} />
    </main>
  );
}
