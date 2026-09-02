import { Check, CheckCircle2, ClipboardList, Clock } from 'lucide-react';
import { useT } from '@/lib/useT';

// ── Before the first kickoff ──────────────────────────────────────────────────
//
// The three predictions that close at the first whistle and never reopen: the final table,
// the top-scorer ranking and the bonus questions. Everything else in a live competition can
// be done match by match all season; these cannot, and a member who misses them has lost
// the points before the season has started.
//
// So they are put at the top of the fixtures tab — the page everybody lands on — for as
// long as they are still open, as a row of picture tiles that say what is done and what is
// not and take one press to reach. The row keeps its three columns on a phone: the whole
// point is that the three of them are seen together, as one short list with an end to it.
//
// It stays up once everything is ticked rather than vanishing: until the deadline these are
// still editable, and "you can change these until Tuesday" is worth as much as the nudge
// was. The panel only leaves when the deadline does.

export type ChecklistKey = 'table' | 'scorers' | 'bonus';

export interface ChecklistItem {
  key: ChecklistKey;
  done: boolean;
  /** A word on where it stands — "2 of 5 answered". Optional. */
  detail?: string | null;
}

interface Props {
  items: ChecklistItem[];
  /** When these close, or null when no fixture has a date yet. */
  deadline: string | null;
  onOpen: (key: ChecklistKey) => void;
}

// The artwork is the same in both themes, so every tile carries its own dark scrim and
// white type rather than borrowing the page's colours.
const IMAGES: Record<ChecklistKey, string> = {
  table: '/checklist-table.webp',
  scorers: '/checklist-scorers.webp',
  bonus: '/checklist-bonus.webp',
};

export default function LiveUpcomingChecklist({ items, deadline, onOpen }: Props) {
  const { t, language } = useT();
  if (items.length === 0) return null;

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

      <div className="grid grid-cols-3 gap-2 px-4 pb-4">
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
