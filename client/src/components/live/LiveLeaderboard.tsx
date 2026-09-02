import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '@/lib/useT';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuthStore } from '@/store/authStore';
import type { LiveLeaderboardRow } from '@/lib/liveApi';

// ── Live competition leaderboard ──────────────────────────────────────────────
//
// A straight read of the denormalised columns on live_competition_members: one column per
// way of earning a point, in the order they are earned over a season, then the total.
//
// Eight columns of numbers and a list of names have to fit a phone, so the headings shrink
// to a letter or two there and the names are given only as much room as is left. Nothing
// is dropped at any width — a leaderboard that hides a column on a phone is a leaderboard
// that cannot be read on the device most people open it on.
//
// A letter is not self-explanatory, and a phone cannot hover to find out. So the headings
// are buttons: pressing one names it above the table. Desktop keeps the `title` tooltip as
// well, since that costs nothing.
//
// Every column is always shown, zeros included. They were once hidden until somebody had
// scored in them, which spared a little noise but meant the table silently changed shape
// mid-season and gave no answer to "what else can I score for?" — which is most of what a
// leaderboard is read for before the points arrive.
//
// Highlight is the extra from multiplied matches, and it is deliberately the only place
// that extra appears: the three tiers hold what each prediction earned at face value, so
// they stay comparable between members whatever the admin has chosen to highlight.

interface Props {
  rows: LiveLeaderboardRow[];
  competitionId: string;
}

/**
 * The point sources, in the order a season earns them.
 *
 * Each has three labels: a letter or two for phones, an abbreviation for wider screens,
 * and a sentence for the press-to-reveal caption and the desktop tooltip.
 */
const COLUMNS = [
  { key: 'result', get: (r: LiveLeaderboardRow) => r.breakdown.correctOutcomePoints },
  { key: 'goalDifference', get: (r: LiveLeaderboardRow) => r.breakdown.correctGoalDifferencePoints },
  { key: 'exact', get: (r: LiveLeaderboardRow) => r.breakdown.exactScorePoints },
  { key: 'highlight', get: (r: LiveLeaderboardRow) => r.breakdown.multiplierBonusPoints },
  { key: 'table', get: (r: LiveLeaderboardRow) => r.breakdown.tablePoints },
  { key: 'scorers', get: (r: LiveLeaderboardRow) => r.breakdown.scorerPoints },
  { key: 'bonus', get: (r: LiveLeaderboardRow) => r.breakdown.bonusPoints },
] as const;

export default function LiveLeaderboard({ rows, competitionId }: Props) {
  const { t } = useT();
  const { user } = useAuthStore();

  // Which heading was last pressed, i.e. what the caption is naming. Pressing it again
  // puts the caption away.
  const [namedColumn, setNamedColumn] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('live.noMembers')}
      </p>
    );
  }

  const headingClass =
    'w-full px-0.5 py-2 text-center text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:text-xs';

  return (
    <div>
      {/* Above the table rather than in it: the table can scroll sideways on a very narrow
          phone, and a caption inside it would scroll out of sight with the column. One
          line is reserved so the usual case does not nudge the rows; a description long
          enough to wrap does move them, which is ordinary for something that opens on a
          tap and is not worth a permanent band of empty space to avoid. */}
      <p
        role="status"
        aria-live="polite"
        className="mb-1 min-h-[1.25rem] text-xs text-muted-foreground"
      >
        {namedColumn ? t(`live.leaderboard.${namedColumn === 'total' ? 'totalFull' : namedColumn}`) : ''}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="w-6 py-2 pl-0.5 text-[10px] font-medium text-muted-foreground sm:w-10 sm:pl-2 sm:text-xs">
                #
              </th>
              <th className="py-2 text-[10px] font-medium text-muted-foreground sm:text-xs">
                {t('live.leaderboard.player')}
              </th>
              {COLUMNS.map(column => (
                <th key={column.key} className="w-6 p-0 sm:w-14">
                  <button
                    type="button"
                    onClick={() => setNamedColumn(prev => (prev === column.key ? null : column.key))}
                    title={t(`live.leaderboard.${column.key}`)}
                    aria-label={t(`live.leaderboard.${column.key}`)}
                    className={headingClass}
                  >
                    {/* One label or the other, never both: hiding one with CSS keeps the
                        column width honest at each size without measuring anything. */}
                    <span className="sm:hidden">{t(`live.leaderboard.${column.key}Micro`)}</span>
                    <span className="hidden sm:inline">
                      {t(`live.leaderboard.${column.key}Short`)}
                    </span>
                  </button>
                </th>
              ))}
              <th className="w-8 p-0 pr-0.5 sm:w-16 sm:pr-2">
                <button
                  type="button"
                  onClick={() => setNamedColumn(prev => (prev === 'total' ? null : 'total'))}
                  title={t('live.leaderboard.totalFull')}
                  aria-label={t('live.leaderboard.totalFull')}
                  className={`${headingClass} text-right`}
                >
                  <span className="sm:hidden">{t('live.leaderboard.totalMicro')}</span>
                  <span className="hidden sm:inline">{t('live.leaderboard.total')}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const isMe = row.userId === user?.id;
              return (
                <tr
                  key={row.userId}
                  className={`border-b last:border-0 ${isMe ? 'bg-primary/5 font-medium' : ''}`}
                >
                  <td className="py-2 pl-0.5 text-xs tabular-nums sm:pl-2 sm:text-sm">{row.rank}</td>
                  {/* The names get whatever the numbers leave. Under table-fixed that is
                      a real width rather than a suggestion, so a long name truncates
                      instead of shoving the columns off the screen. */}
                  <td className="py-2 pr-1 sm:pr-2">
                    <Link
                      to={`/live/competitions/${competitionId}/predictions/${row.userId}`}
                      className="flex min-w-0 items-center gap-1.5 transition-opacity hover:opacity-80 sm:gap-2"
                    >
                      <UserAvatar
                        username={row.username}
                        imageUrl={row.imageUrl}
                        iconColor={row.iconColor}
                        className="h-5 w-5 shrink-0 text-[10px] sm:h-7 sm:w-7 sm:text-sm"
                        resizeWidth={56}
                      />
                      <span className="truncate text-xs sm:text-sm">{row.username}</span>
                    </Link>
                  </td>
                  {COLUMNS.map(column => {
                    const value = column.get(row);
                    return (
                      <td
                        key={column.key}
                        className={`py-2 text-center text-xs tabular-nums sm:text-sm ${
                          // A zero in a column is not news; a number in it is.
                          value === 0 ? 'text-muted-foreground/40' : 'text-muted-foreground'
                        }`}
                      >
                        {value}
                      </td>
                    );
                  })}
                  <td className="py-2 pr-0.5 text-right text-xs font-semibold tabular-nums sm:pr-2 sm:text-sm">
                    {row.totalPoints}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
