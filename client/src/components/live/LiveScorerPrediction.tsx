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
import type { LivePlayer } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import { initialOrder, moveItem } from '@/lib/liveTableOrder';
import type { LiveScorerPredictionView } from '@/lib/liveApi';

// ── Top-scorer ranking ────────────────────────────────────────────────────────
//
// Order the admin's shortlist by how many goals each player will finish the tournament
// on. Every player in exactly the right final position scores; there are no bands, so
// close is worth nothing.
//
// Reordering works three ways for the same reason the table prediction does: drag, the
// up/down buttons, and a keyboard through those buttons.
//
// Goals and assists are shown on every row throughout, because assists are what break a
// tie on goals — a ranking that reordered itself on a number the user could not see would
// look arbitrary.

interface Props {
  view: Extract<LiveScorerPredictionView, { available: true }>;
  onSave: (orderedPlayerIds: string[]) => void;
  isSaving: boolean;
  savedAt: number | null;
  error: string | null;
  /**
   * 'gate' is the full-screen first-run version, shown to a member who has not ranked
   * yet: the save control moves to a pinned bar at the foot of the screen, and the order
   * on screen counts as a submission even if nothing is dragged.
   */
  variant?: 'default' | 'gate';
  /** Withdraw the ranking, sending the member back to the gate to build it again. */
  onClear?: () => void;
  isClearing?: boolean;
  clearError?: string | null;
  /** Show somebody else's ranking without offering to change it. */
  readOnly?: boolean;
}

export default function LiveScorerPrediction({
  view,
  onSave,
  isSaving,
  savedAt,
  error,
  variant = 'default',
  onClear,
  isClearing = false,
  clearError = null,
  readOnly = false,
}: Props) {
  const { t } = useT();
  const playerById = useMemo(
    () => new Map(view.players.map(player => [player.id, player])),
    [view.players],
  );

  const [order, setOrder] = useState<string[]>(() =>
    initialOrder(view.prediction?.orderedPlayerIds ?? null, view.currentOrder, view.players),
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Adopt an order arriving later (a refetch, or another device) — but never on top of
  // edits in progress.
  useEffect(() => {
    if (touched) return;
    setOrder(initialOrder(view.prediction?.orderedPlayerIds ?? null, view.currentOrder, view.players));
  }, [view.prediction, view.currentOrder, view.players, touched]);

  const editable = !readOnly && !view.isLocked;
  const isGate = variant === 'gate';

  // Points are withheld until the tournament is completed, so a stored `points` is what
  // says this has been scored — the same test the table prediction uses.
  const scored = view.prediction?.points != null;

  // Where each player stands right now. Shown only once scored: while the season runs it
  // is the live ranking, which is interesting, but it is not where anybody "finished".
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
    (!view.prediction || view.prediction.orderedPlayerIds.join(',') !== order.join(','));

  // In the gate the order on screen is already a valid ranking, so accepting it untouched
  // has to be possible — otherwise somebody who agrees with it cannot get past.
  const canSave = isGate ? order.length > 0 : dirty;
  const canClear = !!onClear && !isGate && !readOnly && !view.isLocked && !!view.prediction;

  return (
    <div>
      <div className="mb-4 rounded-lg border p-4">
        {!isGate && <h2 className="font-semibold">{t('live.scorers.title')}</h2>}
        <p className={`text-sm text-muted-foreground${isGate ? '' : ' mt-1'}`}>
          {t('live.scorers.explainer', { exact: view.scoringConfig.scorer_exact_position })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{t('live.scorers.tieBreak')}</p>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {view.isLocked ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock size={12} />
              {t('live.scorers.locked')}
            </span>
          ) : view.lockedAt ? (
            <span className="text-xs text-muted-foreground">
              {t('live.scorers.deadline', { when: new Date(view.lockedAt).toLocaleString() })}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('live.scorers.noDeadlineYet')}</span>
          )}

          {scored ? (
            <span className="rounded bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-700 dark:text-green-400">
              {t('live.scorers.scored', { points: view.prediction!.points ?? 0 })}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('live.scorers.pointsAtEnd')}</span>
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
            {isSaving ? t('common.saving') : t('live.scorers.save')}
          </button>
          {savedAt && !error && (
            <span className="text-sm text-green-600 dark:text-green-400">{t('common.saved')}</span>
          )}
          {error && <span className="text-sm text-destructive">{error}</span>}
          {dirty && !isSaving && (
            <span className="text-xs text-muted-foreground">{t('live.scorers.unsaved')}</span>
          )}
          {canClear && (
            <button
              onClick={() => setShowClearConfirm(true)}
              className="ml-auto rounded border border-destructive/30 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/5"
            >
              {t('live.scorers.clear')}
            </button>
          )}
        </div>
      )}

      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-xl">
            <p className="mb-1 font-semibold">{t('live.scorers.clearConfirm.title')}</p>
            <p className="mb-6 text-sm text-muted-foreground">{t('live.scorers.clearConfirm.body')}</p>
            {clearError && <p className="mb-4 text-sm text-destructive">{clearError}</p>}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                disabled={isClearing}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => onClear?.()}
                disabled={isClearing}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {isClearing
                  ? t('live.scorers.clearConfirm.clearing')
                  : t('live.scorers.clearConfirm.clear')}
              </button>
            </div>
          </div>
        </div>
      )}

      <DndContext
        onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <ol className="grid gap-1">
          {order.map((playerId, index) => (
            <ScorerRow
              key={playerId}
              playerId={playerId}
              player={playerById.get(playerId) ?? null}
              position={index + 1}
              editable={editable}
              isFirst={index === 0}
              isLast={index === order.length - 1}
              onMoveUp={() => reorder(index, index - 1)}
              onMoveDown={() => reorder(index, index + 1)}
              actualPosition={scored ? (actualPositionById.get(playerId) ?? null) : null}
              scored={scored}
            />
          ))}
        </ol>

        <DragOverlay>
          {dragging ? (
            <div className="rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-lg">
              {playerById.get(dragging)?.name ?? ''}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {editable && isGate && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-white/10 bg-black/70 px-4 py-3 backdrop-blur">
          <button
            onClick={() => onSave(order)}
            disabled={!canSave || isSaving}
            className="w-full rounded-md bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-white/90 disabled:opacity-40"
          >
            {isSaving ? t('common.saving') : t('live.scorers.submit')}
          </button>
          {error ? (
            <p className="mt-2 text-center text-sm text-destructive">{error}</p>
          ) : (
            <p className="mt-2 text-center text-xs text-white/60">{t('live.scorers.gateHint')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

interface RowProps {
  playerId: string;
  player: LivePlayer | null;
  position: number;
  editable: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Where the player actually finished, once the ranking has been scored. */
  actualPosition: number | null;
  scored: boolean;
}

function ScorerRow({
  playerId,
  player,
  position,
  editable,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  actualPosition,
  scored,
}: RowProps) {
  const { t } = useT();
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: playerId,
    disabled: !editable,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: playerId, disabled: !editable });

  const name = player?.name ?? playerId;
  const exact = scored && actualPosition === position;

  return (
    <li
      ref={setDropRef}
      className={`flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 ${
        isOver ? 'ring-2 ring-primary' : ''
      } ${isDragging ? 'opacity-40' : ''} ${exact ? 'border-green-500/60 bg-green-500/5' : ''}`}
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
          aria-label={t('live.scorers.dragHandle', { player: name })}
        >
          <GripVertical size={16} />
        </button>
      )}

      {player?.imageUrl ? (
        <img
          src={player.imageUrl}
          alt=""
          aria-hidden
          className="h-7 w-7 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="h-7 w-7 shrink-0 rounded-full bg-muted" aria-hidden />
      )}

      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>

      {/* Goals first and assists after, in the order the tie-break reads them. */}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {t('live.scorers.tally', { goals: player?.goals ?? 0, assists: player?.assists ?? 0 })}
      </span>

      {scored && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {actualPosition !== null
            ? t('live.scorers.finished', { position: actualPosition })
            : t('live.scorers.noFinish')}
          {exact ? ' ✓' : ''}
        </span>
      )}

      {editable && (
        <span className="flex shrink-0 items-center">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label={t('live.scorers.moveUp', { player: name })}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <ChevronUp size={15} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            aria-label={t('live.scorers.moveDown', { player: name })}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown size={15} />
          </button>
        </span>
      )}
    </li>
  );
}
