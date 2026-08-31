import { useT } from '@/lib/useT';
import LiveFixtureCard from '@/components/live/LiveFixtureCard';
import type { LiveFixtureView } from '@/lib/liveApi';

// ── A two-legged tie ──────────────────────────────────────────────────────────
//
// Wraps both legs with the running aggregate. The aggregate is informational only —
// each leg is predicted and scored separately, on its own normal-time score.

interface Props {
  legs: LiveFixtureView[];
  onSave: (fixtureId: string, homeScore: number, awayScore: number) => void;
  savingFixtureId: string | null;
  savedFixtures: Record<string, number>;
  errors: Record<string, string>;
  readOnly?: boolean;
  /** Passed to each leg so a played one can offer the league's predictions. */
  competitionId?: string;
  linkToUsers?: boolean;
}

/**
 * Aggregate across both legs, from each leg's normal-time score.
 *
 * Home and away swap between legs, so the totals are accumulated per team rather than
 * per side. Returns null until at least one leg has a score to add up.
 */
function aggregate(legs: LiveFixtureView[]): Map<string, number> | null {
  const totals = new Map<string, number>();
  let counted = 0;

  for (const leg of legs) {
    if (leg.normalTimeHome === null || leg.normalTimeAway === null) continue;
    if (!leg.homeTeamId || !leg.awayTeamId) continue;
    totals.set(leg.homeTeamId, (totals.get(leg.homeTeamId) ?? 0) + leg.normalTimeHome);
    totals.set(leg.awayTeamId, (totals.get(leg.awayTeamId) ?? 0) + leg.normalTimeAway);
    counted++;
  }

  return counted > 0 ? totals : null;
}

export default function LiveTieCard({
  legs,
  onSave,
  savingFixtureId,
  savedFixtures,
  errors,
  readOnly = false,
  competitionId,
  linkToUsers = true,
}: Props) {
  const { t } = useT();
  const ordered = [...legs].sort((a, b) => (a.legNumber ?? 0) - (b.legNumber ?? 0));
  const first = ordered[0];
  if (!first) return null;

  const totals = aggregate(ordered);

  // Name the tie from the first leg, which is the pairing users recognise.
  const homeName = first.homeTeam?.shortName ?? first.homeTeam?.name ?? t('live.tbd');
  const awayName = first.awayTeam?.shortName ?? first.awayTeam?.name ?? t('live.tbd');

  const homeTotal = first.homeTeamId ? totals?.get(first.homeTeamId) : undefined;
  const awayTotal = first.awayTeamId ? totals?.get(first.awayTeamId) : undefined;

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="truncate text-sm font-semibold">
          {homeName} <span className="text-muted-foreground">v</span> {awayName}
        </h4>
        {totals && homeTotal !== undefined && awayTotal !== undefined && (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={t('live.aggregateExplainer')}
          >
            {t('live.aggregate')}: <span className="tabular-nums font-medium">{homeTotal}–{awayTotal}</span>
          </span>
        )}
      </div>

      <div className="grid gap-2">
        {ordered.map(leg => (
          <div key={leg.id}>
            <span className="mb-1 block text-xs text-muted-foreground">
              {t('live.leg', { n: leg.legNumber ?? 1 })}
            </span>
            <LiveFixtureCard
              fixture={leg}
              onSave={onSave}
              isSaving={savingFixtureId === leg.id}
              savedAt={savedFixtures[leg.id] ?? null}
              error={errors[leg.id] ?? null}
              readOnly={readOnly}
              competitionId={competitionId}
              linkToUsers={linkToUsers}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
