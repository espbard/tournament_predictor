import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useT } from '@/lib/useT';
import type { User } from '@tournament-predictor/shared';

interface Props {
  maintenanceMode: boolean;
}

export default function AdminHomePage({ maintenanceMode }: Props) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: (value: boolean) =>
      api.patch<{ maintenanceMode: boolean }>('/settings/maintenance', { maintenanceMode: value }),
    onMutate: () => setPending(true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    },
    onSettled: () => setPending(false),
  });

  const { data: userList } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<User[]>('/auth/users'),
  });

  const testAccountMutation = useMutation({
    mutationFn: ({ id, isTestAccount }: { id: string; isTestAccount: boolean }) =>
      api.patch<User>(`/auth/users/${id}`, { isTestAccount }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">{t('admin.panelTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('admin.panelSubtitle')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/admin/tournaments"
          className="rounded-lg border p-5 transition-colors hover:bg-muted"
        >
          <h2 className="mb-1 font-semibold">{t('admin.tournaments')}</h2>
          <p className="text-sm text-muted-foreground">{t('admin.tournamentsDesc')}</p>
        </Link>
        <Link
          to="/admin/competitions"
          className="rounded-lg border p-5 transition-colors hover:bg-muted"
        >
          <h2 className="mb-1 font-semibold">{t('admin.competitions')}</h2>
          <p className="text-sm text-muted-foreground">{t('admin.competitionsDesc')}</p>
        </Link>
      </div>

      <div className="mt-8 rounded-lg border p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">{t('maintenance.title')}</h2>
            {maintenanceMode && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                {t('maintenance.activeBanner')}
              </p>
            )}
          </div>
          <button
            onClick={() => toggleMutation.mutate(!maintenanceMode)}
            disabled={pending}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
              maintenanceMode ? 'bg-amber-500' : 'bg-input'
            }`}
            role="switch"
            aria-checked={maintenanceMode}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                maintenanceMode ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {userList && userList.length > 0 && (
        <div className="mt-8 rounded-lg border p-5">
          <h2 className="mb-4 font-semibold">{t('adminUsers.title')}</h2>
          <ul className="space-y-3">
            {userList.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-sm font-medium">{u.username}</span>
                  {u.isAdmin && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">admin</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t('adminUsers.testAccount')}</span>
                  <button
                    onClick={() => testAccountMutation.mutate({ id: u.id, isTestAccount: !u.isTestAccount })}
                    disabled={testAccountMutation.isPending}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                      u.isTestAccount ? 'bg-primary' : 'bg-input'
                    }`}
                    role="switch"
                    aria-checked={u.isTestAccount}
                    title={t('adminUsers.testAccountDesc')}
                  >
                    <span
                      className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                        u.isTestAccount ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
