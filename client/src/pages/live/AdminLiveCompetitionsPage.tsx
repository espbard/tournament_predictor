import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import ImageUpload from '@/components/ImageUpload';
import { useT } from '@/lib/useT';
import type { LiveCompetition } from '@tournament-predictor/shared';

// ── Admin: live prediction leagues ────────────────────────────────────────────
//
// Creating a league is admin-only, matching the manual type. The invite code is shown
// here because handing it out is how members join.
//
// A league's name and logo are editable in place. Neither affects the game — they are
// what members see at the top of the competition page and in their league list — so the
// edit is a plain PATCH with nothing to recalculate, unlike a scoring-config change.

export default function AdminLiveCompetitionsPage() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [tournamentId, setTournamentId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

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
          {competitions.map(competition =>
            editingId === competition.id ? (
              <EditCompetitionForm
                key={competition.id}
                competition={competition}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <div key={competition.id} className="flex items-center gap-4 rounded-lg border p-4">
                {competition.imageUrl ? (
                  <img
                    src={competition.imageUrl}
                    alt=""
                    aria-hidden
                    className="h-12 w-12 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded-lg bg-muted" aria-hidden />
                )}

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
                  onClick={() => setEditingId(competition.id)}
                  className="shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  {t('common.edit')}
                </button>

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
            ),
          )}
        </div>
      )}
    </main>
  );
}

// ── Editing one league ────────────────────────────────────────────────────────
//
// Its own component so each form owns its draft state: mounting it fresh per league is
// what stops a half-typed name leaking into the next row that gets opened.

function EditCompetitionForm({
  competition,
  onDone,
}: {
  competition: LiveCompetition;
  onDone: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(competition.name);
  const [imageUrl, setImageUrl] = useState<string | null>(competition.imageUrl ?? null);
  const [error, setError] = useState('');

  const saveMutation = useMutation({
    mutationFn: () =>
      liveApi.updateCompetition(competition.id, { name: name.trim(), imageUrl }),
    onSuccess: () => {
      // The name and logo are shown on the competition page too, so both caches go.
      queryClient.invalidateQueries({ queryKey: liveKeys.competitions });
      queryClient.invalidateQueries({ queryKey: liveKeys.competition(competition.id) });
      onDone();
    },
    onError: err =>
      setError(err instanceof ApiError ? err.message : t('live.admin.updateCompetitionFailed')),
  });

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (name.trim()) saveMutation.mutate();
      }}
      className="rounded-lg border border-primary/40 p-4"
    >
      <h3 className="mb-3 text-sm font-semibold">{t('live.admin.editCompetitionTitle')}</h3>

      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        <div>
          <label className="mb-1 block text-xs font-medium">
            {t('live.admin.competitionLogo')}{' '}
            <span className="text-muted-foreground">{t('common.optional')}</span>
          </label>
          <ImageUpload
            type="competitions"
            currentUrl={imageUrl}
            onUploaded={setImageUrl}
            label={t('live.admin.chooseLogo')}
          />
          {imageUrl && (
            <button
              type="button"
              onClick={() => setImageUrl(null)}
              className="mt-2 text-xs text-muted-foreground hover:underline"
            >
              {t('live.admin.removeLogo')}
            </button>
          )}
        </div>

        <div>
          <label htmlFor={`name-${competition.id}`} className="mb-1 block text-xs font-medium">
            {t('live.admin.competitionName')}
          </label>
          <input
            id={`name-${competition.id}`}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={100}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={!name.trim() || saveMutation.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saveMutation.isPending ? t('common.saving') : t('common.save')}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
        >
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
