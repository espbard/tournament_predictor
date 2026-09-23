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

interface Props {
  items: LiveGameweekProgressItem[];
  current: number | null;
  onSelect: (matchday: number) => void;
  /** What a dot counts: the viewer's predictions (default) or the matches' results. */
  mode?: 'predictions' | 'results';
}

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
}: Props) {
  const { t } = useT();
  if (items.length === 0) return null;
  const labelBase = mode === 'results' ? 'live.gameweekDotResults' : 'live.gameweekDot';

  return (
    <div className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5" aria-label={t('live.gameweekProgress')}>
        {items.map(item => {
          const isCurrent = item.matchday === current;
          return (
            <li key={item.matchday}>
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
          );
        })}
      </ol>
    </div>
  );
}
