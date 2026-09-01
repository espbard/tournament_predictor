import { Link } from 'react-router-dom';
import { canSeeLiveScorerRanking } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuthStore } from '@/store/authStore';
import type { LiveLeaderboardRow } from '@/lib/liveApi';

// ── Live competition leaderboard ──────────────────────────────────────────────
//
// A straight read of the denormalised columns on live_competition_members — a handful of
// point sources rather than the manual type's nine, so no client-side aggregation.
//
// Each name opens that member's predictions, read-only, the same way the manual
// leaderboard does.

interface Props {
  rows: LiveLeaderboardRow[];
  competitionId: string;
}

export default function LiveLeaderboard({ rows, competitionId }: Props) {
  const { t } = useT();
  const { user } = useAuthStore();

  // The table column only appears once the table prediction has actually been scored,
  // which is once a season. A column of zeros all year would just be noise.
  const anyTablePoints = rows.some(row => row.breakdown.tablePoints > 0);
  // Same for the top-scorer ranking and the bonus questions: both are awarded once, when
  // the tournament is marked completed. The ranking column is also hidden from anyone the
  // test feature is not open to — a column nobody else can play for would only puzzle
  // them. Their totals still include whatever a test user scored there.
  const anyScorerPoints =
    canSeeLiveScorerRanking(user) && rows.some(row => row.breakdown.scorerPoints > 0);
  const anyBonusPoints = rows.some(row => row.breakdown.bonusPoints > 0);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('live.noMembers')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="w-10 py-2 pl-2 font-medium">#</th>
            <th className="py-2 font-medium">{t('live.leaderboard.player')}</th>
            <th className="w-14 py-2 text-center font-medium" title={t('live.leaderboard.outcome')}>
              {t('live.leaderboard.outcomeShort')}
            </th>
            <th className="w-14 py-2 text-center font-medium" title={t('live.leaderboard.goalDifference')}>
              {t('live.leaderboard.goalDifferenceShort')}
            </th>
            <th className="w-14 py-2 text-center font-medium" title={t('live.leaderboard.exact')}>
              {t('live.leaderboard.exactShort')}
            </th>
            {anyTablePoints && (
              <th className="w-14 py-2 text-center font-medium" title={t('live.leaderboard.table')}>
                {t('live.leaderboard.tableShort')}
              </th>
            )}
            {anyScorerPoints && (
              <th className="w-14 py-2 text-center font-medium" title={t('live.leaderboard.scorers')}>
                {t('live.leaderboard.scorersShort')}
              </th>
            )}
            {anyBonusPoints && (
              <th className="w-14 py-2 text-center font-medium" title={t('live.leaderboard.bonus')}>
                {t('live.leaderboard.bonusShort')}
              </th>
            )}
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
                <td className="py-2 text-center tabular-nums text-muted-foreground">
                  {row.breakdown.correctOutcomePoints}
                </td>
                <td className="py-2 text-center tabular-nums text-muted-foreground">
                  {row.breakdown.correctGoalDifferencePoints}
                </td>
                <td className="py-2 text-center tabular-nums text-muted-foreground">
                  {row.breakdown.exactScorePoints}
                </td>
                {anyTablePoints && (
                  <td className="py-2 text-center tabular-nums text-muted-foreground">
                    {row.breakdown.tablePoints}
                  </td>
                )}
                {anyScorerPoints && (
                  <td className="py-2 text-center tabular-nums text-muted-foreground">
                    {row.breakdown.scorerPoints}
                  </td>
                )}
                {anyBonusPoints && (
                  <td className="py-2 text-center tabular-nums text-muted-foreground">
                    {row.breakdown.bonusPoints}
                  </td>
                )}
                <td className="py-2 pr-2 text-right font-semibold tabular-nums">{row.totalPoints}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
