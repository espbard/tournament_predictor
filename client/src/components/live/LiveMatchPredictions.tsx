import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useT } from '@/lib/useT';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuthStore } from '@/store/authStore';
import { liveApi, liveKeys, type LiveFixturePredictionRow } from '@/lib/liveApi';

// ── What everyone predicted ───────────────────────────────────────────────────
//
// The dropdown under a played match: every member of the league, what they predicted and
// what it was worth. Collapsed by default and fetched only once opened — a gameweek is
// ten of these, and nobody opens all ten.
//
// The server refuses the request until the fixture has locked, so this is only ever
// rendered under a match that has been played. A member who never predicted is listed
// too: in a small league, who sat one out is part of the picture.
//
// Every scored row opens in turn onto where its points came from, and the scoreline
// itself carries the same story at a glance — see `tiersHit` and `PointsBreakdown`.

interface Props {
  competitionId: string;
  fixtureId: string;
  /** Names link to that member's read-only predictions, same as the leaderboard. */
  linkToUsers?: boolean;
}

type Prediction = NonNullable<LiveFixturePredictionRow['prediction']>;

/**
 * Which scoring tiers a prediction hit.
 *
 * Read off the points rather than the scoreline, because the points are all this
 * dropdown is given. The tiers nest — an exact score is also the right goal difference,
 * which is also the right outcome — so each one counts the tiers above it as hit too.
 * That matters for a league whose config awards 0 for a tier: a perfect scoreline should
 * still read as a perfect scoreline, not as a miss, however the points were shared out.
 */
function tiersHit(prediction: Prediction) {
  const exact = prediction.exactScorePoints > 0;
  const goalDifference = exact || prediction.correctGoalDifferencePoints > 0;
  const outcome = goalDifference || prediction.correctOutcomePoints > 0;
  return { exact, goalDifference, outcome };
}

/**
 * The scoreline, coloured by how good the prediction was.
 *
 * Grey for a miss, green once the outcome is right, a gold underline added for the right
 * goal difference, and gold digits on the green for a perfect scoreline. The tiers stack,
 * so the box reads as a scale rather than four unrelated states.
 */
function scoreClass(prediction: Prediction): string {
  const hit = tiersHit(prediction);
  return cn(
    'shrink-0 rounded px-2 py-0.5 font-semibold tabular-nums',
    hit.outcome
      ? 'bg-green-500/15 text-green-700 dark:text-green-400'
      : 'bg-muted text-muted-foreground',
    hit.goalDifference &&
      'underline decoration-amber-500 decoration-1 underline-offset-2 dark:decoration-amber-300',
    hit.exact && 'text-amber-600 dark:text-amber-300',
  );
}

/**
 * Where one prediction's points came from, a line per source.
 *
 * Only sources that actually paid are listed — the point is to account for the number in
 * the badge, not to enumerate everything that was missed — and the total is spelled out
 * only when there is more than one line to add up.
 */
function PointsBreakdown({ prediction }: { prediction: Prediction }) {
  const { t } = useT();

  const lines = [
    { key: 'exact', points: prediction.exactScorePoints },
    { key: 'goalDifference', points: prediction.correctGoalDifferencePoints },
    { key: 'outcome', points: prediction.correctOutcomePoints },
    { key: 'highlight', points: prediction.multiplierBonusPoints },
  ].filter(line => line.points > 0);

  if (lines.length === 0) {
    return (
      <p className="mt-1 rounded bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
        {t('live.matchPredictions.breakdown.nothing')}
      </p>
    );
  }

  return (
    <dl className="mt-1 space-y-0.5 rounded bg-muted/50 px-2 py-1.5 text-[11px]">
      {lines.map(line => (
        <div key={line.key} className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">
            {t(`live.matchPredictions.breakdown.${line.key}`)}
          </dt>
          <dd className="shrink-0 font-medium tabular-nums">+{line.points}</dd>
        </div>
      ))}

      {lines.length > 1 && (
        <div className="flex items-center justify-between gap-3 border-t pt-0.5 font-medium">
          <dt>{t('live.matchPredictions.breakdown.total')}</dt>
          <dd className="shrink-0 tabular-nums">{prediction.points}</dd>
        </div>
      )}
    </dl>
  );
}

export default function LiveMatchPredictions({
  competitionId,
  fixtureId,
  linkToUsers = true,
}: Props) {
  const { t } = useT();
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  // Whose breakdown is showing. A set rather than one at a time, so two rows can be held
  // open side by side to compare them.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: liveKeys.fixturePredictions(competitionId, fixtureId),
    queryFn: () => liveApi.fixturePredictions(competitionId, fixtureId),
    enabled: open,
    retry: false,
  });

  function toggleRow(userId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });
  }

  return (
    <div className="mt-3 border-t pt-2">
      <button
        type="button"
        onClick={() => {
          // Closing the whole panel puts the open breakdowns away with it, so reopening
          // it later starts from the same tidy list it did the first time.
          setOpen(o => !o);
          setExpanded(new Set());
        }}
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
                const prediction = row.prediction;
                // Only a scored prediction has anything to break down: a locked match
                // still being played has a scoreline but no points yet.
                const breakdown = prediction && prediction.points != null ? prediction : null;
                const isExpanded = expanded.has(row.userId);

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

                // The scoreline and the points badge, which double as the button that
                // opens the breakdown. They are rendered the same either way, so a row
                // that cannot be opened still lines up with the ones that can.
                const scoreAndPoints = prediction && (
                  <>
                    <span className={scoreClass(prediction)}>
                      {prediction.homeScore}–{prediction.awayScore}
                    </span>
                    {prediction.points != null && (
                      <span
                        className={`w-14 shrink-0 rounded px-2 py-0.5 text-right font-semibold tabular-nums ${
                          prediction.points > 0
                            ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {t('live.pointsShort', { points: prediction.points })}
                      </span>
                    )}
                  </>
                );

                return (
                  <li key={row.userId} className={`py-1.5 text-xs ${isMe ? 'font-medium' : ''}`}>
                    <div className="flex items-center gap-2">
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

                      {!prediction ? (
                        <span className="shrink-0 text-muted-foreground">
                          {t('live.matchPredictions.noPrediction')}
                        </span>
                      ) : breakdown ? (
                        <button
                          type="button"
                          onClick={() => toggleRow(row.userId)}
                          aria-expanded={isExpanded}
                          aria-label={t('live.matchPredictions.breakdown.toggle', {
                            name: row.username,
                          })}
                          className="flex shrink-0 items-center gap-2 rounded transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {scoreAndPoints}
                          <ChevronDown
                            size={13}
                            className={`shrink-0 text-muted-foreground transition-transform duration-150 ${
                              isExpanded ? 'rotate-180' : ''
                            }`}
                          />
                        </button>
                      ) : (
                        <div className="flex shrink-0 items-center gap-2">
                          {scoreAndPoints}
                          {/* Keeps an unscored row's scoreline in line with the rows
                              that carry a chevron. */}
                          <span className="w-[13px] shrink-0" aria-hidden />
                        </div>
                      )}
                    </div>

                    {breakdown && isExpanded && <PointsBreakdown prediction={breakdown} />}
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
