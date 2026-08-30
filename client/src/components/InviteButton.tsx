import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Share2, UserPlus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/useT';
import type { CompetitionInvite, CompetitionKind } from '@tournament-predictor/shared';

// ── Invite button ─────────────────────────────────────────────────────────────
//
// The second way into a competition, next to the five-digit code: a link that joins the
// person who opens it. The token behind it is minted server-side on first press and then
// reused, so the same competition always shares the same link.
//
// One component for both tournament types — only the endpoint differs.

interface Props {
  kind: CompetitionKind;
  competitionId: string;
  className?: string;
}

export default function InviteButton({ kind, competitionId, className }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const inviteMutation = useMutation({
    mutationFn: () =>
      api.post<CompetitionInvite>(
        kind === 'live'
          ? `/live/competitions/${competitionId}/invite`
          : `/competitions/${competitionId}/invite`,
        {},
      ),
  });

  // The server returns the path only; the origin has to come from the browser so the link
  // works the same in dev, on a preview deploy and in production.
  const inviteUrl = inviteMutation.data
    ? `${window.location.origin}${inviteMutation.data.path}`
    : '';

  function openDialog() {
    setCopied(false);
    setOpen(true);
    // Re-minting is a no-op server-side, but a stale error should not survive a reopen.
    inviteMutation.mutate();
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (an insecure origin, a locked-down browser). The
      // link is on screen and selectable, so there is nothing to recover from.
      setCopied(false);
    }
  }

  async function shareLink() {
    try {
      await navigator.share({ title: t('invite.shareTitle'), url: inviteUrl });
    } catch {
      // Includes the user simply dismissing the share sheet.
    }
  }

  return (
    <>
      <button
        onClick={openDialog}
        className={
          className ??
          'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted flex-shrink-0'
        }
      >
        <UserPlus className="h-4 w-4" />
        {t('invite.button')}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-xl">
            <p className="mb-1 font-semibold">{t('invite.dialogTitle')}</p>
            <p className="mb-4 text-sm text-muted-foreground">{t('invite.dialogBody')}</p>

            {inviteMutation.isPending && (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            )}

            {inviteMutation.isError && (
              <p className="text-sm text-destructive">
                {inviteMutation.error instanceof ApiError
                  ? inviteMutation.error.message
                  : t('invite.failed')}
              </p>
            )}

            {inviteMutation.isSuccess && (
              <>
                <input
                  readOnly
                  value={inviteUrl}
                  onFocus={e => e.currentTarget.select()}
                  aria-label={t('invite.linkLabel')}
                  className="w-full rounded-md border bg-muted/40 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={copyLink}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? t('invite.copied') : t('invite.copyLink')}
                  </button>
                  {typeof navigator !== 'undefined' && 'share' in navigator && (
                    <button
                      onClick={shareLink}
                      className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm hover:bg-muted"
                    >
                      <Share2 className="h-4 w-4" />
                      {t('invite.share')}
                    </button>
                  )}
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  {t('invite.orCode')}{' '}
                  <span className="font-mono tracking-wider">{inviteMutation.data.inviteCode}</span>
                </p>
              </>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setOpen(false)}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
              >
                {t('invite.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
