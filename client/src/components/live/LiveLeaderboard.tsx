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
// Every column is always shown, zeros included. They were once hidden until somebody had
// scored in them, which spared a little noise but meant the table silently changed shape
// mid-season and gave no answer to "what else can I score for?" — which is most of what a
// leaderboard is read for before the points arrive.
//
// Highlight is the extra from multiplied matches, and it is deliberately the only place
// that extra appears: the three tiers hold what each prediction earned at face value, so
// they stay comparable between members whatever the admin has chosen to highlight.
//
// Each name opens that member's predictions, read-only, the same way the manual
// leaderboard does.

interface Props {
  rows: LiveLeaderboardRow[];
  competitionId: string;
}

/** The point sources, in the order a season earns them. */
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

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('live.noMembers')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      {/* Eight columns do not fit a phone, so the table scrolls inside its own box rather
          than squeezing the names down to nothing. */}
      <table className="w-full min-w-[42rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="w-10 py-2 pl-2 font-medium">#</th>
            <th className="py-2 font-medium">{t('live.leaderboard.player')}</th>
            {COLUMNS.map(column => (
              <th
                key={column.key}
                className="w-14 py-2 text-center font-medium"
                title={t(`live.leaderboard.${column.key}`)}
              >
                {t(`live.leaderboard.${column.key}Short`)}
              </th>
            ))}
            <th className="w-16 py-2 pr-2 text-right font-medium">{t('live.leaderboard.total')}</th>
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
                <td className="py-2 pl-2 tabular-nums">{row.rank}</td>
                <td className="py-2">
                  <Link
                    to={`/live/competitions/${competitionId}/predictions/${row.userId}`}
                    className="flex min-w-0 items-center gap-2 transition-opacity hover:opacity-80"
                  >
                    <UserAvatar
                      username={row.username}
                      imageUrl={row.imageUrl}
                      iconColor={row.iconColor}
                      className="h-7 w-7"
                      resizeWidth={56}
                    />
                    <span className="truncate">{row.username}</span>
                  </Link>
                </td>
                {COLUMNS.map(column => {
                  const value = column.get(row);
                  return (
                    <td
                      key={column.key}
                      className={`py-2 text-center tabular-nums ${
                        // A zero in a column is not news; a number in it is.
                        value === 0 ? 'text-muted-foreground/40' : 'text-muted-foreground'
                      }`}
                    >
                      {value}
                    </td>
                  );
                })}
                <td className="py-2 pr-2 text-right font-semibold tabular-nums">{row.totalPoints}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
