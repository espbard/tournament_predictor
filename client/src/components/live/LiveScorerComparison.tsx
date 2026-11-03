import { useMemo, useState } from 'react';
import type { LivePlayer, LiveTeam } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';

// ── Predicted against actual ──────────────────────────────────────────────────
//
// Two rankings of the same shortlist, side by side at every width: the order the member
// submitted, and beside it the order the goals have actually put the players in. On a
// narrow screen the rows shed the player's photo and the goal tally so the names still
// fit two to a line. Shown once the
// ranking has closed and somebody has scored: see LiveScorerPrediction for why it takes
// both.
//
// Goals and assists belong to where a player actually is, so they are on the real ranking
// alone. Against the guess the same number would only be the same number again.
//
// The columns hold the same players in different orders, so the comparison is carried by
// the rows themselves rather than by lines drawn between them: on the predicted list, a
// player in exactly the position the member gave them is green. The real ranking is left
// plain for reference. Hovering a player on either list makes the same player glow on
// the other, to keep the two narrow columns uncluttered.

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
  /** Heading for the left-hand column, when it is somebody else's ranking. */
  predictedLabel?: string;
}

// The glow on the counterpart of the row under the pointer.
const HOVER_GLOW = 'ring-2 ring-primary/70 shadow-[0_0_14px_-2px_hsl(var(--primary)/0.6)]';

type Side = 'predicted' | 'actual';

const COLUMN_HEADING = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

export default function LiveScorerComparison({
  players,
  teams,
  predictedOrder,
  actualOrder,
  scored,
  predictedLabel,
}: Props) {
  const { t } = useT();
  // The row under the pointer, and which column it is in: the same entry on the other
  // column glows so it can be found at a glance.
  const [hovered, setHovered] = useState<{ id: string; side: Side } | null>(null);
  const glowsOn = (side: Side, id: string) =>
    hovered !== null && hovered.side !== side && hovered.id === id;

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

      <div className="grid grid-cols-2 gap-x-2 sm:gap-x-4">
        <section>
          <h3 className={COLUMN_HEADING}>{predictedLabel ?? t('live.scorers.compare.predicted')}</h3>
          <ol className="grid grid-cols-1 gap-1">
            {predictedOrder.map((playerId, index) => {
              const actualPosition = actualPositionById.get(playerId) ?? null;
              return (
                <ComparisonRow
                  key={playerId}
                  highlighted={glowsOn('predicted', playerId)}
                  onHoverChange={over =>
                    setHovered(over ? { id: playerId, side: 'predicted' } : null)
                  }
                  playerId={playerId}
                  player={playerById.get(playerId) ?? null}
                  team={teamById.get(playerById.get(playerId)?.teamId ?? '') ?? null}
                  position={index + 1}
                  showTally={false}
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
                  highlighted={glowsOn('actual', playerId)}
                  onHoverChange={over =>
                    setHovered(over ? { id: playerId, side: 'actual' } : null)
                  }
                  playerId={playerId}
                  player={playerById.get(playerId) ?? null}
                  team={teamById.get(playerById.get(playerId)?.teamId ?? '') ?? null}
                  position={index + 1}
                  showTally
                  counterpartLabel={
                    predictedPosition === null
                      ? t('live.scorers.compare.notPredicted')
                      : t('live.scorers.compare.predictedAt', { position: predictedPosition })
                  }
                  exact={false}
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
  /** Where the same row sits on the other list, for screen readers. */
  counterpartLabel: string;
  /** The same entry is under the pointer on the other list. */
  highlighted: boolean;
  onHoverChange: (over: boolean) => void;
  exact: boolean;
}

function ComparisonRow({
  playerId,
  player,
  team,
  position,
  showTally,
  counterpartLabel,
  highlighted,
  onHoverChange,
  exact,
}: RowProps) {
  const { t } = useT();
  const name = player?.name ?? playerId;

  return (
    <li
      className={`flex items-center gap-1.5 rounded border bg-background transition-shadow px-1.5 py-1.5 sm:gap-2 sm:px-2 ${
        exact ? 'border-green-500/60 bg-green-500/5' : ''
      } ${highlighted ? HOVER_GLOW : ''}`}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <span className="w-5 shrink-0 text-right text-sm tabular-nums text-muted-foreground sm:w-6">
        {position}
      </span>

      {player?.imageUrl ? (
        <img
          src={player.imageUrl}
          alt=""
          aria-hidden
          className="hidden h-7 w-7 shrink-0 rounded-full object-cover sm:block"
        />
      ) : (
        <span className="hidden h-7 w-7 shrink-0 rounded-full bg-muted sm:block" aria-hidden />
      )}

      {team?.crestUrl ? (
        <img src={team.crestUrl} alt="" aria-hidden className="h-5 w-5 shrink-0 object-contain" />
      ) : (
        <span className="h-5 w-5 shrink-0" aria-hidden />
      )}

      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>

      {showTally && (
        <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
          {t('live.scorers.tally', { goals: player?.goals ?? 0, assists: player?.assists ?? 0 })}
        </span>
      )}

      <span className="sr-only">{counterpartLabel}</span>
    </li>
  );
}
