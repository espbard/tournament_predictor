import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { liveKeys } from '@/lib/liveApi';
import { useAuthStore } from '@/store/authStore';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import type { InviteAcceptResult, InvitePreview } from '@tournament-predictor/shared';

// ── Invite landing page ───────────────────────────────────────────────────────
//
// Where a competition's share link lands. The token says which competition and which
// tournament type, so nobody has to type an invite code — a signed-in visitor is joined
// and forwarded straight into the competition.
//
// Signed out, the page still shows what the invitation is for and sends the visitor to
// log in or register with `?redirect=` pointing back here, so the link survives the
// detour and finishes the join on the way back.

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, isLoading: loadingUser } = useAuthStore();

  const {
    data: preview,
    isLoading: loadingPreview,
    isError: previewFailed,
    error: previewError,
  } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InvitePreview>(`/invites/${token}`),
    enabled: !!token,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: () => api.post<InviteAcceptResult>(`/invites/${token}/accept`, {}),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['competitions'] });
      queryClient.invalidateQueries({ queryKey: liveKeys.competitions });
      navigate(
        result.kind === 'live'
          ? `/live/competitions/${result.competitionId}`
          : `/competitions/${result.competitionId}`,
        { replace: true },
      );
    },
  });

  // Joining is the whole point of following the link, so a signed-in visitor is not asked
  // to confirm. The ref keeps React's double-invoked effects from firing two joins.
  const acceptedRef = useRef(false);
  const { mutate: accept } = acceptMutation;
  useEffect(() => {
    if (!user || !preview || acceptedRef.current) return;
    acceptedRef.current = true;
    accept();
  }, [user, preview, accept]);

  if (loadingUser || loadingPreview) return <LoadingSpinner />;

  if (previewFailed || !preview) {
    return (
      <InviteShell title={t('invite.invalidTitle')}>
        <p className="text-sm text-muted-foreground">
          {previewError instanceof ApiError ? previewError.message : t('invite.invalidBody')}
        </p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t('invite.toHome')}
        </Link>
      </InviteShell>
    );
  }

  const heading = preview.isMember
    ? t('invite.alreadyMemberTitle', { name: preview.competitionName })
    : t('invite.invitedTitle', { name: preview.competitionName });

  // Signed out: show what the invitation is for, then send them through auth and back.
  if (!user) {
    const redirect = encodeURIComponent(`/invite/${token}`);
    return (
      <InviteShell title={heading} imageUrl={preview.imageUrl} subtitle={preview.tournamentName}>
        <p className="text-sm text-muted-foreground">{t('invite.signInToJoin')}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to={`/login?redirect=${redirect}`}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('auth.signIn')}
          </Link>
          <Link
            to={`/register?redirect=${redirect}`}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
          >
            {t('auth.register')}
          </Link>
        </div>
      </InviteShell>
    );
  }

  return (
    <InviteShell title={heading} imageUrl={preview.imageUrl} subtitle={preview.tournamentName}>
      {acceptMutation.isError ? (
        <>
          <p className="text-sm text-destructive">
            {acceptMutation.error instanceof ApiError
              ? acceptMutation.error.message
              : t('invite.failedToJoin')}
          </p>
          <Link
            to="/"
            className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('invite.toHome')}
          </Link>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('invite.joining')}</p>
      )}
    </InviteShell>
  );
}

function InviteShell({
  title,
  subtitle,
  imageUrl,
  children,
}: {
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          {imageUrl ? (
            <img src={imageUrl} alt="" aria-hidden className="h-12 w-12 rounded-lg object-cover" />
          ) : (
            <div className="h-12 w-12 rounded-lg bg-muted" aria-hidden />
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-tight">{title}</h1>
            {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
