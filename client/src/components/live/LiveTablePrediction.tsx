import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, Lock } from 'lucide-react';
import { bandDefForPosition, type LiveTableBand, type LiveTeam } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import { initialOrder, moveItem } from '@/lib/liveTableOrder';
import type { LiveTablePredictionView } from '@/lib/liveApi';

// ── League table prediction ───────────────────────────────────────────────────
//
// Order every team in the table from top to bottom. Each team in exactly the right final
// position scores; where the format defines bands (the Champions League's top 8, 9th–24th
// and 25th-and-below), landing a team in the right band scores again on top.
//
// Reordering works three ways on purpose: drag, the up/down buttons, and keyboard via
// those buttons. A 36-row table is miserable to drag on a phone, and drag alone would be
// unusable with a keyboard.

interface Props {
  view: Extract<LiveTablePredictionView, { available: true }>;
  onSave: (orderedTeamIds: string[]) => void;
  isSaving: boolean;
  savedAt: number | null;
  error: string | null;
  /**
   * 'gate' is the full-screen first-run version shown to a member who has not submitted a
   * table yet: the save control moves to a pinned bar at the foot of the screen, and the
   * order shown counts as a submission even if the user reorders nothing.
   */
  variant?: 'default' | 'gate';
}

function bandClasses(bandKey: string | null): string {
  switch (bandKey) {
    case 'automatic':
      return 'border-l-4 border-l-green-500';
    case 'playoff':
      return 'border-l-4 border-l-amber-500';
    case 'eliminated':
      return 'border-l-4 border-l-muted-foreground/40';
    default:
      return '';
  }
}

export default function LiveTablePrediction({
  view,
  onSave,
  isSaving,
  savedAt,
  error,
  variant = 'default',
}: Props) {
  const { t } = useT();
  const teamById = useMemo(() => new Map(view.teams.map(team => [team.id, team])), [view.teams]);

  const [order, setOrder] = useState<string[]>(() =>
    initialOrder(view.prediction?.orderedTeamIds ?? null, view.currentOrder, view.teams),
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Adopt a saved order arriving later (a refetch, or another device) — but never on top
  // of edits in progress.
  useEffect(() => {
    if (touched) return;
    setOrder(initialOrder(view.prediction?.orderedTeamIds ?? null, view.currentOrder, view.teams));
  }, [view.prediction, view.currentOrder, view.teams, touched]);

  const editable = !view.isLocked;

  // The stage definition is only needed for its bands, so a synthetic one will do.
  const stageForBands = useMemo(
    () => (view.bands.length ? ({ bands: view.bands } as { bands: LiveTableBand[] }) : null),
    [view.bands],
  );

  const scored = view.prediction?.points != null;
  const actualPositionById = useMemo(() => {
    const map = new Map<string, number>();
    view.currentOrder.forEach((id, i) => map.set(id, i + 1));
    return map;
  }, [view.currentOrder]);

  function reorder(from: number, to: number) {
    if (!editable) return;
    setTouched(true);
    setOrder(prev => moveItem(prev, from, to));
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;
    reorder(order.indexOf(activeId), order.indexOf(overId));
  }

  const dirty =
    touched &&
    (!view.prediction ||
      view.prediction.orderedTeamIds.join(',') !== order.join(','));

  // In the gate the standings order on screen is already a valid prediction, so accepting
  // it untouched has to be possible — otherwise a user who agrees with it cannot get past.
  const isGate = variant === 'gate';
  const canSave = isGate ? order.length > 0 : dirty;

  return (
    <div>
      <div className="mb-4 rounded-lg border p-4">
        {/* The gate's own heading already says this, so the card leads with the scoring. */}
        {!isGate && <h2 className="font-semibold">{t('live.table.title')}</h2>}
        <p className={`text-sm text-muted-foreground${isGate ? '' : ' mt-1'}`}>
          {view.bands.length > 0
            ? t('live.table.explainerWithBands', {
                exact: view.scoringConfig.table_exact_position,
                band: view.scoringConfig.table_correct_band,
                total:
                  view.scoringConfig.table_exact_position +
                  view.scoringConfig.table_correct_band,
              })
            : t('live.table.explainer', { exact: view.scoringConfig.table_exact_position })}
        </p>

        {view.bands.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {view.bands.map(band => (
              <li key={band.key} className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-sm ${
                    band.key === 'automatic'
                      ? 'bg-green-500'
                      : band.key === 'playoff'
                        ? 'bg-amber-500'
                        : 'bg-muted-foreground/40'
                  }`}
                />
                {t(band.labelKey)} ({band.from}
                {band.to === null ? '+' : `–${band.to}`})
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {view.isLocked ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock size={12} />
              {t('live.table.locked')}
            </span>
          ) : view.lockedAt ? (
            <span className="text-xs text-muted-foreground">
              {t('live.table.deadline', { when: new Date(view.lockedAt).toLocaleString() })}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('live.table.noDeadlineYet')}</span>
          )}

          {scored && (
            <span className="rounded bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-700 dark:text-green-400">
              {t('live.table.scored', {
                points: view.prediction!.points ?? 0,
                exact: view.prediction!.exactPositionPoints,
                band: view.prediction!.bandPoints,
              })}
            </span>
          )}
        </div>
      </div>

      {editable && !isGate && (
        <div className="mb-3 flex items-center gap-3">
          <button
            onClick={() => onSave(order)}
            disabled={!canSave || isSaving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {isSaving ? t('common.saving') : t('live.table.save')}
          </button>
          {savedAt && !error && (
            <span className="text-sm text-green-600 dark:text-green-400">{t('common.saved')}</span>
          )}
          {error && <span className="text-sm text-destructive">{error}</span>}
          {dirty && !isSaving && (
            <span className="text-xs text-muted-foreground">{t('live.table.unsaved')}</span>
          )}
        </div>
      )}

      <DndContext
        onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <ol className="grid gap-1">
          {order.map((teamId, index) => (
            <TableRow
              key={teamId}
              teamId={teamId}
              team={teamById.get(teamId) ?? null}
              position={index + 1}
              bandKey={bandDefForPosition(stageForBands as never, index + 1)?.key ?? null}
              editable={editable}
              isFirst={index === 0}
              isLast={index === order.length - 1}
              onMoveUp={() => reorder(index, index - 1)}
              onMoveDown={() => reorder(index, index + 1)}
              actualPosition={scored ? (actualPositionById.get(teamId) ?? null) : null}
              scored={scored}
              scoredBandKey={
                scored
                  ? (bandDefForPosition(
                      stageForBands as never,
                      actualPositionById.get(teamId) ?? 0,
                    )?.key ?? null)
                  : null
              }
            />
          ))}
        </ol>

        <DragOverlay>
          {dragging ? (
            <div className="rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-lg">
              {teamById.get(dragging)?.shortName ?? teamById.get(dragging)?.name ?? ''}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* A 36-row table pushes the top of the screen a long way up, so the gate keeps its
          one action within reach at the bottom rather than back where the list began. */}
      {editable && isGate && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-white/10 bg-black/70 px-4 py-3 backdrop-blur">
          <button
            onClick={() => onSave(order)}
            disabled={!canSave || isSaving}
            className="w-full rounded-md bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-white/90 disabled:opacity-40"
          >
            {isSaving ? t('common.saving') : t('live.table.submit')}
          </button>
          {error ? (
            <p className="mt-2 text-center text-sm text-destructive">{error}</p>
          ) : (
            <p className="mt-2 text-center text-xs text-white/60">{t('live.table.gateHint')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

interface RowProps {
  teamId: string;
  team: LiveTeam | null;
  position: number;
  bandKey: string | null;
  editable: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Where the team actually finished, once the table has been scored. */
  actualPosition: number | null;
  scored: boolean;
  scoredBandKey: string | null;
}

function TableRow({
  teamId,
  team,
  position,
  bandKey,
  editable,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  actualPosition,
  scored,
  scoredBandKey,
}: RowProps) {
  const { t } = useT();
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: teamId,
    disabled: !editable,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: teamId, disabled: !editable });

  const name = team?.shortName ?? team?.name ?? teamId;

  const exact = scored && actualPosition === position;
  const rightBand = scored && bandKey !== null && bandKey === scoredBandKey;

  return (
    <li
      ref={setDropRef}
      className={`flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 ${bandClasses(bandKey)} ${
        isOver ? 'ring-2 ring-primary' : ''
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
        {position}
      </span>

      {editable && (
        <button
          ref={setDragRef}
          style={{ transform: CSS.Translate.toString(transform) }}
          {...listeners}
          {...attributes}
          className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label={t('live.table.dragHandle', { team: name })}
        >
          <GripVertical size={16} />
        </button>
      )}

      {team?.crestUrl ? (
        <img src={team.crestUrl} alt="" aria-hidden className="h-5 w-5 shrink-0 object-contain" />
      ) : (
        <span className="h-5 w-5 shrink-0 rounded-full bg-muted" aria-hidden />
      )}

      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>

      {scored && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {actualPosition !== null
            ? t('live.table.finished', { position: actualPosition })
            : t('live.table.noFinish')}
          {exact ? ' ✓' : rightBand ? ' ~' : ''}
        </span>
      )}

      {editable && (
        <span className="flex shrink-0 items-center">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label={t('live.table.moveUp', { team: name })}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <ChevronUp size={15} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            aria-label={t('live.table.moveDown', { team: name })}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown size={15} />
          </button>
        </span>
      )}
    </li>
  );
}
