import { useT } from '@/lib/useT';
import { bandBarClasses } from '@/lib/liveBands';
import LiveTableBandLegend from '@/components/live/LiveTableBandLegend';
import {
  bandDefForPosition,
  bandForPosition,
  type LiveStageDef,
  type LiveTeam,
} from '@tournament-predictor/shared';
import type { LiveStandingView } from '@/lib/liveApi';

// ── Provider standings ────────────────────────────────────────────────────────
//
// Read-only, and deliberately so: the table is stored verbatim from the provider and
// never recomputed locally. The UEFA league phase has its own tiebreak rules, and the
// manual tournament type already shows what duplicating standings logic costs.
//
// Where the stage defines bands — the Champions League league phase goes through on 1–8,
// into a play-off on 9–24 and out on 25 and below — each row carries a bar in its band's
// colour, matching the predicted table so the two can be read against each other.
//
// Against that, each row also shows the team the viewer predicted would finish in that
// spot, and glows to say how the viewer placed the team standing there — green where they
// put it in exactly this position, yellow where they put it elsewhere but in this section
// of the table. Those are the two things the table prediction scores (see
// server/src/live/tableScoring.ts), so a row's glow is the points its team is currently
// earning. It reads off the live standings, so it is meaningful all season rather than
// only once the stage is played out and scored.

interface Props {
  rows: LiveStandingView[];
  tableScope: 'single' | 'per_group';
  /**
   * The tournament's stages. Bands are looked up from the one these standings belong to,
   * so a format that defines none simply gets an uncoloured table.
   */
  stages?: LiveStageDef[];
  /** The viewer's predicted finishing order, top first. Omit to hide the pick column. */
  predictedOrder?: string[] | null;
  /** The stage that order was predicted for — picks are shown only on its own table. */
  predictedStageKey?: string | null;
  /** Tournament teams, for resolving a predicted team's crest and name. */
  teams?: LiveTeam[];
  /** Rows at or above this position are highlighted as qualifying. */
  qualifyingCutoff?: number | null;
}

/** How the viewer's pick for one row of the table is doing. */
type PickState = 'exact' | 'band' | 'miss';

function rowGlowClasses(state: PickState): string {
  switch (state) {
    case 'exact':
      return 'bg-green-500/10';
    case 'band':
      return 'bg-amber-400/10';
    default:
      return '';
  }
}

function Table({
  rows,
  stages = [],
  predictedOrder,
  teams = [],
  qualifyingCutoff,
}: {
  rows: LiveStandingView[];
  stages?: LiveStageDef[];
  predictedOrder?: string[] | null;
  teams?: LiveTeam[];
  qualifyingCutoff?: number | null;
}) {
  const { t } = useT();

  // Every row of one table belongs to the same stage — the route orders by stage and the
  // page asks for one at a time — so the first row is enough to find the bands.
  const stage = stages.find(s => s.key === rows[0]?.stageKey) ?? null;

  const showPicks = !!predictedOrder && predictedOrder.length > 0;
  const teamById = new Map(teams.map(team => [team.id, team]));
  // Where the viewer put each team. Compared against where it is standing right now, not
  // against a final table, which is what makes the colours worth looking at mid-season.
  const predictedPositionByTeamId = new Map(
    (predictedOrder ?? []).map((teamId, index) => [teamId, index + 1]),
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="w-8 py-2 pl-2 font-medium">#</th>
            <th className="py-2 font-medium">{t('live.standings.team')}</th>
            <th className="w-10 py-2 text-center font-medium" title={t('live.standings.played')}>
              {t('live.standings.playedShort')}
            </th>
            <th className="w-10 py-2 text-center font-medium">{t('live.standings.wonShort')}</th>
            <th className="w-10 py-2 text-center font-medium">{t('live.standings.drawnShort')}</th>
            <th className="w-10 py-2 text-center font-medium">{t('live.standings.lostShort')}</th>
            <th className="w-14 py-2 text-center font-medium">{t('live.standings.goals')}</th>
            <th className="w-10 py-2 text-center font-medium">{t('live.standings.gdShort')}</th>
            <th className="w-10 py-2 pr-2 text-center font-medium">{t('live.standings.pointsShort')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const qualifying = qualifyingCutoff != null && row.position <= qualifyingCutoff;
            // Banded on where the row sits in the table, not on the position the provider
            // reports: two teams sharing a position would otherwise both take the colour
            // of the higher one and push the count of coloured rows past the band.
            const band = bandDefForPosition(stage, index + 1);

            const position = index + 1;
            // The team the viewer put in this spot. Shown beside the one standing here, but
            // it is not what the row's colour is about.
            const pickedTeamId = predictedOrder?.[index] ?? null;
            const pickedTeam = pickedTeamId ? teamById.get(pickedTeamId) ?? null : null;

            // How the viewer placed the team standing here — exactly the two things the
            // table prediction scores for it, measured the same way.
            const predictedPosition = predictedPositionByTeamId.get(row.teamId) ?? null;
            const predictedBand =
              predictedPosition === null ? null : bandForPosition(stage, predictedPosition);
            const pickState: PickState =
              predictedPosition === null
                ? 'miss'
                : predictedPosition === position
                  ? 'exact'
                  : // Both sides have to resolve to a band, so a format that defines none
                    // never glows yellow — the same rule the scoring applies.
                    band !== null && predictedBand !== null && predictedBand === band.key
                    ? 'band'
                    : 'miss';
            const pickTitle = pickedTeam
              ? t('live.standings.pickedToFinish', {
                  team: pickedTeam.shortName ?? pickedTeam.name,
                  position,
                })
              : t('live.standings.noPick', { position });

            return (
              <tr key={row.id} className={`border-b last:border-0 ${rowGlowClasses(pickState)}`}>
                <td className={`py-1.5 pl-2 tabular-nums ${bandBarClasses(band?.key ?? null)}`}>
                  <span
                    className={
                      qualifying
                        ? 'inline-block rounded bg-green-500/15 px-1.5 text-green-700 dark:text-green-400'
                        : ''
                    }
                  >
                    {row.position}
                  </span>
                </td>
                <td className="py-1.5">
                  <span className="flex items-center gap-2">
                    {row.team?.crestUrl ? (
                      <img src={row.team.crestUrl} alt="" aria-hidden className="h-5 w-5 object-contain" />
                    ) : (
                      <span className="h-5 w-5 rounded-full bg-muted" aria-hidden />
                    )}

                    {/* The team the viewer put in this spot, right beside the one actually
                        standing in it — the two crests side by side are the comparison. It
                        is dimmed so it never reads as this row's team. */}
                    {showPicks && (
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center opacity-60"
                        title={pickTitle}
                      >
                        {pickedTeam?.crestUrl ? (
                          <img
                            src={pickedTeam.crestUrl}
                            alt=""
                            aria-hidden
                            className="h-4 w-4 object-contain"
                          />
                        ) : (
                          <span className="h-3 w-3 rounded-full bg-muted" aria-hidden />
                        )}
                        <span className="sr-only">{pickTitle}</span>
                      </span>
                    )}

                    <span className="truncate">{row.team?.shortName ?? row.team?.name ?? '—'}</span>
                  </span>
                </td>
                <td className="py-1.5 text-center tabular-nums">{row.played}</td>
                <td className="py-1.5 text-center tabular-nums">{row.won}</td>
                <td className="py-1.5 text-center tabular-nums">{row.drawn}</td>
                <td className="py-1.5 text-center tabular-nums">{row.lost}</td>
                <td className="py-1.5 text-center tabular-nums text-muted-foreground">
                  {row.goalsFor}:{row.goalsAgainst}
                </td>
                <td className="py-1.5 text-center tabular-nums">
                  {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
                </td>
                <td className="py-1.5 pr-2 text-center font-semibold tabular-nums">{row.points}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function LiveStandingsTable({
  rows,
  tableScope,
  stages = [],
  predictedOrder,
  predictedStageKey,
  teams = [],
  qualifyingCutoff,
}: Props) {
  const { t } = useT();

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('live.noStandings')}
      </p>
    );
  }

  const bands = stages.find(s => s.key === rows[0]?.stageKey)?.bands ?? [];

  // Picks belong to one table, ordered top to bottom. A per-group scope has no such
  // ordering and the stage on screen may not be the one that was predicted, so in either
  // case the column is left off rather than lined up against the wrong rows.
  const picks =
    tableScope === 'single' && rows[0]?.stageKey === predictedStageKey ? predictedOrder : null;

  if (tableScope === 'single') {
    return (
      <>
        <Table
          rows={rows}
          stages={stages}
          predictedOrder={picks}
          teams={teams}
          qualifyingCutoff={qualifyingCutoff}
        />
        <LiveTableBandLegend bands={bands} className="mt-3" />
        {!!picks?.length && <PickLegend />}
      </>
    );
  }

  // One table per group. Rows without a group fall into a single unnamed bucket rather
  // than being dropped.
  const groups = new Map<string, LiveStandingView[]>();
  for (const row of rows) {
    const key = row.groupName ?? '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return (
    <div className="grid gap-6">
      {[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([groupName, groupRows]) => (
          <div key={groupName || 'ungrouped'}>
            {groupName && <h3 className="mb-2 font-semibold">{groupName}</h3>}
            <Table rows={groupRows} stages={stages} qualifyingCutoff={qualifyingCutoff} />
          </div>
        ))}
      {/* One legend for the lot: every group table is banded the same way. */}
      <LiveTableBandLegend bands={bands} />
    </div>
  );
}

/** What the second badge and the two row glows mean. Only shown where there are picks. */
function PickLegend() {
  const { t } = useT();
  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <p>{t('live.standings.pickExplainer')}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-500/40" />
          {t('live.standings.glowExact')}
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400/40" />
          {t('live.standings.glowBand')}
        </li>
      </ul>
    </div>
  );
}
