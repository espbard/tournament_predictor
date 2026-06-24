import { useState } from 'react';
import { Link } from 'react-router-dom';
import BackButton from '@/components/BackButton';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import type { Tournament } from '@tournament-predictor/shared';

const STATUS_COLORS: Record<Tournament['status'], string> = {
  upcoming: 'bg-primary/10 text-primary',
  active: 'bg-accent/15 text-accent',
  completed: 'bg-muted text-muted-foreground',
};

export default function TournamentsPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const { t } = useT();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  const { data: tournamentList = [], isLoading } = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => api.get<Tournament[]>('/tournaments'),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; imageUrl: string | null }) =>
      api.post<Tournament>('/tournaments', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tournaments'] });
      setName('');
      setImageUrl(null);
      setShowForm(false);
      setError('');
    },
    onError: (err: any) => setError(err.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate({ name, imageUrl });
  }

  function handleCancel() {
    setShowForm(false);
    setName('');
    setImageUrl(null);
    setError('');
  }

  const statusLabel = (status: Tournament['status']) => {
    if (status === 'upcoming') return t('tournaments.statusUpcoming');
    if (status === 'active') return t('tournaments.statusActive');
    return t('tournaments.statusCompleted');
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <BackButton href="/" />
          <h1 className="text-2xl font-bold">{t('tournaments.title')}</h1>
        </div>
        {user?.isAdmin && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          >
            {t('tournaments.newTournament')}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('tournaments.formTitle')}</h2>
          <input
            type="text"
            placeholder={t('tournaments.tournamentNamePlaceholder')}
            value={name}
            onChange={e => setName(e.target.value)}
            className="mb-3 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            required
            autoFocus
          />
          <div className="mb-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">{t('tournaments.logoOptional')}</p>
            <ImageUpload
              type="tournaments"
              currentUrl={imageUrl}
              onUploaded={setImageUrl}
              label="Choose logo"
            />
          </div>
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? t('tournaments.creating') : t('tournaments.create')}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : tournamentList.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('tournaments.noTournaments')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {tournamentList.map(tournament => (
            <li key={tournament.id}>
              <Link
                to={`/admin/tournaments/${tournament.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted"
              >
                {tournament.imageUrl ? (
                  <img src={tournament.imageUrl} alt={tournament.name} className="h-8 w-8 rounded object-cover" />
                ) : (
                  <div className="h-8 w-8 rounded bg-muted" />
                )}
                <span className="flex-1 font-medium">{tournament.name}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[tournament.status]}`}
                >
                  {statusLabel(tournament.status)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
