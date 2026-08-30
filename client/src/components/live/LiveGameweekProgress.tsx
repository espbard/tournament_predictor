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

export type LiveGameweekState = 'empty' | 'partial' | 'complete';

export interface LiveGameweekProgressItem {
  matchday: number;
  state: LiveGameweekState;
  /** Selected matches in this gameweek, and how many the viewer has predicted. */
  selected: number;
  predicted: number;
}

interface Props {
  items: LiveGameweekProgressItem[];
  current: number | null;
  onSelect: (matchday: number) => void;
}

const DOT_CLASS: Record<LiveGameweekState, string> = {
  empty: 'bg-muted-foreground/30',
  partial: 'bg-amber-500',
  complete: 'bg-green-600 dark:bg-green-500',
};

export default function LiveGameweekProgress({ items, current, onSelect }: Props) {
  const { t } = useT();
  if (items.length === 0) return null;

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
                aria-label={t(`live.gameweekDot.${item.state}`, {
                  matchday: item.matchday,
                  predicted: item.predicted,
                  selected: item.selected,
                })}
                title={t(`live.gameweekDot.${item.state}`, {
                  matchday: item.matchday,
                  predicted: item.predicted,
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
