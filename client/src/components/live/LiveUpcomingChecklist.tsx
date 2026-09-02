import { Check, CheckCircle2, ChevronRight, ClipboardList, Clock } from 'lucide-react';
import { useT } from '@/lib/useT';

// ── Before the first kickoff, and every round after ───────────────────────────
//
// Four things a member can be behind on. Three of them — the final table, the top-scorer
// ranking and the bonus questions — close at the first whistle and never reopen, so a
// member who misses them has lost the points before the season has started. The fourth,
// the next round of fixtures, comes back round every gameweek.
//
// That split is what decides how this renders, and it needs no prop to say so: while the
// season-long three are still open the panel is a row of picture tiles at the top of the
// fixtures tab, because there is a deadline coming that makes all of it urgent at once.
// Once they have locked only the round is left, and the same nudge every week would cost
// more vertical space than it is worth — so it collapses to a single line above the
// matches.
//
// The tiles stay up once everything is ticked rather than vanishing: until the deadline
// these are still editable, and "you can change these until Tuesday" is worth as much as
// the nudge was. The panel only leaves when there is nothing left open at all.

export type ChecklistKey = 'table' | 'scorers' | 'bonus' | 'round';

export interface ChecklistItem {
  key: ChecklistKey;
  done: boolean;
  /** A word on where it stands — "2 of 5 answered". Optional. */
  detail?: string | null;
}

interface Props {
  items: ChecklistItem[];
  /** When the season-long three close, or null when no fixture has a date yet. */
  deadline: string | null;
  onOpen: (key: ChecklistKey) => void;
}

// The artwork is the same in both themes, so every tile carries its own dark scrim and
// white type rather than borrowing the page's colours.
const IMAGES: Record<ChecklistKey, string> = {
  table: '/checklist-table.webp',
  scorers: '/checklist-scorers.webp',
  bonus: '/checklist-bonus.webp',
  round: '/checklist-round.webp',
};

// Two across on a phone: four tiles in one row leaves about 70px of label, which not one
// of the three locales fits.
const COLUMNS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
};

export default function LiveUpcomingChecklist({ items, deadline, onOpen }: Props) {
  const { t, language } = useT();
  if (items.length === 0) return null;

  // The season-long three have locked and only the recurring round is left, so the whole
  // panel becomes one line.
  if (items.length === 1 && items[0].key === 'round') {
    const item = items[0];
    return (
      <button
        type="button"
        onClick={() => onOpen('round')}
        className={`mb-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
          item.done
            ? 'border-border bg-muted/30 hover:bg-muted/50'
            : 'border-amber-400/60 bg-amber-400/[0.07] hover:bg-amber-400/[0.12]'
        }`}
      >
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${item.done ? 'bg-green-500' : 'bg-amber-400'}`}
        />
        <span className="truncate text-sm font-medium">{t('live.checklist.items.round')}</span>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {item.detail ?? (item.done ? t('live.checklist.done') : t('live.checklist.todo'))}
        </span>
        <ChevronRight size={15} aria-hidden className="shrink-0 text-muted-foreground/50" />
      </button>
    );
  }

  const outstanding = items.filter(item => !item.done).length;
  const allDone = outstanding === 0;

  return (
    <section
      className={`mb-5 overflow-hidden rounded-xl border ${
        allDone ? 'border-border bg-muted/30' : 'border-amber-400/60 bg-amber-400/[0.07]'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <h2 className="flex items-center gap-2 font-semibold">
          {allDone ? (
            <CheckCircle2 size={18} className="shrink-0 text-green-600 dark:text-green-400" />
          ) : (
            <ClipboardList size={18} className="shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          {allDone ? t('live.checklist.titleDone') : t('live.checklist.title')}
        </h2>

        {/* The deadline is the whole reason this panel exists, so it is never more than a
            glance away from the heading. */}
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock size={13} className="shrink-0" />
          {deadline
            ? t('live.checklist.deadline', {
                when: new Date(deadline).toLocaleString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })
            : t('live.checklist.noDeadlineYet')}
        </span>
      </div>

      <p className="px-4 pb-3 pt-1 text-sm text-muted-foreground">
        {allDone ? t('live.checklist.subtitleDone') : t('live.checklist.subtitle', { count: outstanding })}
      </p>

      <div className={`grid gap-2 px-4 pb-4 ${COLUMNS[items.length] ?? 'grid-cols-2 sm:grid-cols-4'}`}>
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            onClick={() => onOpen(item.key)}
            className={`group relative flex min-h-[7.5rem] flex-col justify-end overflow-hidden rounded-lg border text-left transition-shadow hover:shadow-md sm:min-h-[8.5rem] ${
              item.done
                ? 'border-border'
                : // Outstanding tiles carry the colour: this is the one thing on the page
                  // that is about to become impossible.
                  'border-amber-400/70'
            }`}
          >
            <span
              aria-hidden
              className="absolute inset-0 bg-cover bg-center transition-transform duration-300 group-hover:scale-105"
              style={{ backgroundImage: `url(${IMAGES[item.key]})` }}
            />
            {/* Dark at the foot where the label sits, lighter at the head where the picture
                is worth seeing. Done tiles sit further back so the outstanding ones lead. */}
            <span
              aria-hidden
              className={`absolute inset-0 bg-gradient-to-t from-black via-black/70 via-45% to-black/25 ${
                item.done ? 'opacity-100' : 'opacity-90'
              }`}
            />

            <span
              aria-hidden
              className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-black/30 ${
                item.done ? 'bg-green-500 text-white' : 'bg-amber-400'
              }`}
            >
              {item.done ? <Check size={12} strokeWidth={3} /> : <span className="h-1.5 w-1.5 rounded-full bg-black/60" />}
            </span>

            <span className="relative px-1.5 pb-1.5 sm:px-2 sm:pb-2">
              <span
                lang={language}
                className="block hyphens-auto break-words text-[0.7rem] font-semibold leading-tight text-white drop-shadow sm:text-[0.8rem]"
              >
                {t(`live.checklist.items.${item.key}`)}
              </span>
              <span className="mt-0.5 block break-words text-[0.65rem] leading-tight text-white/80 sm:text-[0.7rem]">
                {item.detail ?? (item.done ? t('live.checklist.done') : t('live.checklist.todo'))}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
