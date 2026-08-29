import { Link } from 'react-router-dom';
import LiveTablePrediction from '@/components/live/LiveTablePrediction';
import { useT } from '@/lib/useT';
import type { LiveTablePredictionView } from '@/lib/liveApi';

// ── First run: predict the table before anything else ─────────────────────────
//
// A member who has not submitted a table prediction sees this instead of the competition,
// full screen, until they submit one. The table is the one prediction that cannot be made
// later — it locks at the first kickoff of the season — so asking for it up front is the
// only moment it is certain to still be open.
//
// Deliberately the whole viewport, over the app chrome: the point is that there is nothing
// else to look at yet. The one way out that is not the form is a link back to the
// competition list, so a user who opened the wrong league is not stuck in it.
//
// Rendered inside `.dark` whatever the user's theme, because the screen is a dark blue to
// black gradient and the cards on it have to sit on that rather than fight it.

interface Props {
  competitionName: string;
  view: Extract<LiveTablePredictionView, { available: true }>;
  onSave: (orderedTeamIds: string[]) => void;
  isSaving: boolean;
  error: string | null;
}

export default function LiveTablePredictionGate({
  competitionName,
  view,
  onSave,
  isSaving,
  error,
}: Props) {
  const { t } = useT();

  return (
    <div className="dark fixed inset-0 z-50 overflow-y-auto bg-gradient-to-b from-[#0b1f4b] via-[#050c1f] to-black text-foreground">
      <div className="mx-auto min-h-full w-full max-w-2xl px-4 pb-6 pt-8 sm:pt-12">
        <header className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wider text-white/50">
            {competitionName}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">
            {t('live.table.gateTitle')}
          </h1>
          <p className="mt-2 text-sm text-white/70">{t('live.table.gateSubtitle')}</p>
        </header>

        <LiveTablePrediction
          view={view}
          onSave={onSave}
          isSaving={isSaving}
          savedAt={null}
          error={error}
          variant="gate"
        />

        <div className="mt-4 text-center">
          <Link to="/" className="text-xs text-white/50 underline-offset-4 hover:underline">
            {t('live.table.gateLeave')}
          </Link>
        </div>
      </div>
    </div>
  );
}
