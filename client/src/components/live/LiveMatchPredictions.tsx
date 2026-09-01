import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useT } from '@/lib/useT';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuthStore } from '@/store/authStore';
import { liveApi, liveKeys } from '@/lib/liveApi';

// ── What everyone predicted ───────────────────────────────────────────────────
//
// The dropdown under a played match: every member of the league, what they predicted and
// what it was worth. Collapsed by default and fetched only once opened — a gameweek is
// ten of these, and nobody opens all ten.
//
// The server refuses the request until the fixture has locked, so this is only ever
// rendered under a match that has been played. A member who never predicted is listed
// too: in a small league, who sat one out is part of the picture.

interface Props {
  competitionId: string;
  fixtureId: string;
  /** Names link to that member's read-only predictions, same as the leaderboard. */
  linkToUsers?: boolean;
}

export default function LiveMatchPredictions({
  competitionId,
  fixtureId,
  linkToUsers = true,
}: Props) {
  const { t } = useT();
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: liveKeys.fixturePredictions(competitionId, fixtureId),
    queryFn: () => liveApi.fixturePredictions(competitionId, fixtureId),
    enabled: open,
    retry: false,
  });

  return (
    <div className="mt-3 border-t pt-2">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {t('live.matchPredictions.toggle')}
        <ChevronDown
          size={13}
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="mt-2">
          {isLoading ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              {t('common.loading')}
            </p>
          ) : isError ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              {t('live.matchPredictions.unavailable')}
            </p>
          ) : rows.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              {t('live.matchPredictions.nobody')}
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map(row => {
                const isMe = row.userId === user?.id;
                const name = (
                  <span className="flex min-w-0 items-center gap-2">
                    <UserAvatar
                      username={row.username}
                      imageUrl={row.imageUrl}
                      iconColor={row.iconColor}
                      className="h-6 w-6"
                      resizeWidth={48}
                    />
                    <span className="truncate">{row.username}</span>
                  </span>
                );

                return (
                  <li
                    key={row.userId}
                    className={`flex items-center gap-2 py-1.5 text-xs ${
                      isMe ? 'font-medium' : ''
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      {linkToUsers ? (
                        <Link
                          to={`/live/competitions/${competitionId}/predictions/${row.userId}`}
                          className="inline-flex min-w-0 max-w-full transition-opacity hover:opacity-80"
                        >
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </div>

                    {row.prediction ? (
                      <>
                        <span className="shrink-0 rounded bg-muted px-2 py-0.5 font-semibold tabular-nums">
                          {row.prediction.homeScore}–{row.prediction.awayScore}
                        </span>
                        {row.prediction.points != null && (
                          <span
                            className={`w-14 shrink-0 rounded px-2 py-0.5 text-right font-semibold tabular-nums ${
                              row.prediction.points > 0
                                ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                : 'bg-muted text-muted-foreground'
                            }`}
                            title={t('live.pointsBreakdown', {
                              outcome: row.prediction.correctOutcomePoints,
                              gd: row.prediction.correctGoalDifferencePoints,
                              exact: row.prediction.exactScorePoints,
                            })}
                          >
                            {t('live.pointsShort', { points: row.prediction.points })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="shrink-0 text-muted-foreground">
                        {t('live.matchPredictions.noPrediction')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
