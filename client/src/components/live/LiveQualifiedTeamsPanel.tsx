import { useT } from '@/lib/useT';
import type { LiveTeam } from '@tournament-predictor/shared';

// ── Pre-draw stand-in ─────────────────────────────────────────────────────────
//
// Shown instead of an empty fixture list when a competition has no fixtures yet.
//
// This is not an error state. The Champions League 2026/27 season does not exist at the
// provider until the league-phase draw, so *every* call for it returns nothing — teams
// included. The panel has to read sensibly whether we have 36 teams, 29, or none at all.

interface Props {
  teams: LiveTeam[];
  expectedTeamCount: number | null;
  /** Free text, e.g. a known draw date. Rendered as the explanatory line when present. */
  note?: string | null;
}

export default function LiveQualifiedTeamsPanel({ teams, expectedTeamCount, note }: Props) {
  const { t } = useT();

  const qualified = teams.filter(team => team.qualificationStatus === 'qualified');
  // Before the draw nothing is confirmed, so fall back to listing whatever we do know.
  const shown = qualified.length > 0 ? qualified : teams;

  return (
    <div className="rounded-lg border border-dashed p-6">
      <h3 className="font-semibold">{t('live.awaitingDraw.title')}</h3>

      <p className="mt-1 text-sm text-muted-foreground">
        {expectedTeamCount
          ? t('live.awaitingDraw.counted', {
              confirmed: qualified.length,
              expected: expectedTeamCount,
            })
          : t('live.awaitingDraw.uncounted')}
      </p>

      {note && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('live.awaitingDraw.noTeamsYet')}</p>
      ) : (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[...shown]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(team => (
              <li key={team.id} className="flex items-center gap-2 text-sm">
                {team.crestUrl ? (
                  <img src={team.crestUrl} alt="" aria-hidden className="h-5 w-5 object-contain" />
                ) : (
                  <span className="h-5 w-5 rounded-full bg-muted" aria-hidden />
                )}
                <span className="truncate">{team.shortName ?? team.name}</span>
                {team.qualificationStatus === 'pending' && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {t('live.qualification.pending')}
                  </span>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
