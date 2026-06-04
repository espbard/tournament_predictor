import { Link } from 'react-router-dom';
import { useT } from '@/lib/useT';

export default function AdminHomePage() {
  const { t } = useT();

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
    </main>
  );
}
