import LiveGateShell from '@/components/live/LiveGateShell';
import LiveScorerPrediction from '@/components/live/LiveScorerPrediction';
import { useT } from '@/lib/useT';
import type { LiveScorerPredictionView } from '@/lib/liveApi';

// ── Step two: rank the top scorers ────────────────────────────────────────────
//
// Asked for right after the table prediction and before the bonus questions, because it
// closes at the same instant the table does — an hour before the first match — and can
// never be made afterwards.
//
// As with the table, the save control lives inside LiveScorerPrediction's `gate` variant
// rather than in the shell's footer: only that component knows the order being submitted.

interface Props {
  competitionName: string;
  view: Extract<LiveScorerPredictionView, { available: true }>;
  onSave: (orderedPlayerIds: string[]) => void;
  isSaving: boolean;
  error: string | null;
}

export default function LiveScorerPredictionGate({
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
      title={t('live.scorers.gateTitle')}
      subtitle={t('live.scorers.gateSubtitle')}
    >
      <LiveScorerPrediction
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
