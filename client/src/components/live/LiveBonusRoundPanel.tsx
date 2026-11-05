import { Star } from 'lucide-react';
import { useT } from '@/lib/useT';
import LiveFixtureList from '@/components/live/LiveFixtureList';
import type { LiveBonusRoundView, LiveFixtureView } from '@/lib/liveApi';

// ── One bonus round ───────────────────────────────────────────────────────────
//
// What the fixtures tab shows in place of a gameweek when a bonus round is picked: its
// name, and the matches themselves on the ordinary cards. The server shapes each hand-entered match as an ordinary fixture view, so the
// cards need no special casing beyond asking the bonus-round route for "what everyone
// predicted".

interface Props {
  round: LiveBonusRoundView;
  competitionId: string;
  onSave: (fixtureId: string, homeScore: number, awayScore: number) => void;
  savingFixtureId: string | null;
  savedFixtures: Record<string, number>;
  errors: Record<string, string>;
  readOnly: boolean;
  /** Leave out the viewer's own prediction row — a spectator has none. */
  hidePrediction?: boolean;
}

export default function LiveBonusRoundPanel({
  round,
  competitionId,
  onSave,
  savingFixtureId,
  savedFixtures,
  errors,
  readOnly,
  hidePrediction = false,
}: Props) {
  const { t } = useT();
  return (
    <>
      <div className="mb-3">
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          <Star className="h-4 w-4 fill-current text-amber-500" aria-hidden />
          {round.name}
          {round.visibility === 'test' && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('live.bonusRounds.testOnly')}
            </span>
          )}
        </h2>
      </div>

      <LiveFixtureList
        fixtures={round.fixtures as LiveFixtureView[]}
        stageKind="table"
        legs={1}
        matchday={null}
        emptyMessage={t('live.bonusRounds.empty')}
        onSave={onSave}
        savingFixtureId={savingFixtureId}
        savedFixtures={savedFixtures}
        errors={errors}
        readOnly={readOnly}
        hidePrediction={hidePrediction}
        competitionId={competitionId}
        bonusRound
      />
    </>
  );
}
