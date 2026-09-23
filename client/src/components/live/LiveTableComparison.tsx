import { useMemo } from 'react';
import { bandDefForPosition, type LiveTableBand, type LiveTeam } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import { bandBarClasses } from '@/lib/liveBands';

// ── Predicted table against the real one ──────────────────────────────────────
//
// The table counterpart of LiveScorerComparison: the order a member submitted, and beside
// it — under it, on a narrow screen — the table as it stands. Shown once the prediction
// has closed and the stage has kicked off; see LiveTablePrediction.
//
// Rows are coloured by exactly the two things the table prediction scores (see
// server/src/live/tableScoring.ts): green where a team is in exactly the position it was
// predicted, amber where it is elsewhere but in the same band. Both columns carry the same
// colour for the same team, and every other row says where the team sits on the other
// list, so reading across a row always answers "and where is this one over there?".
//
// The band bar down the left of each row is where that *position* falls, the same bar the
// ranking itself draws — so the green, amber and grey sections line up across the two.

interface Props {
  teams: LiveTeam[];
  bands: LiveTableBand[];
  /** The submitted table, reconciled against the current teams. Top first. */
  predictedOrder: string[];
  /** The standings as they are, top first. */
  actualOrder: string[];
  /** Points have been awarded, so the right-hand column is the final table. */
  scored: boolean;
  /** Heading for the left-hand column, when it is somebody else's table. */
  predictedLabel?: string;
}

type Match = 'exact' | 'band' | 'none';

const COLUMN_HEADING = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

const MATCH_ROW: Record<Match, string> = {
  exact: 'border-green-500/60 bg-green-500/5',
  band: 'border-amber-400/60 bg-amber-400/5',
  none: '',
};

export default function LiveTableComparison({
  teams,
  bands,
  predictedOrder,
  actualOrder,
  scored,
  predictedLabel,
}: Props) {
  const { t } = useT();

  const teamById = useMemo(() => new Map(teams.map(team => [team.id, team])), [teams]);
  // The stage definition is only needed for its bands, so a synthetic one will do.
  const stageForBands = useMemo(
    () => (bands.length ? ({ bands } as { bands: LiveTableBand[] }) : null),
    [bands],
  );
  const bandAt = (position: number) =>
    bandDefForPosition(stageForBands as never, position)?.key ?? null;

  const actualPositionById = useMemo(() => {
    const map = new Map<string, number>();
    actualOrder.forEach((id, i) => map.set(id, i + 1));
    return map;
  }, [actualOrder]);

  const predictedPositionById = useMemo(() => {
    const map = new Map<string, number>();
    predictedOrder.forEach((id, i) => map.set(id, i + 1));
    return map;
  }, [predictedOrder]);

  // Same test from either side: where the team was predicted against where it is.
  function matchFor(teamId: string): Match {
    const predicted = predictedPositionById.get(teamId);
    const actual = actualPositionById.get(teamId);
    if (predicted === undefined || actual === undefined) return 'none';
    if (predicted === actual) return 'exact';
    const band = bandAt(predicted);
    return band !== null && band === bandAt(actual) ? 'band' : 'none';
  }

  const matches = predictedOrder.map(matchFor);
  const exactCount = matches.filter(m => m === 'exact').length;
  const bandCount = matches.filter(m => m === 'band').length;

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {bands.length > 0
          ? t('live.table.compare.summary', {
              exact: exactCount,
              band: bandCount,
              total: predictedOrder.length,
            })
          : t('live.table.compare.summaryNoBands', {
              exact: exactCount,
              total: predictedOrder.length,
            })}
      </p>

      <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
        <section>
          <h3 className={COLUMN_HEADING}>{predictedLabel ?? t('live.table.compare.predicted')}</h3>
          <ol className="grid grid-cols-1 gap-1">
            {predictedOrder.map((teamId, index) => {
              const actualPosition = actualPositionById.get(teamId) ?? null;
              return (
                <ComparisonRow
                  key={teamId}
                  team={teamById.get(teamId) ?? null}
                  teamId={teamId}
                  position={index + 1}
                  bandKey={bandAt(index + 1)}
                  match={matchFor(teamId)}
                  counterpartPosition={actualPosition}
                  counterpartLabel={
                    actualPosition === null
                      ? t('live.table.compare.notInTable')
                      : t(scored ? 'live.table.compare.finishedAt' : 'live.table.compare.currentlyAt', {
                          position: actualPosition,
                        })
                  }
                />
              );
            })}
          </ol>
        </section>

        <section>
          <h3 className={COLUMN_HEADING}>
            {t(scored ? 'live.table.compare.actualFinal' : 'live.table.compare.actual')}
          </h3>
          <ol className="grid grid-cols-1 gap-1">
            {actualOrder.map((teamId, index) => {
              const predictedPosition = predictedPositionById.get(teamId) ?? null;
              return (
                <ComparisonRow
                  key={teamId}
                  team={teamById.get(teamId) ?? null}
                  teamId={teamId}
                  position={index + 1}
                  bandKey={bandAt(index + 1)}
                  match={matchFor(teamId)}
                  counterpartPosition={predictedPosition}
                  counterpartLabel={
                    predictedPosition === null
                      ? t('live.table.compare.notPredicted')
                      : t('live.table.compare.predictedAt', { position: predictedPosition })
                  }
                />
              );
            })}
          </ol>
        </section>
      </div>

      {/* What the two row colours mean. Amber only exists where the format has bands. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-500/40" />
          {t('live.table.compare.glowExact')}
        </li>
        {bands.length > 0 && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400/40" />
            {t('live.table.compare.glowBand')}
          </li>
        )}
      </ul>
    </div>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

interface RowProps {
  team: LiveTeam | null;
  teamId: string;
  /** Where this row sits in its own column. */
  position: number;
  /** The band of that position, for the bar down the left. */
  bandKey: string | null;
  match: Match;
  /** Where the same team sits in the other column, or null if it does not hold it. */
  counterpartPosition: number | null;
  /** What that position means, spelled out for a title and for screen readers. */
  counterpartLabel: string;
}

function ComparisonRow({
  team,
  teamId,
  position,
  bandKey,
  match,
  counterpartPosition,
  counterpartLabel,
}: RowProps) {
  const name = team?.shortName ?? team?.name ?? teamId;
  const exact = match === 'exact';

  return (
    <li
      className={`flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 ${bandBarClasses(bandKey)} ${MATCH_ROW[match]}`}
    >
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
        {position}
      </span>

      {team?.crestUrl ? (
        <img src={team.crestUrl} alt="" aria-hidden className="h-5 w-5 shrink-0 object-contain" />
      ) : (
        <span className="h-5 w-5 shrink-0 rounded-full bg-muted" aria-hidden />
      )}

      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>

      {/* Where the same team sits on the other list. A green row is in both places at
          once, so it gets the tick instead of a number it would only repeat. */}
      <span
        className={`w-8 shrink-0 text-right text-xs tabular-nums ${
          exact ? 'font-semibold text-green-700 dark:text-green-400' : 'text-muted-foreground'
        }`}
        title={counterpartLabel}
      >
        {exact ? '✓' : counterpartPosition !== null ? `#${counterpartPosition}` : '–'}
        <span className="sr-only"> {counterpartLabel}</span>
      </span>
    </li>
  );
}
