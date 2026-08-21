import { useT } from '@/lib/useT';
import type { LiveStandingView } from '@/lib/liveApi';

// ── Provider standings ────────────────────────────────────────────────────────
//
// Read-only, and deliberately so: the table is stored verbatim from the provider and
// never recomputed locally. The UEFA league phase has its own tiebreak rules, and the
// manual tournament type already shows what duplicating standings logic costs.

interface Props {
  rows: LiveStandingView[];
  tableScope: 'single' | 'per_group';
  /** Rows at or above this position are highlighted as qualifying. */
  qualifyingCutoff?: number | null;
}

function Table({ rows, qualifyingCutoff }: { rows: LiveStandingView[]; qualifyingCutoff?: number | null }) {
  const { t } = useT();

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
          {rows.map(row => {
            const qualifying = qualifyingCutoff != null && row.position <= qualifyingCutoff;
            return (
              <tr key={row.id} className="border-b last:border-0">
                <td className="py-1.5 pl-2 tabular-nums">
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

export default function LiveStandingsTable({ rows, tableScope, qualifyingCutoff }: Props) {
  const { t } = useT();

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('live.noStandings')}
      </p>
    );
  }

  if (tableScope === 'single') {
    return <Table rows={rows} qualifyingCutoff={qualifyingCutoff} />;
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
            <Table rows={groupRows} qualifyingCutoff={qualifyingCutoff} />
          </div>
        ))}
    </div>
  );
}
