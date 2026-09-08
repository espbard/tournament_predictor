import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CirclePause, TriangleAlert } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys, type LiveSyncStatus } from '@/lib/liveApi';
import { useT } from '@/lib/useT';

// ── Admin: is this tournament updating itself? ────────────────────────────────
//
// Scores and points are kept up to date by the background sync, not by an admin pressing
// the buttons underneath this panel. That is only believable if it can be seen, so this
// says in one line whether the sync is running, when it last woke up, and when this
// tournament is next polled — and offers the switch, since an automatic thing nobody can
// turn off is worse than a manual one.
//
// It polls rather than subscribes: the interesting number is a countdown, and the whole
// payload is two small queries on the server.

/** How often the panel re-reads the status. Short enough that the countdown moves. */
const REFETCH_MS = 15_000;

function countdown(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export default function AdminLiveAutoSyncPanel({ tournamentId }: { tournamentId: string }) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const { data: status, error } = useQuery<LiveSyncStatus>({
    queryKey: liveKeys.syncStatus,
    queryFn: () => liveApi.syncStatus(),
    refetchInterval: REFETCH_MS,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean | null) => liveApi.setSyncEnabled(enabled),
    onSuccess: next => queryClient.setQueryData(liveKeys.syncStatus, next),
  });

  // A failure here is not worth an alarm: the sync is either running or it is not, and the
  // panel below still works. Say nothing rather than showing a broken box.
  if (error instanceof ApiError || !status) return null;

  const mine = status.tournaments.find(row => row.id === tournamentId);
  const now = Date.now();
  const nextPoll = mine ? countdown(mine.nextSyncDueAt, now) : null;

  return (
    <div className="mb-6 rounded-lg border p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold">
          {status.enabled ? (
            <CircleCheck size={16} className="text-green-600 dark:text-green-400" />
          ) : (
            <CirclePause size={16} className="text-muted-foreground" />
          )}
          {t('live.admin.autoSyncTitle')}
        </h2>
        <span
          className={
            status.enabled
              ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300'
              : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
          }
        >
          {status.enabled ? t('live.admin.autoSyncOn') : t('live.admin.autoSyncOff')}
        </span>
      </div>

      {/* An admin who switched it off deserves to be told that, not to be told what the
          deployment's default would have been. */}
      <p className="mb-3 text-sm text-muted-foreground">
        {status.enabled
          ? t('live.admin.autoSyncExplainerOn', { seconds: status.tickSeconds })
          : status.override === false
            ? t('live.admin.autoSyncOffByAdmin')
            : t(`live.admin.autoSyncReason.${status.reason}`)}
      </p>

      {status.enabled && (
        <dl className="mb-4 grid gap-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('live.admin.autoSyncLastTick')}</dt>
            <dd>
              {status.lastTickAt ? new Date(status.lastTickAt).toLocaleTimeString() : '—'}
            </dd>
          </div>
          {mine && (
            <>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('live.admin.autoSyncPace')}</dt>
                <dd>{t(`live.admin.autoSyncTemperature.${mine.temperature}`)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('live.admin.autoSyncNextPoll')}</dt>
                <dd>
                  {!mine.syncEnabled
                    ? t('live.admin.autoSyncTournamentPaused')
                    : (nextPoll ?? '—')}
                </dd>
              </div>
            </>
          )}
        </dl>
      )}

      {status.lastTickError && (
        <p className="mb-3 flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{status.lastTickError}</span>
        </p>
      )}

      {/* LIVE_SYNC_ENABLED=false is a kill switch the server holds, so offering a button
          that cannot beat it would be a lie. Say so instead. */}
      <div className="flex flex-wrap items-center gap-2">
        {status.reason !== 'env-off' && (
          <button
            onClick={() => toggle.mutate(!status.enabled)}
            disabled={toggle.isPending}
            className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {status.enabled ? t('live.admin.autoSyncTurnOff') : t('live.admin.autoSyncTurnOn')}
          </button>
        )}
        {/* Only offered once an override exists, since clearing one that is not there
            does nothing an admin would notice. */}
        {status.override !== null && (
          <button
            onClick={() => toggle.mutate(null)}
            disabled={toggle.isPending}
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {t('live.admin.autoSyncUseDefault')}
          </button>
        )}
      </div>
    </div>
  );
}
