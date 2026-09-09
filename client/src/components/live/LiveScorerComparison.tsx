import { useMemo } from 'react';
import type { LivePlayer, LiveTeam } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';

// ── Actual against predicted ──────────────────────────────────────────────────
//
// Two rankings of the same shortlist: the order the goals have actually put the players
// in, and beside it — under it, on a narrow screen, where a full-width row is worth more
// than the side-by-side — the order the member submitted. Shown once the ranking has
// closed and somebody has scored: see LiveScorerPrediction for why it takes both.
//
// Goals and assists belong to where a player actually is, so they are on the real ranking
// alone. Against the guess the same number would only be the same number again.
//
// The columns hold the same players in different orders, so the comparison is carried by
// the rows themselves rather than by lines drawn between them: a player in exactly the
// position the member gave them is green on both sides, and every other row carries the
// position it holds in the other column. Reading across a row therefore always answers
// "and where is this one on the other list?".
//
// The glow an admin gave a player is drawn here as it is in the ranking, and gives way to
// green for the same reason: two glows on one row fight, and the exact hit is what the
// list is being read for.

interface Props {
  players: LivePlayer[];
  /** The clubs, for their crests — a player carries only a team id. */
  teams: LiveTeam[];
  /** The submitted ranking, reconciled against the current shortlist. Top first. */
  predictedOrder: string[];
  /** The ranking as the goals stand, settled the same way the final one will be. */
  actualOrder: string[];
  /** Points have been awarded, so the right-hand column is a finishing order, not a snapshot. */
  scored: boolean;
}

const COLUMN_HEADING = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

export default function LiveScorerComparison({
  players,
  teams,
  predictedOrder,
  actualOrder,
  scored,
}: Props) {
  const { t } = useT();

  const playerById = useMemo(() => new Map(players.map(p => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map(team => [team.id, team])), [teams]);

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

  // Exactly the thing the ranking scores: a player in the right place. There are no bands,
  // so this count is the whole story of how the prediction is doing.
  const exactCount = predictedOrder.filter((id, i) => actualPositionById.get(id) === i + 1).length;

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {t('live.scorers.compare.exactCount', { count: exactCount, total: predictedOrder.length })}
      </p>

      <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
        <section>
          <h3 className={COLUMN_HEADING}>
            {t(scored ? 'live.scorers.compare.actualFinal' : 'live.scorers.compare.actual')}
          </h3>
          <ol className="grid grid-cols-1 gap-1">
            {actualOrder.map((playerId, index) => {
              const predictedPosition = predictedPositionById.get(playerId) ?? null;
              return (
                <ComparisonRow
                  key={playerId}
                  playerId={playerId}
                  player={playerById.get(playerId) ?? null}
                  team={teamById.get(playerById.get(playerId)?.teamId ?? '') ?? null}
                  position={index + 1}
                  showTally
                  counterpartPosition={predictedPosition}
                  counterpartLabel={
                    predictedPosition === null
                      ? t('live.scorers.compare.notPredicted')
                      : t('live.scorers.compare.predictedAt', { position: predictedPosition })
                  }
                  exact={predictedPosition === index + 1}
                />
              );
            })}
          </ol>
        </section>

        <section>
          <h3 className={COLUMN_HEADING}>{t('live.scorers.compare.predicted')}</h3>
          <ol className="grid grid-cols-1 gap-1">
            {predictedOrder.map((playerId, index) => {
              const actualPosition = actualPositionById.get(playerId) ?? null;
              return (
                <ComparisonRow
                  key={playerId}
                  playerId={playerId}
                  player={playerById.get(playerId) ?? null}
                  team={teamById.get(playerById.get(playerId)?.teamId ?? '') ?? null}
                  position={index + 1}
                  showTally={false}
                  counterpartPosition={actualPosition}
                  counterpartLabel={
                    actualPosition === null
                      ? t('live.scorers.noFinish')
                      : t(
                          scored
                            ? 'live.scorers.compare.finishedAt'
                            : 'live.scorers.compare.currentlyAt',
                          { position: actualPosition },
                        )
                  }
                  exact={actualPosition === index + 1}
                />
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

interface RowProps {
  playerId: string;
  player: LivePlayer | null;
  team: LiveTeam | null;
  /** Where this row sits in its own column. */
  position: number;
  /** Goals and assists, carried by the real ranking only. */
  showTally: boolean;
  /** Where the same player sits in the other column, or null if it does not hold them. */
  counterpartPosition: number | null;
  /** What that position means, spelled out for a title and for screen readers. */
  counterpartLabel: string;
  exact: boolean;
}

function ComparisonRow({
  playerId,
  player,
  team,
  position,
  showTally,
  counterpartPosition,
  counterpartLabel,
  exact,
}: RowProps) {
  const { t } = useT();
  const name = player?.name ?? playerId;
  const glow = !exact ? (player?.glowColor ?? null) : null;

  return (
    <li
      className={`flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 ${
        exact ? 'border-green-500/60 bg-green-500/5' : ''
      }`}
      // Inline because the colour is per player and arbitrary — the same glow the ranking
      // draws, so a player is recognisable across both views.
      style={
        glow
          ? {
              borderColor: `${glow}99`,
              boxShadow: `0 0 12px -2px ${glow}66, inset 0 0 24px -14px ${glow}`,
            }
          : undefined
      }
    >
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
        {position}
      </span>

      {player?.imageUrl ? (
        <img
          src={player.imageUrl}
          alt=""
          aria-hidden
          className="h-7 w-7 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="h-7 w-7 shrink-0 rounded-full bg-muted" aria-hidden />
      )}

      {team?.crestUrl ? (
        <img src={team.crestUrl} alt="" aria-hidden className="h-5 w-5 shrink-0 object-contain" />
      ) : (
        <span className="h-5 w-5 shrink-0" aria-hidden />
      )}

      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>

      {showTally && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {t('live.scorers.tally', { goals: player?.goals ?? 0, assists: player?.assists ?? 0 })}
        </span>
      )}

      {/* Where the same player sits on the other list — the one thing that makes reading
          across a row worth doing. A row already green is in both places at once, so it
          gets the tick instead of a number it would only repeat. */}
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
