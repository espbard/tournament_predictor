import { UserAvatar } from '@/components/UserAvatar';
import { useT } from '@/lib/useT';
import type { LivePredictor } from '@/lib/liveApi';

// ── "See what others predicted" ───────────────────────────────────────────────
//
// A horizontally scrolling strip of everybody who has made a season-long prediction — the
// top-scorer ranking or the league table, whichever tab it sits on. Picking a face swaps
// whose prediction the comparison below shows; the viewer's own face (first, and labelled
// "You") swaps back. A spectator of a public competition has no prediction of their own,
// so for them the strip is simply everybody and the heading drops the "other".

interface Props {
  predictors: LivePredictor[];
  /** Whose prediction is on screen. */
  selectedUserId: string | null;
  onSelect: (userId: string) => void;
  /** The viewer, when they can have a prediction of their own; null for a spectator. */
  viewerId: string | null;
  /** What is being picked between, which only changes the heading. */
  kind?: 'predictions' | 'answers';
}

export default function LivePredictorPicker({
  predictors,
  selectedUserId,
  onSelect,
  viewerId,
  kind = 'predictions',
}: Props) {
  const { t } = useT();
  const mine = viewerId ? predictors.find(p => p.userId === viewerId) : undefined;
  const others = predictors.filter(p => p.userId !== viewerId);
  if (others.length === 0) return null;
  const ordered = mine ? [mine, ...others] : others;

  return (
    <section className="mb-4 rounded-lg border p-3">
      <h3 className="mb-2 text-sm font-semibold">
        {kind === 'answers'
          ? t(viewerId ? 'live.predictorPicker.seeOthersAnswers' : 'live.predictorPicker.seeUsersAnswers')
          : t(viewerId ? 'live.predictorPicker.seeOthers' : 'live.predictorPicker.seeUsers')}
      </h3>
      {/* Negative margin + padding lets the row scroll edge to edge inside the card while
          the rings on the first and last avatar are not clipped. */}
      <ul className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-1 pt-1">
        {ordered.map(p => {
          const selected = p.userId === selectedUserId;
          const label = p.userId === viewerId ? t('live.predictorPicker.you') : p.username;
          return (
            <li key={p.userId} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(p.userId)}
                aria-pressed={selected}
                className="flex w-14 flex-col items-center gap-1 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <UserAvatar
                  username={p.username}
                  imageUrl={p.imageUrl}
                  iconColor={p.iconColor}
                  resizeWidth={96}
                  className={`h-10 w-10 transition-opacity ${
                    selected
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                      : 'opacity-70 hover:opacity-100'
                  }`}
                />
                <span
                  className={`w-full truncate text-center text-[11px] ${
                    selected ? 'font-semibold text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
