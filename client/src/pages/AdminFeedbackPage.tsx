import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useT } from '@/lib/useT';
import type { Feedback, FeedbackStatus } from '@tournament-predictor/shared';

type AdminTab = 'open' | 'implemented' | 'archive';

const OPEN_STATUSES: FeedbackStatus[] = ['pending', 'will_do'];
const IMPLEMENTED_STATUSES: FeedbackStatus[] = ['implemented', 'fixed'];
const ARCHIVE_STATUSES: FeedbackStatus[] = ['wont_do'];

const STATUS_COLORS: Record<FeedbackStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  will_do: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  implemented: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  fixed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  wont_do: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const TYPE_COLORS: Record<string, string> = {
  feature_request: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  improvement: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  bug: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const STATUS_ACTIONS: { status: FeedbackStatus; labelKey: string }[] = [
  { status: 'will_do', labelKey: 'feedback.statuses.will_do' },
  { status: 'implemented', labelKey: 'feedback.statuses.implemented' },
  { status: 'fixed', labelKey: 'feedback.statuses.fixed' },
  { status: 'wont_do', labelKey: 'feedback.statuses.wont_do' },
  { status: 'pending', labelKey: 'feedback.statuses.pending' },
];

export default function AdminFeedbackPage() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<AdminTab>('open');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: allFeedback, isLoading } = useQuery({
    queryKey: ['admin-feedback'],
    queryFn: () => api.get<Feedback[]>('/feedback'),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeedbackStatus }) =>
      api.patch<Feedback>(`/feedback/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-feedback'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/feedback/${id}`),
    onSuccess: () => {
      setDeletingId(null);
      queryClient.invalidateQueries({ queryKey: ['admin-feedback'] });
    },
  });

  const tabItems = (allFeedback ?? []).filter((fb) => {
    if (activeTab === 'open') return OPEN_STATUSES.includes(fb.status);
    if (activeTab === 'implemented') return IMPLEMENTED_STATUSES.includes(fb.status);
    return ARCHIVE_STATUSES.includes(fb.status);
  });

  const tabCounts = {
    open: (allFeedback ?? []).filter((fb) => OPEN_STATUSES.includes(fb.status)).length,
    implemented: (allFeedback ?? []).filter((fb) => IMPLEMENTED_STATUSES.includes(fb.status)).length,
    archive: (allFeedback ?? []).filter((fb) => ARCHIVE_STATUSES.includes(fb.status)).length,
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-6">
        <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground">
          {t('common.back')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t('feedback.adminTitle')}</h1>
      </div>

      <div className="flex border-b mb-6">
        {(['open', 'implemented', 'archive'] as AdminTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === tab
                ? 'border-b-2 border-primary dark:border-[hsl(231,60%,65%)] text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`feedback.tabs.${tab}`)}
            {tabCounts[tab] > 0 && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs">
                {tabCounts[tab]}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : tabItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('feedback.noItems')}</p>
      ) : (
        <ul className="space-y-4">
          {tabItems.map((fb) => (
            <li key={fb.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_COLORS[fb.type] ?? 'bg-muted text-muted-foreground'}`}>
                  {t(`feedback.types.${fb.type}`)}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[fb.status]}`}>
                  {t(`feedback.statuses.${fb.status}`)}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {fb.username ?? '—'} · {new Date(fb.createdAt).toLocaleDateString()}
                </span>
              </div>

              <p className="text-sm leading-snug mb-3">{fb.message}</p>

              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-muted-foreground mr-1">{t('feedback.markAs')}:</span>
                {STATUS_ACTIONS.filter((a) => a.status !== fb.status).map(({ status, labelKey }) => (
                  <button
                    key={status}
                    onClick={() => statusMutation.mutate({ id: fb.id, status })}
                    disabled={statusMutation.isPending}
                    className="rounded border px-2.5 py-1 text-xs hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    {t(labelKey)}
                  </button>
                ))}

                <div className="ml-auto">
                  {deletingId === fb.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t('feedback.deleteConfirm')}</span>
                      <button
                        onClick={() => deleteMutation.mutate(fb.id)}
                        disabled={deleteMutation.isPending}
                        className="rounded px-2 py-1 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                      >
                        {t('common.delete')}
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="rounded px-2 py-1 text-xs border hover:bg-muted"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingId(fb.id)}
                      className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
