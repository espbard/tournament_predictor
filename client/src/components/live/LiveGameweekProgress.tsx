import { Fragment } from 'react';
import { Star } from 'lucide-react';
import { useT } from '@/lib/useT';

// ── Gameweek progress ─────────────────────────────────────────────────────────
//
// One dot per gameweek of a stage, in order, replacing the dropdown that used to pick
// between them. The dropdown said which gameweek you were on; the dots also say how far
// through the season you are and, at a glance, which weeks still want a prediction.
//
//   grey    nothing selected — the admin has not picked this week's matches yet, so
//           there is nothing to predict and nothing owed
//   yellow  matches to predict, and at least one still without a score from you
//   green   every selected match of that week has your prediction
//
// A locked match you never predicted keeps its week yellow: the dot reports what is
// predicted, not what could still be, and quietly turning green on a deadline you missed
// would be a lie.
//
// A spectator of a public competition predicts nothing, so for them (`mode="results"`)
// the same three colours track the matches instead: yellow while any selected match of the
// week is still without a result, green once all of them have one.

export type LiveGameweekState = 'empty' | 'partial' | 'complete';

export interface LiveGameweekProgressItem {
  matchday: number;
  state: LiveGameweekState;
  /**
   * Selected matches in this gameweek, and how many of them are done — predicted by the
   * viewer, or in results mode, played.
   */
  selected: number;
  done: number;
}

/**
 * A bonus round placed in the strip after gameweek `afterMatchday` (0: before the first).
 * Drawn as a star rather than a dot, so it reads as something other than a gameweek
 * without relying on colour; the colour follows the same three states.
 */
export interface LiveBonusStripItem {
  id: string;
  name: string;
  afterMatchday: number;
  state: LiveGameweekState;
  selected: number;
  done: number;
}

interface Props {
  items: LiveGameweekProgressItem[];
  current: number | null;
  onSelect: (matchday: number) => void;
  /** What a dot counts: the viewer's predictions (default) or the matches' results. */
  mode?: 'predictions' | 'results';
  bonus?: LiveBonusStripItem[];
  /** The bonus round being shown, if any. While set, no gameweek is current. */
  currentBonusId?: string | null;
  onSelectBonus?: (id: string) => void;
}

const STAR_CLASS: Record<LiveGameweekState, string> = {
  empty: 'text-muted-foreground/50',
  partial: 'text-amber-500',
  complete: 'text-green-600 dark:text-green-500',
};

const DOT_CLASS: Record<LiveGameweekState, string> = {
  empty: 'bg-muted-foreground/30',
  partial: 'bg-amber-500',
  complete: 'bg-green-600 dark:bg-green-500',
};

export default function LiveGameweekProgress({
  items,
  current,
  onSelect,
  mode = 'predictions',
  bonus = [],
  currentBonusId = null,
  onSelectBonus,
}: Props) {
  const { t } = useT();
  if (items.length === 0) return null;
  const labelBase = mode === 'results' ? 'live.gameweekDotResults' : 'live.gameweekDot';

  const starsAfter = (matchday: number) =>
    bonus
      .filter(b => b.afterMatchday === matchday)
      .map(b => {
        const label = t('live.bonusRounds.dot', {
          name: b.name,
          done: b.done,
          selected: b.selected,
        });
        const isCurrent = b.id === currentBonusId;
        return (
          <li key={`bonus-${b.id}`}>
            <button
              type="button"
              onClick={() => onSelectBonus?.(b.id)}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={label}
              title={label}
              className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isCurrent ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''
              }`}
            >
              <Star className={`h-4 w-4 fill-current ${STAR_CLASS[b.state]}`} aria-hidden />
            </button>
          </li>
        );
      });

  return (
    <div className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5" aria-label={t('live.gameweekProgress')}>
        {starsAfter(0)}
        {items.map(item => {
          const isCurrent = currentBonusId === null && item.matchday === current;
          return (
            <Fragment key={item.matchday}>
            <li>
              <button
                type="button"
                onClick={() => onSelect(item.matchday)}
                aria-current={isCurrent ? 'true' : undefined}
                // The count is in the label rather than only the colour, so the state is
                // not carried by hue alone.
                aria-label={t(`${labelBase}.${item.state}`, {
                  matchday: item.matchday,
                  predicted: item.done,
                  done: item.done,
                  selected: item.selected,
                })}
                title={t(`${labelBase}.${item.state}`, {
                  matchday: item.matchday,
                  predicted: item.done,
                  done: item.done,
                  selected: item.selected,
                })}
                className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isCurrent ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''
                }`}
              >
                <span className={`block h-3 w-3 rounded-full ${DOT_CLASS[item.state]}`} />
              </button>
            </li>
            {starsAfter(item.matchday)}
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}
