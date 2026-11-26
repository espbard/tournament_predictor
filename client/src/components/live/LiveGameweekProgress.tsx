import { Fragment } from 'react';
import { Star } from 'lucide-react';
import { useT } from '@/lib/useT';

// ── Gameweek progress ─────────────────────────────────────────────────────────
//
// One dot per round of the whole competition, in order — the league phase's gameweeks,
// then each knockout leg, then the final — replacing the stage tabs and the dropdown that
// used to pick between them. A thin divider marks where one stage gives way to the next.
// The dots also say how far through the season you are and, at a glance, which rounds
// still want a prediction.
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
  /** Unique across the strip: stage and matchday together. See liveRoundKey. */
  key: string;
  stageKey: string;
  matchday: number;
  /** What the round is called in the dot's label: "Gameweek 3", "Round of 16: 1st leg". */
  label: string;
  /**
   * Drawn as a trophy instead of a dot — the final, the round the whole competition leads
   * to. Coloured by the same three states, like a bonus round's star.
   */
  trophy?: boolean;
  state: LiveGameweekState;
  /**
   * Selected matches in this round, and how many of them are done — predicted by the
   * viewer, or in results mode, played.
   */
  selected: number;
  done: number;
}

/**
 * A bonus round placed in the strip after the dot `afterKey` (null: before the first).
 * Drawn as a star rather than a dot, so it reads as something other than a round without
 * relying on colour; the colour follows the same three states.
 */
export interface LiveBonusStripItem {
  id: string;
  name: string;
  afterKey: string | null;
  state: LiveGameweekState;
  selected: number;
  done: number;
}

interface Props {
  items: LiveGameweekProgressItem[];
  /** The key of the round being shown. */
  current: string | null;
  onSelect: (item: LiveGameweekProgressItem) => void;
  /** What a dot counts: the viewer's predictions (default) or the matches' results. */
  mode?: 'predictions' | 'results';
  bonus?: LiveBonusStripItem[];
  /** The bonus round being shown, if any. While set, no round is current. */
  currentBonusId?: string | null;
  onSelectBonus?: (id: string) => void;
}

const STAR_CLASS: Record<LiveGameweekState, string> = {
  empty: 'text-muted-foreground/50',
  partial: 'text-amber-500',
  complete: 'text-green-600 dark:text-green-500',
};

/**
 * The final's marker: a solid trophy silhouette in the dot's own colours, the way a bonus
 * round is a solid star. Drawn by hand rather than taken from the icon set, whose trophy
 * is an outline and reads as a different kind of thing from the filled dots beside it.
 */
function TrophySilhouette({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      {/* Cup */}
      <path d="M6 3h12v5a6 6 0 0 1-12 0z" />
      {/* Handles */}
      <path
        d="M6 5H4.5a2.5 2.5 0 0 0 0 5H6.5M18 5h1.5a2.5 2.5 0 0 1 0 5H17.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Stem and base */}
      <rect x="10.5" y="13" width="3" height="5" />
      <rect x="6.5" y="18" width="11" height="3.5" rx="1" />
    </svg>
  );
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
  bonus = [],
  currentBonusId = null,
  onSelectBonus,
}: Props) {
  const { t } = useT();
  if (items.length === 0 && bonus.length === 0) return null;
  const labelBase = mode === 'results' ? 'live.gameweekDotResults' : 'live.gameweekDot';

  const renderStars = (stars: LiveBonusStripItem[]) =>
    stars.map(b => {
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
  const starsAfter = (afterKey: string | null) => renderStars(bonus.filter(b => b.afterKey === afterKey));

  // A star whose dot is not on the strip any more goes at the end rather than vanishing.
  const keys = new Set(items.map(i => i.key));
  const strays = bonus.filter(b => b.afterKey !== null && !keys.has(b.afterKey));

  return (
    <div className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5" aria-label={t('live.gameweekProgress')}>
        {starsAfter(null)}
        {items.map((item, index) => {
          const isCurrent = currentBonusId === null && item.key === current;
          const label = t(`${labelBase}.${item.state}`, {
            round: item.label,
            predicted: item.done,
            done: item.done,
            selected: item.selected,
          });
          const newStage = index > 0 && items[index - 1].stageKey !== item.stageKey;
          return (
            <Fragment key={item.key}>
              {newStage && <li aria-hidden className="mx-1 h-4 w-px bg-border" />}
              <li>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  aria-current={isCurrent ? 'true' : undefined}
                  // The count is in the label rather than only the colour, so the state is
                  // not carried by hue alone.
                  aria-label={label}
                  title={label}
                  className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isCurrent ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''
                  }`}
                >
                  {item.trophy ? (
                    <TrophySilhouette className={`h-[18px] w-[18px] ${STAR_CLASS[item.state]}`} />
                  ) : (
                    <span className={`block h-3 w-3 rounded-full ${DOT_CLASS[item.state]}`} />
                  )}
                </button>
              </li>
              {starsAfter(item.key)}
            </Fragment>
          );
        })}
        {renderStars(strays)}
      </ol>
    </div>
  );
}
