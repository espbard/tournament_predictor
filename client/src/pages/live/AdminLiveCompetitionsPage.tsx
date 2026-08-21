import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';

// ── Admin: live prediction leagues ────────────────────────────────────────────
//
// Creating a league is admin-only, matching the manual type. The invite code is shown
// here because handing it out is how members join.

export default function AdminLiveCompetitionsPage() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [tournamentId, setTournamentId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const { data: tournaments = [] } = useQuery({
    queryKey: liveKeys.tournaments,
    queryFn: () => liveApi.tournaments(),
  });

  const { data: competitions = [], isLoading } = useQuery({
    queryKey: liveKeys.competitions,
    queryFn: () => liveApi.competitions(),
  });

  const createMutation = useMutation({
    mutationFn: () => liveApi.createCompetition({ liveTournamentId: tournamentId, name: name.trim() }),
    onSuccess: () => {
      setName('');
      setError('');
      queryClient.invalidateQueries({ queryKey: liveKeys.competitions });
    },
    onError: err =>
      setError(err instanceof ApiError ? err.message : t('live.admin.createCompetitionFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => liveApi.deleteCompetition(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: liveKeys.competitions }),
  });

  const tournamentById = new Map(tournaments.map(tour => [tour.id, tour]));

  return (
    <main className="mx-auto max-w-2xl md:max-w-4xl lg:max-w-[80%] px-4 pt-2.5 pb-12 sm:pt-12">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">{t('live.admin.competitionsTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('live.admin.competitionsSubtitle')}</p>
      </div>

      <div className="mb-8 rounded-lg border p-5">
        <h2 className="mb-3 font-semibold">{t('live.admin.createCompetitionTitle')}</h2>

        {tournaments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('live.admin.needTournamentFirst')}{' '}
            <Link to="/admin/live-tournaments" className="underline">
              {t('live.admin.tournamentsTitle')}
            </Link>
          </p>
        ) : (
          <form
            onSubmit={e => {
              e.preventDefault();
              if (tournamentId && name.trim()) createMutation.mutate();
            }}
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          >
            <select
              value={tournamentId}
              onChange={e => setTournamentId(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('live.admin.chooseTournament')}</option>
              {tournaments.map(tour => (
                <option key={tour.id} value={tour.id}>
                  {tour.name}
                </option>
              ))}
            </select>

            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('live.admin.competitionName')}
              maxLength={100}
              className="rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />

            <button
              type="submit"
              disabled={!tournamentId || !name.trim() || createMutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? t('common.creating') : t('common.create')}
            </button>
          </form>
        )}

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>

      <h2 className="mb-3 font-semibold">{t('live.admin.existingCompetitions')}</h2>
      {isLoading ? (
        <LoadingSpinner />
      ) : competitions.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('live.admin.noCompetitions')}
        </p>
      ) : (
        <div className="grid gap-3">
          {competitions.map(competition => (
            <div key={competition.id} className="flex items-center gap-4 rounded-lg border p-4">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/live/competitions/${competition.id}`}
                  className="truncate font-semibold hover:underline"
                >
                  {competition.name}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {tournamentById.get(competition.liveTournamentId)?.name ?? '—'}
                </p>
              </div>

              <span className="shrink-0 rounded bg-muted px-2 py-1 font-mono text-sm">
                {competition.inviteCode}
              </span>

              <button
                onClick={() => {
                  if (window.confirm(t('live.admin.deleteCompetitionConfirm'))) {
                    deleteMutation.mutate(competition.id);
                  }
                }}
                disabled={deleteMutation.isPending}
                className="shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                {t('common.delete')}
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
