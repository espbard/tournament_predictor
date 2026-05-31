import { useState, useEffect, useMemo } from 'react';
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
import type { Tournament, Group, KnockoutConfig, KnockoutFirstRound } from '@tournament-predictor/shared';

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

// Vertical bracket layout constants
const MATCH_W = 152;      // width of each match card
const MATCH_H = 60;       // height of each match card (2 slots + 1px separator)
const MATCH_GAP = 16;     // horizontal gap between first-round cards
const ROW_GAP = 48;       // vertical gap between rows (connector space)
const UNIT = MATCH_W + MATCH_GAP;
const LABEL_COL_W = 92;   // width of the left-side round-name column

const DEFAULT_CONFIG: KnockoutConfig = {
  firstRound: 'round_of_16',
  hasBronzeFinal: false,
  directQualifiers: 2,
  luckyLosers: 0,
  bracketSlots: {},
};

// ── Lucky loser labels — FIFA World Cup 2026 placement rules ─────────────────
// Empty first-round slots are assigned combos in order (left-to-right, home
// before away). Groups not present in the tournament are filtered out of each
// combo. Slots beyond the 8 defined combos show no hint.

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

// ── Bracket slot (droppable) ──────────────────────────────────────────────────

function BracketSlot({
  slotId,
  label,
  luckyLoserLabel,
  onClear,
}: {
  slotId: string;
  label: string | null;
  luckyLoserLabel?: string;
  onClear: () => void;
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
          <button
            type="button"
            onClick={onClear}
            className="flex-shrink-0 text-muted-foreground hover:text-foreground text-xs leading-none px-0.5"
          >
            ×
          </button>
        </>
      ) : isOver ? (
        <span className="text-xs text-muted-foreground">↓ drop</span>
      ) : luckyLoserLabel ? (
        <span className="text-xs font-mono text-muted-foreground/60 italic flex-1 truncate">
          {luckyLoserLabel}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}

function TbdSlot({ label }: { label?: string }) {
  return (
    <div
      className="flex items-center px-2 text-xs text-muted-foreground italic truncate"
      style={{ height: (MATCH_H - 1) / 2 }}
    >
      {label ?? 'TBD'}
    </div>
  );
}

// ── Draggable qualifier chip ───────────────────────────────────────────────────

function DraggableQualifier({ label, isUsed }: { label: string; isUsed: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: label });
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`cursor-grab active:cursor-grabbing touch-none select-none rounded border px-2.5 py-1 text-xs font-mono font-semibold transition-opacity ${
        isDragging ? 'opacity-30' : ''
      } ${isUsed ? 'border-primary/40 bg-primary/10 text-primary' : 'bg-card hover:bg-muted'}`}
    >
      {label}
    </div>
  );
}

// ── Bracket visualization — vertical, final on top, first round at bottom ─────

function BracketVisualization({
  firstRound,
  hasBronzeFinal,
  bracketSlots,
  onClearSlot,
  luckyLoserLabels,
}: {
  firstRound: KnockoutFirstRound;
  hasBronzeFinal: boolean;
  bracketSlots: Record<string, string>;
  onClearSlot: (slotId: string) => void;
  luckyLoserLabels: Record<string, string>;
}) {
  // Build rounds array: rounds[0] = final (top), rounds[last] = firstRound (bottom)
  const startIdx = ROUND_ORDER.indexOf(firstRound);
  const rounds = [...ROUND_ORDER.slice(startIdx)].reverse();
  const maxRoundIdx = rounds.length - 1;
  const firstRoundMatchCount = FIRST_ROUND_COUNTS[firstRound];

  // Bracket width = width of the first-round (bottom) row
  const totalWidth = firstRoundMatchCount * UNIT - MATCH_GAP;

  // Precompute center X for every (roundIndex, matchIndex).
  // rounds[maxRoundIdx] is the first-round row; cards spaced by UNIT.
  // Each higher row is centered over its two children.
  const centersMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (let i = 0; i < firstRoundMatchCount; i++) {
      map[`${maxRoundIdx}_${i}`] = i * UNIT + MATCH_W / 2;
    }
    for (let R = maxRoundIdx - 1; R >= 0; R--) {
      const num = Math.pow(2, R);
      for (let i = 0; i < num; i++) {
        map[`${R}_${i}`] = (map[`${R + 1}_${2 * i}`] + map[`${R + 1}_${2 * i + 1}`]) / 2;
      }
    }
    return map;
  }, [firstRoundMatchCount, maxRoundIdx]);

  const getRowY = (R: number) => R * (MATCH_H + ROW_GAP);
  const mainBracketH = getRowY(maxRoundIdx) + MATCH_H;
  const totalH = mainBracketH + (hasBronzeFinal ? ROW_GAP + MATCH_H : 0);

  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <div className="flex gap-3">
        {/* Round label column — outside horizontal scroll so it stays visible */}
        <div className="flex-shrink-0" style={{ width: LABEL_COL_W }}>
          {rounds.map((round, R) => (
            <div
              key={round}
              style={{ height: MATCH_H, marginBottom: R < maxRoundIdx ? ROW_GAP : 0 }}
              className="flex items-center justify-end"
            >
              <span className="text-xs font-medium text-muted-foreground text-right leading-tight">
                {ROUND_LABELS[round]}
              </span>
            </div>
          ))}
          {hasBronzeFinal && (
            <div
              style={{ height: MATCH_H, marginTop: ROW_GAP }}
              className="flex items-center justify-end"
            >
              <span className="text-xs font-medium text-muted-foreground text-right leading-tight">
                Bronze Final
              </span>
            </div>
          )}
        </div>

        {/* Scrollable bracket */}
        <div className="overflow-x-auto flex-1">
          <div className="relative" style={{ width: totalWidth, height: totalH }}>
            {/* SVG connector lines (T-shapes from parent down to two children) */}
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                pointerEvents: 'none',
                overflow: 'visible',
              }}
              width={totalWidth}
              height={mainBracketH}
            >
              {rounds.slice(0, -1).flatMap((_, R) => {
                const numMatches = Math.pow(2, R);
                return Array.from({ length: numMatches }).map((_, i) => {
                  const pCX = centersMap[`${R}_${i}`];
                  const lCX = centersMap[`${R + 1}_${2 * i}`];
                  const rCX = centersMap[`${R + 1}_${2 * i + 1}`];
                  const pBotY = getRowY(R) + MATCH_H;
                  const cTopY = getRowY(R + 1);
                  const yMid = (pBotY + cTopY) / 2;
                  const d = [
                    `M ${pCX} ${pBotY} L ${pCX} ${yMid}`,
                    `M ${lCX} ${yMid} L ${rCX} ${yMid}`,
                    `M ${lCX} ${yMid} L ${lCX} ${cTopY}`,
                    `M ${rCX} ${yMid} L ${rCX} ${cTopY}`,
                  ].join(' ');
                  return (
                    <path
                      key={`c_${R}_${i}`}
                      d={d}
                      fill="none"
                      stroke="hsl(var(--border))"
                      strokeWidth="1"
                    />
                  );
                });
              })}
            </svg>

            {/* Match cards */}
            {rounds.flatMap((_, R) => {
              const numMatches = Math.pow(2, R);
              const rowY = getRowY(R);
              const isFirstRound = R === maxRoundIdx;

              return Array.from({ length: numMatches }).map((_, i) => {
                const cardLeft = centersMap[`${R}_${i}`] - MATCH_W / 2;
                const homeSlotId = `m${i + 1}_home`;
                const awaySlotId = `m${i + 1}_away`;

                return (
                  <div
                    key={`${R}_${i}`}
                    style={{
                      position: 'absolute',
                      left: cardLeft,
                      top: rowY,
                      width: MATCH_W,
                      height: MATCH_H,
                    }}
                  >
                    <div className="h-full rounded border bg-card overflow-hidden flex flex-col">
                      {isFirstRound ? (
                        <>
                          <BracketSlot
                            slotId={homeSlotId}
                            label={bracketSlots[homeSlotId] ?? null}
                            luckyLoserLabel={bracketSlots[homeSlotId] ? undefined : luckyLoserLabels[homeSlotId]}
                            onClear={() => onClearSlot(homeSlotId)}
                          />
                          <div className="border-t" />
                          <BracketSlot
                            slotId={awaySlotId}
                            label={bracketSlots[awaySlotId] ?? null}
                            luckyLoserLabel={bracketSlots[awaySlotId] ? undefined : luckyLoserLabels[awaySlotId]}
                            onClear={() => onClearSlot(awaySlotId)}
                          />
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

            {/* Bronze final — centered below the main bracket */}
            {hasBronzeFinal && (
              <div
                style={{
                  position: 'absolute',
                  left: totalWidth / 2 - MATCH_W / 2,
                  top: mainBracketH + ROW_GAP,
                  width: MATCH_W,
                  height: MATCH_H,
                }}
              >
                <div className="h-full rounded border border-dashed bg-card overflow-hidden flex flex-col">
                  <TbdSlot />
                  <div className="border-t border-dashed" />
                  <TbdSlot />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TournamentKnockoutPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

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

  const sortedGroups = useMemo(
    () => [...groupList].sort((a: Group, b: Group) => a.name.localeCompare(b.name)),
    [groupList]
  );

  const qualifierLabels = useMemo(() => {
    const labels: string[] = [];
    for (const g of sortedGroups) {
      for (let d = 1; d <= directQualifiers; d++) {
        labels.push(`${d}${g.name}`);
      }
    }
    // Lucky losers are not draggable — they auto-fill empty slots in the bracket
    return labels;
  }, [sortedGroups, directQualifiers]);

  const firstRoundMatchCount = FIRST_ROUND_COUNTS[firstRound];
  const totalSlots = firstRoundMatchCount * 2;
  const usedQualifiers = useMemo(() => new Set(Object.values(bracketSlots)), [bracketSlots]);

  const luckyLoserLabels = useMemo(
    () =>
      luckyLosers > 0
        ? computeLuckyLoserLabels(firstRoundMatchCount, bracketSlots, sortedGroups, directQualifiers)
        : {},
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
      <Link
        to="/admin/tournaments"
        className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to Tournaments
      </Link>

      {/* Stage tabs */}
      <div className="flex border-b mb-6">
        <Link
          to={`/admin/tournaments/${id}`}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Group Stage
        </Link>
        <div className="px-4 py-2 text-sm font-medium border-b-2 border-primary -mb-px">
          Knockout Stage
        </div>
      </div>

      {/* Header */}
      <div className="mb-8 flex items-center gap-3">
        {tournament.imageUrl && (
          <img src={tournament.imageUrl} alt={tournament.name} className="h-10 w-10 rounded-lg object-cover" />
        )}
        <h1 className="text-2xl font-bold">{tournament.name} — Knockout Stage</h1>
      </div>

      {/* Settings panel */}
      <section className="mb-8 rounded-lg border p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Knockout Settings
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              First Knockout Round
            </label>
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
              <input
                type="checkbox"
                checked={hasBronzeFinal}
                onChange={e => { setHasBronzeFinal(e.target.checked); setConfigDirty(true); }}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm">Bronze Final (3rd place match)</span>
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Direct Qualifiers per Group
            </label>
            <div className="flex gap-2">
              {[1, 2, 3, 4].map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { setDirectQualifiers(n); setConfigDirty(true); }}
                  className={`h-9 w-9 rounded-md border text-sm font-semibold transition-colors ${
                    directQualifiers === n
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'hover:bg-muted'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Lucky Losers
              <span className="ml-1 font-normal">(best teams just outside direct spots)</span>
            </label>
            <input
              type="number"
              min="0"
              max="32"
              value={luckyLosers}
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
                  {qualifierLabels.length} direct qualifiers
                  {luckyLosers > 0 && ` + ${luckyLosers} lucky losers (auto)`}
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
            <button
              onClick={handleConfigSave}
              disabled={saveConfigMutation.isPending}
              className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saveConfigMutation.isPending ? 'Saving…' : 'Save Settings'}
            </button>
          )}
          {!configDirty && saveConfigMutation.isSuccess && (
            <span className="text-xs text-green-600">Saved</span>
          )}
        </div>
      </section>

      <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {/* Bracket */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bracket</h2>
            {Object.keys(bracketSlots).length > 0 && (
              <button
                type="button"
                onClick={() => { setBracketSlots({}); saveConfigMutation.mutate({ bracketSlots: {} }); }}
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                Clear all slots
              </button>
            )}
          </div>
          <BracketVisualization
            firstRound={firstRound}
            hasBronzeFinal={hasBronzeFinal}
            bracketSlots={bracketSlots}
            onClearSlot={handleClearSlot}
            luckyLoserLabels={luckyLoserLabels}
          />
        </section>

        {/* Qualifier pool */}
        {qualifierLabels.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Direct Qualifiers
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Drag into bracket slots above.{' '}
              <span className="font-medium text-foreground">
                {usedQualifiers.size}/{qualifierLabels.length} placed
              </span>
              {luckyLosers > 0 && (
                <span> · Lucky loser slots auto-fill in the bracket</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {qualifierLabels.map(label => (
                <DraggableQualifier key={label} label={label} isUsed={usedQualifiers.has(label)} />
              ))}
            </div>
          </section>
        )}

        {qualifierLabels.length === 0 && sortedGroups.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Set direct qualifiers and lucky losers above to generate the qualifier pool.
          </p>
        )}

        <DragOverlay dropAnimation={null}>
          {activeQualifier && (
            <div className="rounded border bg-primary px-2.5 py-1 text-xs font-mono font-semibold text-primary-foreground shadow-lg">
              {activeQualifier}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </main>
  );
}
