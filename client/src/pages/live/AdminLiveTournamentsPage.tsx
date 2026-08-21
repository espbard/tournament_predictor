import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';

// ── Admin: live tournaments ───────────────────────────────────────────────────
//
// Creating one is: pick a preset, optionally rename, submit. There is deliberately no
// free-text provider id — an unlisted competition is a code change, which is the right
// trade for a private app.

export default function AdminLiveTournamentsPage() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [presetKey, setPresetKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const { data: presets = [] } = useQuery({
    queryKey: liveKeys.presets,
    queryFn: () => liveApi.presets(),
  });

  const { data: tournaments = [], isLoading } = useQuery({
    queryKey: liveKeys.tournaments,
    queryFn: () => liveApi.tournaments(),
  });

  const createMutation = useMutation({
    mutationFn: () => liveApi.createTournament({ presetKey, name: name.trim() || undefined }),
    onSuccess: result => {
      setPresetKey('');
      setName('');
      setError('');
      // Creating before a draw is legitimate — the season simply is not published yet.
      setNotice(
        result.syncFailed
          ? t('live.admin.createdButSyncFailed')
          : result.syncSeasonUnavailable
            ? t('live.admin.createdSeasonUnavailable')
            : t('live.admin.createdWithData', {
                teams: result.syncedTeams ?? 0,
                fixtures: result.syncedFixtures ?? 0,
              }),
      );
      queryClient.invalidateQueries({ queryKey: liveKeys.tournaments });
    },
    onError: err => {
      setNotice('');
      setError(err instanceof ApiError ? err.message : t('live.admin.createFailed'));
    },
  });

  const takenPresetKeys = new Set(tournaments.map(tour => tour.presetKey));

  return (
    <main className="mx-auto max-w-2xl md:max-w-4xl lg:max-w-[80%] px-4 pt-2.5 pb-12 sm:pt-12">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">{t('live.admin.tournamentsTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('live.admin.tournamentsSubtitle')}</p>
      </div>

      <div className="mb-8 rounded-lg border p-5">
        <h2 className="mb-3 font-semibold">{t('live.admin.createTitle')}</h2>
        <form
          onSubmit={e => {
            e.preventDefault();
            if (presetKey) createMutation.mutate();
          }}
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        >
          <select
            value={presetKey}
            onChange={e => setPresetKey(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">{t('live.admin.choosePreset')}</option>
            {presets.map(preset => (
              <option key={preset.key} value={preset.key} disabled={takenPresetKeys.has(preset.key)}>
                {preset.defaultName}
                {takenPresetKeys.has(preset.key) ? ` — ${t('live.admin.alreadyAdded')}` : ''}
              </option>
            ))}
          </select>

          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('live.admin.nameOverride')}
            maxLength={100}
            className="rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />

          <button
            type="submit"
            disabled={!presetKey || createMutation.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {createMutation.isPending ? t('live.admin.creating') : t('common.create')}
          </button>
        </form>

        {createMutation.isPending && (
          <p className="mt-2 text-xs text-muted-foreground">{t('live.admin.creatingHint')}</p>
        )}
        {notice && <p className="mt-2 text-sm text-green-600 dark:text-green-400">{notice}</p>}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>

      <h2 className="mb-3 font-semibold">{t('live.admin.existing')}</h2>
      {isLoading ? (
        <LoadingSpinner />
      ) : tournaments.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('live.admin.noTournaments')}
        </p>
      ) : (
        <div className="grid gap-3">
          {tournaments.map(tournament => (
            <Link
              key={tournament.id}
              to={`/admin/live-tournaments/${tournament.id}`}
              className="flex items-center gap-4 rounded-lg border p-4 transition-colors hover:bg-muted"
            >
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-semibold">{tournament.name}</h3>
                <p className="truncate text-xs text-muted-foreground">
                  {tournament.providerCompetitionId} · {tournament.season} · {tournament.format}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {tournament.lastSyncError && (
                  <span className="rounded bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
                    {t('live.admin.syncError')}
                  </span>
                )}
                {!tournament.syncEnabled && (
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {t('live.admin.syncPaused')}
                  </span>
                )}
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {t(`live.tournamentStatus.${tournament.status}`)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
