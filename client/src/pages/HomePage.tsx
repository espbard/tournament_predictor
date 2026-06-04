import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/lib/useT';
import type { Competition } from '@tournament-predictor/shared';

export default function HomePage() {
  const { user } = useAuthStore();

  if (user?.isAdmin) return <Navigate to="/admin" replace />;

  return <CompetitionsHome />;
}

function CompetitionsHome() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [inviteCode, setInviteCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const { t } = useT();

  const { data: competitions = [], isLoading } = useQuery({
    queryKey: ['competitions'],
    queryFn: () => api.get<Competition[]>('/competitions'),
  });

  const joinMutation = useMutation({
    mutationFn: (code: string) => api.post<Competition>('/competitions/join', { inviteCode: code }),
    onSuccess: () => {
      setInviteCode('');
      setJoinError('');
      queryClient.invalidateQueries({ queryKey: ['competitions'] });
    },
    onError: (err) => {
      setJoinError(err instanceof ApiError ? err.message : t('home.failedToJoin'));
    },
  });

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (inviteCode.trim()) joinMutation.mutate(inviteCode.trim());
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 flex items-center gap-4">
        {user?.imageUrl ? (
          <img src={user.imageUrl} alt={user.username} className="h-14 w-14 rounded-full object-cover" />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-xl font-semibold">
            {user?.username?.[0]?.toUpperCase()}
          </span>
        )}
        <div>
          <h1 className="text-2xl font-bold">{t('home.welcome', { name: user?.username ?? '' })}</h1>
          <p className="text-sm text-muted-foreground">{t('home.subtitle')}</p>
        </div>
      </div>
      <h2 className="mb-4 font-semibold">{t('home.myCompetitions')}</h2>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : competitions.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('home.noCompetitions')}
        </p>
      ) : (
        <div className="grid gap-3">
          {competitions.map(c => (
            <Link
              key={c.id}
              to={`/competitions/${c.id}`}
              className="flex items-center gap-4 rounded-lg border p-4 transition-colors hover:bg-muted"
            >
              {c.imageUrl ? (
                <img src={c.imageUrl} alt={c.name} className="h-12 w-12 rounded-lg object-cover flex-shrink-0" />
              ) : (
                <div className="h-12 w-12 rounded-lg bg-muted flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                <h3 className="font-semibold">{c.name}</h3>
                {c.predictionDeadline && (
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {t('home.deadline')}: {new Date(c.predictionDeadline).toLocaleDateString()}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="mb-8 rounded-lg border p-5 mt-6">
        <h2 className="mb-3 font-semibold">{t('home.joinCompetition')}</h2>
        <form onSubmit={handleJoin} className="flex gap-2">
          <input
            type="text"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value)}
            placeholder={t('home.inviteCodePlaceholder')}
            maxLength={5}
            className="flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={joinMutation.isPending || inviteCode.trim().length === 0}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {joinMutation.isPending ? t('home.joining') : t('home.join')}
          </button>
        </form>
        {joinError && <p className="mt-2 text-sm text-destructive">{joinError}</p>}
        {joinMutation.isSuccess && (
          <p className="mt-2 text-sm text-green-600">{t('home.joinedSuccess')}</p>
        )}
      </div>
    </main>
  );
}
