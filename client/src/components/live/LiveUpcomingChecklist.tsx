import { CheckCircle2, ChevronRight, ClipboardList, Clock, HelpCircle, ListOrdered, Trophy } from 'lucide-react';
import { useT } from '@/lib/useT';

// ── Before the first kickoff ──────────────────────────────────────────────────
//
// The three predictions that close at the first whistle and never reopen: the final table,
// the top-scorer ranking and the bonus questions. Everything else in a live competition can
// be done match by match all season; these cannot, and a member who misses them has lost
// the points before the season has started.
//
// So they are put at the top of the fixtures tab — the page everybody lands on — for as
// long as they are still open, as tiles that say what is done and what is not and take one
// press to reach.
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

const ICONS: Record<ChecklistKey, typeof ListOrdered> = {
  table: ListOrdered,
  scorers: Trophy,
  bonus: HelpCircle,
};

export default function LiveUpcomingChecklist({ items, deadline, onOpen }: Props) {
  const { t } = useT();
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

      <div className="grid gap-2 px-4 pb-4 sm:grid-cols-3">
        {items.map(item => {
          const Icon = ICONS[item.key];
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onOpen(item.key)}
              className={`group flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:shadow-sm ${
                item.done
                  ? 'border-border bg-background hover:border-foreground/20'
                  : // Outstanding tiles carry the colour: this is the one thing on the page
                    // that is about to become impossible.
                    'border-amber-400/60 bg-background hover:border-amber-500 hover:bg-amber-400/5'
              }`}
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  item.done
                    ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                    : 'bg-amber-400/20 text-amber-700 dark:text-amber-300'
                }`}
              >
                {item.done ? <CheckCircle2 size={18} /> : <Icon size={18} />}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-tight">
                  {t(`live.checklist.items.${item.key}`)}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {item.detail ?? (item.done ? t('live.checklist.done') : t('live.checklist.todo'))}
                </span>
              </span>

              <ChevronRight
                size={16}
                aria-hidden
                className="shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
