import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Stethoscope } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  liveApi,
  liveKeys,
  type LiveFixtureDiagnosis,
  type LiveProviderProbe,
  type LiveTournamentDetail,
} from '@/lib/liveApi';
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

  const fixtureSourceMutation = useMutation({
    mutationFn: (body: {
      fixtureProvider: 'football_data' | 'big_balls' | null;
      fixtureProviderCompetitionId: string | null;
    }) => liveApi.updateTournament(id!, body),
    onSuccess: () => {
      setError('');
      setMessage(t('live.admin.fixtureSourceSaved'));
      refresh();
    },
    onError: err => {
      setMessage('');
      setError(err instanceof ApiError ? err.message : t('live.admin.fixtureSourceFailed'));
    },
  });

  const diagnoseMutation = useMutation({
    mutationFn: () => liveApi.diagnoseTournament(id!),
    onError: err =>
      setError(err instanceof ApiError ? err.message : t('live.admin.diagnoseFailed')),
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

      {/* Teams but no fixtures has several causes that look identical from here, so this
          says what is missing and points at the diagnostic rather than picking one. */}
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

      {tournament.fixturesOutsideGameweek > 0 && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              {t('live.admin.outsideGameweekTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('live.admin.outsideGameweekBody', { count: tournament.fixturesOutsideGameweek })}
            </p>
          </div>
        </div>
      )}

      {tournament.fixturesMissingTeams > 0 && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              {t('live.admin.missingTeamsTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('live.admin.missingTeamsBody', { count: tournament.fixturesMissingTeams })}
            </p>
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

      <FixtureSourcePanel
        tournament={tournament}
        onSave={body => fixtureSourceMutation.mutate(body)}
        isSaving={fixtureSourceMutation.isPending}
      />

      <div className="mb-6 rounded-lg border p-5">
        <h2 className="mb-1 font-semibold">{t('live.admin.diagnoseTitle')}</h2>
        <p className="mb-3 text-sm text-muted-foreground">{t('live.admin.diagnoseIntro')}</p>

        <button
          onClick={() => diagnoseMutation.mutate()}
          disabled={diagnoseMutation.isPending}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <Stethoscope size={14} />
          {diagnoseMutation.isPending ? t('live.admin.diagnoseRunning') : t('live.admin.diagnose')}
        </button>

        {diagnoseMutation.data && <DiagnosisReport diagnosis={diagnoseMutation.data} />}
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

// ── The diagnostic report ─────────────────────────────────────────────────────
//
// Every probe is shown, failures included: which endpoint answered what is the whole
// point, and hiding the ones that failed would hide the answer. The verdict is the
// server's reading of the same rows, not extra information.

const PROBE_LABEL_KEYS: Record<LiveProviderProbe['key'], string> = {
  competition: 'live.admin.probeCompetition',
  matches_season: 'live.admin.probeMatchesSeason',
  matches_unfiltered: 'live.admin.probeMatchesUnfiltered',
  teams: 'live.admin.probeTeams',
  standings: 'live.admin.probeStandings',
};

const VERDICT_KEYS: Record<LiveFixtureDiagnosis['verdict'], string> = {
  fixtures_available: 'live.admin.verdictFixturesAvailable',
  never_fully_synced: 'live.admin.verdictNeverFullySynced',
  season_filter_hides_fixtures: 'live.admin.verdictSeasonFilterHides',
  provider_has_no_fixtures: 'live.admin.verdictProviderHasNoFixtures',
  season_not_published: 'live.admin.verdictSeasonNotPublished',
  provider_unreachable: 'live.admin.verdictProviderUnreachable',
};

function DiagnosisReport({ diagnosis }: { diagnosis: LiveFixtureDiagnosis }) {
  const { t } = useT();
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

  return (
    <div className="mt-4">
      <p className="mb-3 text-sm text-muted-foreground">
        {diagnosis.provider} · {diagnosis.providerCompetitionId} · {diagnosis.season}
        {diagnosis.fixtureProvider && diagnosis.fixtureProvider !== diagnosis.provider && (
          <>
            {' · '}
            {t('live.admin.diagnoseFixturesFrom', {
              provider: diagnosis.fixtureProvider,
              competition: diagnosis.fixtureProviderCompetitionId ?? diagnosis.providerCompetitionId,
            })}
          </>
        )}
        {' — '}
        {t('live.admin.diagnoseStored', {
          fixtures: diagnosis.storedFixtures,
          teams: diagnosis.storedTeams,
          lastSync: fmt(diagnosis.lastStructureSyncAt),
        })}
      </p>

      <div className="grid gap-2">
        {diagnosis.probes.map(probe => (
          <div key={`${probe.provider ?? ''}:${probe.key}`} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{t(PROBE_LABEL_KEYS[probe.key])}</span>
              {probe.provider && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  {probe.provider}
                </span>
              )}
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-mono ${
                  probe.ok
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : 'bg-destructive/10 text-destructive'
                }`}
              >
                {probe.status ?? 'no response'}
              </span>
              {probe.count !== null && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {probe.count} returned
                  {probe.countForSeason !== null && probe.countForSeason !== probe.count
                    ? `, ${probe.countForSeason} for ${diagnosis.season}`
                    : ''}
                </span>
              )}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{probe.url}</p>
            {probe.detail && <p className="mt-1 text-xs text-muted-foreground">{probe.detail}</p>}
            {probe.rawSample && (
              // The shape of the response, with its list cut to one item. For a provider
              // whose documentation never shows a whole response, this is the only way to
              // see how it paginates without guessing.
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {t('live.admin.probeShowResponse')}
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-2 text-[11px] leading-relaxed">
                  {probe.rawSample}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-md border border-primary/40 bg-primary/5 p-3">
        <h3 className="text-sm font-semibold">{t('live.admin.verdictTitle')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t(VERDICT_KEYS[diagnosis.verdict])}</p>
      </div>
    </div>
  );
}

// ── Where fixtures come from ──────────────────────────────────────────────────
//
// Teams and the table always come from `provider`; only fixtures can be moved. Its own
// draft state, so a half-typed league key does not survive a refetch of the tournament.

function FixtureSourcePanel({
  tournament,
  onSave,
  isSaving,
}: {
  tournament: LiveTournamentDetail;
  onSave: (body: {
    fixtureProvider: 'football_data' | 'big_balls' | null;
    fixtureProviderCompetitionId: string | null;
  }) => void;
  isSaving: boolean;
}) {
  const { t } = useT();
  const [provider, setProvider] = useState<string>(tournament.fixtureProvider ?? '');
  const [leagueKey, setLeagueKey] = useState(tournament.fixtureProviderCompetitionId ?? '');

  const isSplit = provider !== '' && provider !== tournament.provider;
  const dirty =
    (provider || null) !== (tournament.fixtureProvider ?? null) ||
    (leagueKey.trim() || null) !== (tournament.fixtureProviderCompetitionId ?? null);

  return (
    <div className="mb-6 rounded-lg border p-5">
      <h2 className="mb-1 font-semibold">{t('live.admin.fixtureSourceTitle')}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('live.admin.fixtureSourceIntro')}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="fixtureProvider" className="mb-1 block text-xs font-medium">
            {t('live.admin.fixtureSourceProvider')}
          </label>
          <select
            id="fixtureProvider"
            value={provider}
            onChange={e => setProvider(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">
              {t('live.admin.fixtureSourceSame', { provider: tournament.provider })}
            </option>
            <option value="football_data">football_data</option>
            <option value="big_balls">big_balls</option>
          </select>
        </div>

        <div>
          <label htmlFor="fixtureLeagueKey" className="mb-1 block text-xs font-medium">
            {t('live.admin.fixtureSourceLeagueKey')}
          </label>
          <input
            id="fixtureLeagueKey"
            type="text"
            value={leagueKey}
            onChange={e => setLeagueKey(e.target.value)}
            placeholder={tournament.providerCompetitionId}
            maxLength={64}
            disabled={!isSplit}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t('live.admin.fixtureSourceLeagueKeyHint', {
              fallback: tournament.providerCompetitionId,
            })}
          </p>
        </div>
      </div>

      <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
        {t('live.admin.fixtureSourceWarning')}
      </p>

      <button
        onClick={() =>
          onSave({
            fixtureProvider: (provider || null) as 'football_data' | 'big_balls' | null,
            fixtureProviderCompetitionId: leagueKey.trim() || null,
          })
        }
        disabled={!dirty || isSaving}
        className="mt-3 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {isSaving ? t('common.saving') : t('live.admin.fixtureSourceSave')}
      </button>
    </div>
  );
}
