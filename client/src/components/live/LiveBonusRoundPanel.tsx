import { Star } from 'lucide-react';
import { useT } from '@/lib/useT';
import LiveFixtureList from '@/components/live/LiveFixtureList';
import type { LiveBonusRoundView, LiveFixtureView } from '@/lib/liveApi';

// ── One bonus round ───────────────────────────────────────────────────────────
//
// What the fixtures tab shows in place of a gameweek when a bonus round is picked: its
// name, where its matches come from, and the matches themselves on the ordinary cards.
// The server has already made each fixture mean the round — its multiplier, its score
// and the caller's bonus-round prediction — so the cards need no special casing beyond
// asking the bonus-round route for "what everyone predicted".

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
  const sources = [...new Set(round.fixtures.map(f => f.sourceTournamentName))].join(', ');

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
        {round.fixtures.length > 0 && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('live.bonusRounds.explainer', { count: round.fixtures.length, sources })}
          </p>
        )}
        {round.visibility === 'test' && (
          <p className="mt-0.5 text-xs text-muted-foreground">{t('live.bonusRounds.testExplainer')}</p>
        )}
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

      {round.fixtures.some(f => f.scoreOverridden) && (
        <p className="mt-2 text-xs text-muted-foreground">{t('live.bonusRounds.scoreOverridden')}</p>
      )}
    </>
  );
}
