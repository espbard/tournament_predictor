import { useEffect, useState } from 'react';
import { useT } from '@/lib/useT';
import LiveCountdown from '@/components/live/LiveCountdown';
import type { LiveFixtureView } from '@/lib/liveApi';

// ── One fixture ───────────────────────────────────────────────────────────────
//
// Crests, names, kickoff, live minute and score, score inputs or a locked read-only
// state, points once finished, and an AET / pens annotation showing how a tie actually
// ended alongside the normal-time score that did the scoring.

interface Props {
  fixture: LiveFixtureView;
  onSave: (fixtureId: string, homeScore: number, awayScore: number) => void;
  isSaving: boolean;
  savedAt: number | null;
  error: string | null;
  readOnly?: boolean;
}

// The team name is always rendered next to the badge, so the crest itself is decorative.
function TeamBadge({ crestUrl }: { crestUrl: string | null }) {
  if (!crestUrl) {
    return <span className="h-6 w-6 shrink-0 rounded-full bg-muted" aria-hidden />;
  }
  return <img src={crestUrl} alt="" aria-hidden className="h-6 w-6 shrink-0 object-contain" />;
}

const LIVE_STATUSES = new Set(['in_play', 'paused']);

export default function LiveFixtureCard({
  fixture,
  onSave,
  isSaving,
  savedAt,
  error,
  readOnly = false,
}: Props) {
  const { t } = useT();
  const [home, setHome] = useState(fixture.prediction ? String(fixture.prediction.homeScore) : '');
  const [away, setAway] = useState(fixture.prediction ? String(fixture.prediction.awayScore) : '');

  // A prediction can arrive after first render — from a refetch, or another device.
  // Only adopt it when the user has not typed anything, so an edit in progress survives.
  useEffect(() => {
    if (!fixture.prediction) return;
    setHome(prev => (prev === '' ? String(fixture.prediction!.homeScore) : prev));
    setAway(prev => (prev === '' ? String(fixture.prediction!.awayScore) : prev));
  }, [fixture.prediction]);

  const homeName = fixture.homeTeam?.shortName ?? fixture.homeTeam?.name ?? t('live.tbd');
  const awayName = fixture.awayTeam?.shortName ?? fixture.awayTeam?.name ?? t('live.tbd');

  const isLive = LIVE_STATUSES.has(fixture.status);
  const isFinished = fixture.status === 'finished';
  const isCalledOff = fixture.status === 'cancelled' || fixture.status === 'postponed';

  const editable = !readOnly && !fixture.isLocked && fixture.isPredictable && fixture.homeTeamId !== null;
  const dirty =
    home !== '' &&
    away !== '' &&
    (!fixture.prediction ||
      Number(home) !== fixture.prediction.homeScore ||
      Number(away) !== fixture.prediction.awayScore);

  function handleSave() {
    if (!dirty) return;
    onSave(fixture.id, Number(home), Number(away));
  }

  // How the tie actually ended, when that differs from the score that counted.
  const decidedBeyond90 =
    fixture.penaltiesHome !== null
      ? t('live.afterPenalties', { home: fixture.penaltiesHome, away: fixture.penaltiesAway ?? 0 })
      : fixture.extraTimeHome !== null
        ? t('live.afterExtraTime')
        : null;

  const kickoff = fixture.kickoffAt ? new Date(fixture.kickoffAt) : null;

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        isLive ? 'border-green-500/60 bg-green-500/5' : ''
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {kickoff
            ? kickoff.toLocaleString(undefined, {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })
            : t('live.kickoffTbd')}
        </span>

        {isLive ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
            {fixture.minute !== null ? `${fixture.minute}'` : t('live.inPlay')}
          </span>
        ) : isCalledOff ? (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            {t(`live.status.${fixture.status}`)}
          </span>
        ) : !isFinished && fixture.isPredictable ? (
          <LiveCountdown kickoffAt={fixture.kickoffAt} status={fixture.status} />
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <TeamBadge crestUrl={fixture.homeTeam?.crestUrl ?? null} />
          <span className="truncate text-sm font-medium">{homeName}</span>
        </div>

        {/* Actual score, once there is one */}
        {(isLive || isFinished) && (
          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-sm font-semibold tabular-nums">
            {fixture.normalTimeHome ?? fixture.finalHome ?? 0}–
            {fixture.normalTimeAway ?? fixture.finalAway ?? 0}
          </span>
        )}

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <span className="truncate text-right text-sm font-medium">{awayName}</span>
          <TeamBadge crestUrl={fixture.awayTeam?.crestUrl ?? null} />
        </div>
      </div>

      {decidedBeyond90 && (
        <p className="mt-1 text-center text-xs text-muted-foreground">{decidedBeyond90}</p>
      )}

      {/* Prediction row */}
      {!fixture.isPredictable ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">{t('live.notPredictable')}</p>
      ) : (
        <div className="mt-3 flex items-center justify-center gap-2">
          <input
            type="number"
            min={0}
            max={30}
            inputMode="numeric"
            value={home}
            disabled={!editable || isSaving}
            onChange={e => setHome(e.target.value)}
            aria-label={t('live.predictedHomeScore', { team: homeName })}
            className="h-9 w-12 rounded-md border text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          <span className="text-muted-foreground">–</span>
          <input
            type="number"
            min={0}
            max={30}
            inputMode="numeric"
            value={away}
            disabled={!editable || isSaving}
            onChange={e => setAway(e.target.value)}
            aria-label={t('live.predictedAwayScore', { team: awayName })}
            className="h-9 w-12 rounded-md border text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />

          {editable && (
            <button
              onClick={handleSave}
              disabled={!dirty || isSaving}
              className="ml-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {isSaving ? t('common.saving') : t('common.save')}
            </button>
          )}

          {/* Points awarded, once the fixture has been scored */}
          {fixture.prediction?.points != null && (
            <span
              className={`ml-1 rounded px-2 py-1 text-xs font-semibold tabular-nums ${
                fixture.prediction.points > 0
                  ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                  : 'bg-muted text-muted-foreground'
              }`}
              title={t('live.pointsBreakdown', {
                outcome: fixture.prediction.correctOutcomePoints,
                gd: fixture.prediction.correctGoalDifferencePoints,
                exact: fixture.prediction.exactScorePoints,
              })}
            >
              {t('live.pointsShort', { points: fixture.prediction.points })}
            </span>
          )}
        </div>
      )}

      {savedAt && !error && (
        <p className="mt-1 text-center text-xs text-green-600 dark:text-green-400">
          {t('common.saved')}
        </p>
      )}
      {error && <p className="mt-1 text-center text-xs text-destructive">{error}</p>}

      {/* A finished fixture the provider gave us no normal-time score for cannot be
          scored — say so rather than letting it look like a zero. */}
      {isFinished && fixture.normalTimeHome === null && (
        <p className="mt-1 text-center text-xs text-amber-600 dark:text-amber-400">
          {t('live.notScorable')}
        </p>
      )}
    </div>
  );
}
