import { useT } from '@/lib/useT';

export default function MaintenancePage() {
  const { t } = useT();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="mx-4 max-w-md rounded-xl border bg-card p-10 text-center shadow-lg">
        <div className="mb-4 text-5xl">🔧</div>
        <h1 className="mb-3 text-2xl font-bold text-foreground">{t('maintenance.title')}</h1>
        <p className="text-muted-foreground">{t('maintenance.message')}</p>
      </div>
    </div>
  );
}
