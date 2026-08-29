import LiveGateShell from '@/components/live/LiveGateShell';
import LiveTablePrediction from '@/components/live/LiveTablePrediction';
import { useT } from '@/lib/useT';
import type { LiveTablePredictionView } from '@/lib/liveApi';

// ── Step one: predict the table ───────────────────────────────────────────────
//
// The table is the one prediction that cannot be made later — it locks at the first
// kickoff of the season and never reopens — so it is asked for before anything else.
//
// The save control lives inside LiveTablePrediction's `gate` variant rather than in the
// shell's footer slot, because only that component knows the order being submitted.

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
    <LiveGateShell
      eyebrow={competitionName}
      title={t('live.table.gateTitle')}
      subtitle={t('live.table.gateSubtitle')}
    >
      <LiveTablePrediction
        view={view}
        onSave={onSave}
        isSaving={isSaving}
        savedAt={null}
        error={error}
        variant="gate"
      />
    </LiveGateShell>
  );
}
