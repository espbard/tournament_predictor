import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useT } from '@/lib/useT';

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
    </main>
  );
}
