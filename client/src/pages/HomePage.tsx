import { useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { liveApi, liveKeys } from '@/lib/liveApi';
import { useAuthStore } from '@/store/authStore';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import type { Competition } from '@tournament-predictor/shared';

/** One row of the merged competition list — either tournament type, same card. */
interface MyCompetition {
  name: string;
  imageUrl: string | null;
  createdAt: string;
  to: string;
  subtitle: string | null;
  /** A finished league is still worth opening, but it is not what anybody came for. */
  isCompleted: boolean;
}

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

  const { data: liveCompetitions = [], isLoading: loadingLive } = useQuery({
    queryKey: liveKeys.competitions,
    queryFn: () => liveApi.competitions(),
  });

  // Both tournament types are the user's competitions, so they share one list. The only
  // thing the card needs to know them apart for is where the link goes and what to say
  // about the deadline — a live league locks per fixture and has no single date.
  const myCompetitions: MyCompetition[] = useMemo(
    () =>
      [
        ...competitions.map(c => ({
          name: c.name,
          imageUrl: c.imageUrl ?? null,
          createdAt: c.createdAt,
          to: `/competitions/${c.id}`,
          subtitle: c.predictionDeadline
            ? `${t('home.deadline')}: ${new Date(c.predictionDeadline).toLocaleDateString()}`
            : null,
          isCompleted: c.tournamentStatus === 'completed',
        })),
        ...liveCompetitions.map(c => ({
          name: c.name,
          imageUrl: c.imageUrl ?? null,
          createdAt: c.createdAt,
          to: `/live/competitions/${c.id}`,
          subtitle: t('live.perFixtureDeadline'),
          isCompleted: c.tournamentStatus === 'completed',
        })),
        // Finished leagues sink to the bottom whatever their age: the season somebody is
        // playing is the reason they opened this page, and last year's is an archive.
      ].sort(
        (a, b) =>
          Number(a.isCompleted) - Number(b.isCompleted) ||
          (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
      ),
    [competitions, liveCompetitions, t],
  );

  const joinMutation = useMutation({
    // One code box for both tournament types: try the manual endpoint, and fall back to
    // the live one when the code is not a manual competition. Users should not have to
    // know which kind of league a code belongs to.
    mutationFn: async (code: string) => {
      try {
        return await api.post<Competition>('/competitions/join', { inviteCode: code });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return await liveApi.join(code);
        }
        throw err;
      }
    },
    onSuccess: () => {
      setInviteCode('');
      setJoinError('');
      queryClient.invalidateQueries({ queryKey: ['competitions'] });
      queryClient.invalidateQueries({ queryKey: liveKeys.competitions });
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
    <main className="mx-auto max-w-2xl md:max-w-4xl lg:max-w-[80%] px-4 pt-2.5 pb-12 sm:pt-12">
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
          {/* Only the leaderboard viewer gets a line here, because theirs says what the
              account can and cannot do rather than selling the app back to them. */}
          {user?.isLeaderboardUser && (
            <p className="text-sm text-muted-foreground">
              Leaderboard viewer — enter an invite code to view a competition leaderboard.
            </p>
          )}
        </div>
      </div>
      <h2 className="mb-4 font-semibold">{t('home.myCompetitions')}</h2>
      {isLoading || loadingLive ? (
        <LoadingSpinner />
      ) : myCompetitions.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('home.noCompetitions')}
        </p>
      ) : (
        <div className="grid gap-3">
          {myCompetitions.map(c => (
            <Link
              key={c.to}
              to={c.to}
              // The picture is the card's left edge: no padding around it, and the card
              // clips it to its own corners. `overflow-hidden` is what makes that work,
              // and `group` lets the image answer a hover on the whole card.
              className="group flex items-stretch overflow-hidden rounded-xl border bg-card transition-all hover:border-foreground/20 hover:shadow-md"
            >
              {c.imageUrl ? (
                <img
                  src={c.imageUrl}
                  alt=""
                  aria-hidden
                  className="h-20 w-20 shrink-0 object-cover transition-transform duration-300 group-hover:scale-105 sm:h-24 sm:w-24"
                />
              ) : (
                // Not an empty grey square: the initial gives a competition without a
                // picture something of its own, the way an avatar does for a person.
                <div className="flex h-20 w-20 shrink-0 items-center justify-center bg-muted text-2xl font-semibold text-muted-foreground/60 sm:h-24 sm:w-24">
                  {c.name.trim()[0]?.toUpperCase() ?? '?'}
                </div>
              )}

              <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="truncate font-semibold leading-tight">{c.name}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {c.isCompleted && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('home.completed')}
                      </span>
                    )}
                    {c.subtitle && (
                      <span className="truncate text-xs text-muted-foreground">{c.subtitle}</span>
                    )}
                  </div>
                </div>
                <ChevronRight
                  size={18}
                  aria-hidden
                  className="shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
                />
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
