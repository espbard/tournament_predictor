import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import LiveSelectedMatchesPanel from '@/components/live/LiveSelectedMatchesPanel';
import AdminLiveBonusQuestionsPanel from '@/components/live/AdminLiveBonusQuestionsPanel';
import { useT } from '@/lib/useT';

// ── Admin: one live tournament ────────────────────────────────────────────────
//
// Sync state, the warnings that matter, and the controls to fix them. The two warnings
// are worth surfacing rather than burying in logs: an unmapped provider stage means a
// provider rename has stranded fixtures, and an unscorable fixture means the provider
// gave no normal-time score, so nobody can be awarded points for it.

export default function AdminLiveTournamentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const { data: tournament, isLoading } = useQuery({
    queryKey: liveKeys.tournament(id!),
    queryFn: () => liveApi.tournament(id!),
    enabled: !!id,
  });

  const { data: teams = [] } = useQuery({
    queryKey: liveKeys.tournamentTeams(id!),
    queryFn: () => liveApi.tournamentTeams(id!),
    enabled: !!id,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: liveKeys.tournament(id!) });
    queryClient.invalidateQueries({ queryKey: liveKeys.tournamentTeams(id!) });
    // A sync can add fixtures to a gameweek, which changes what there is to select.
    queryClient.invalidateQueries({ queryKey: liveKeys.tournamentFixtures(id!) });
    queryClient.invalidateQueries({ queryKey: liveKeys.selectedMatches(id!) });
  }

  const syncMutation = useMutation({
    mutationFn: (full: boolean) => liveApi.syncTournament(id!, full),
    onSuccess: result => {
      setError('');
      setMessage(
        result.seasonUnavailable
          ? t('live.admin.seasonUnavailable')
          : t('live.admin.syncDone', {
              fixtures: result.fixtures,
              teams: result.teams,
              standings: result.standings,
            }) +
              // Only worth mentioning on the first full sync, when there is work to do.
              (result.crestsMirrored > 0
                ? ` ${t('live.admin.crestsMirrored', { count: result.crestsMirrored })}`
                : ''),
      );
      refresh();
    },
    onError: err => {
      setMessage('');
      setError(err instanceof ApiError ? err.message : t('live.admin.syncFailed'));
    },
  });

  const recalcMutation = useMutation({
    mutationFn: () => liveApi.recalculateTournament(id!),
    onSuccess: result => {
      setError('');
      setMessage(t('live.admin.recalcDone', { count: result.scoredPredictions }));
    },
    onError: err => setError(err instanceof ApiError ? err.message : t('live.admin.recalcFailed')),
  });

  const toggleSyncMutation = useMutation({
    mutationFn: (syncEnabled: boolean) => liveApi.updateTournament(id!, { syncEnabled }),
    onSuccess: refresh,
  });

  const deleteMutation = useMutation({
    mutationFn: () => liveApi.deleteTournament(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: liveKeys.tournaments });
      navigate('/admin/live-tournaments');
    },
  });

  if (isLoading) return <LoadingSpinner />;
  if (!tournament) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <p className="text-center text-sm text-muted-foreground">{t('live.admin.notFound')}</p>
      </main>
    );
  }

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

  return (
    <main className="mx-auto max-w-2xl md:max-w-4xl lg:max-w-[80%] px-4 pt-2.5 pb-12 sm:pt-12">
      <Link to="/admin/live-tournaments" className="text-sm text-muted-foreground hover:underline">
        {t('common.back')}
      </Link>

      <div className="mb-6 mt-2">
        <h1 className="text-2xl font-bold">{tournament.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tournament.provider} · {tournament.providerCompetitionId} · {tournament.season} ·{' '}
          {tournament.format}
        </p>
      </div>

      {/* Warnings first — they are the reason to open this page. */}
      {tournament.lastSyncError && (
        <div className="mb-4 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-destructive">{t('live.admin.syncErrorTitle')}</h2>
            <p className="mt-1 break-words text-sm text-muted-foreground">{tournament.lastSyncError}</p>
          </div>
        </div>
      )}

      {tournament.unmappedStages.length > 0 && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              {t('live.admin.unmappedStagesTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('live.admin.unmappedStagesBody', { stages: tournament.unmappedStages.join(', ') })}
            </p>
          </div>
        </div>
      )}

      {/* Teams but no fixtures is the one "empty" state that looks like a bug and is not:
          the provider has the season, it just has no match calendar for it yet. Without
          this the admin page shows a bare "Fixtures 0" and no way to tell which it is. */}
      {tournament.teamCount > 0 && tournament.fixtureCount === 0 && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              {t('live.admin.noFixturesTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('live.admin.noFixturesBody')}</p>
          </div>
        </div>
      )}

      {tournament.unscorableFixtures > 0 && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              {t('live.admin.unscorableTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('live.admin.unscorableBody', { count: tournament.unscorableFixtures })}
            </p>
          </div>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('live.admin.teams')} value={String(tournament.teamCount)} />
        <Stat
          label={t('live.admin.qualified')}
          value={
            tournament.expectedTeamCount
              ? `${tournament.qualifiedCount} / ${tournament.expectedTeamCount}`
              : String(tournament.qualifiedCount)
          }
        />
        <Stat label={t('live.admin.fixtures')} value={String(tournament.fixtureCount)} />
        <Stat label={t('live.admin.status')} value={t(`live.tournamentStatus.${tournament.status}`)} />
      </div>

      <div className="mb-6 rounded-lg border p-5">
        <h2 className="mb-3 font-semibold">{t('live.admin.syncTitle')}</h2>
        <dl className="mb-4 grid gap-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('live.admin.lastStructureSync')}</dt>
            <dd>{fmt(tournament.lastStructureSyncAt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('live.admin.lastFixtureSync')}</dt>
            <dd>{fmt(tournament.lastFixtureSyncAt)}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => syncMutation.mutate(false)}
            disabled={syncMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncMutation.isPending ? 'animate-spin' : ''} />
            {t('live.admin.syncWindow')}
          </button>
          <button
            onClick={() => syncMutation.mutate(true)}
            disabled={syncMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncMutation.isPending ? 'animate-spin' : ''} />
            {t('live.admin.syncFull')}
          </button>
          <button
            onClick={() => recalcMutation.mutate()}
            disabled={recalcMutation.isPending}
            className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('live.admin.recalculate')}
          </button>
          <button
            onClick={() => toggleSyncMutation.mutate(!tournament.syncEnabled)}
            disabled={toggleSyncMutation.isPending}
            className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {tournament.syncEnabled ? t('live.admin.pauseSync') : t('live.admin.resumeSync')}
          </button>
        </div>

        {message && <p className="mt-3 text-sm text-green-600 dark:text-green-400">{message}</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      <LiveSelectedMatchesPanel tournamentId={tournament.id} />

      <AdminLiveBonusQuestionsPanel tournamentId={tournament.id} />

      <div className="mb-6 rounded-lg border p-5">
        <h2 className="mb-3 font-semibold">{t('live.admin.teamsTitle')}</h2>
        {teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('live.admin.noTeams')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map(team => (
              <li key={team.id} className="flex items-center gap-2 text-sm">
                {team.crestUrl ? (
                  <img src={team.crestUrl} alt="" aria-hidden className="h-5 w-5 object-contain" />
                ) : (
                  <span className="h-5 w-5 rounded-full bg-muted" aria-hidden />
                )}
                <span className="truncate">{team.shortName ?? team.name}</span>
                <span
                  className={`ml-auto shrink-0 text-xs ${
                    team.qualificationStatus === 'qualified'
                      ? 'text-green-600 dark:text-green-400'
                      : team.qualificationStatus === 'eliminated'
                        ? 'text-muted-foreground line-through'
                        : 'text-muted-foreground'
                  }`}
                >
                  {t(`live.qualification.${team.qualificationStatus}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-destructive/40 p-5">
        <h2 className="mb-1 font-semibold text-destructive">{t('live.admin.dangerTitle')}</h2>
        <p className="mb-3 text-sm text-muted-foreground">{t('live.admin.deleteWarning')}</p>
        <button
          onClick={() => {
            if (window.confirm(t('live.admin.deleteConfirm'))) deleteMutation.mutate();
          }}
          disabled={deleteMutation.isPending}
          className="rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
        >
          {t('common.delete')}
        </button>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
