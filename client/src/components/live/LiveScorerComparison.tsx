import { useMemo } from 'react';
import type { LivePlayer, LiveTeam } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';

// ── Actual against predicted ──────────────────────────────────────────────────
//
// Two rankings of the same shortlist, side by side: the order the goals have actually put
// the players in, and beside it the order the member submitted. Shown once the ranking has
// closed and somebody has scored — see LiveScorerPrediction for why it takes both.
//
// The columns hold the same players in different orders, so the comparison is carried by
// the rows themselves rather than by lines drawn between them: a player in exactly the
// position the member gave them is green on both sides, and every other row carries the
// position it holds in the other column. Reading across a row therefore always answers
// "and where is this one on the other list?".
//
// Both columns are on screen at every width, phones included, which is what the row is
// built around. It is why goals and assists appear on the real ranking only — the number
// belongs to where a player actually is, and repeating it against the guess would cost the
// width two names need — why the tally is the bare pair with the words in its tooltip, and
// why the crest and the face wait for a screen wide enough to spare them.
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
  /** Points have been awarded, so the real column is a finishing order, not a snapshot. */
  scored: boolean;
}

const COLUMN_HEADING = 'mb-1.5 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

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

      <div className="grid grid-cols-2 gap-x-2 sm:gap-x-4">
        <section className="min-w-0">
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

        <section className="min-w-0">
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

  const goals = player?.goals ?? 0;
  const assists = player?.assists ?? 0;
  // The words the pair of numbers stands for: a tooltip on a pointer, and the only thing a
  // screen reader is given, since "9 · 2" read aloud is not worth hearing.
  const tallyLabel = t('live.scorers.tally', { goals, assists });

  return (
    <li
      className={`flex items-center gap-1 rounded-md border bg-background px-1 py-1 sm:gap-2 sm:px-2 sm:py-1.5 ${
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
      <span className="w-3.5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground sm:w-5 sm:text-sm">
        {position}
      </span>

      {/* Decoration, and the first thing to go when the two columns have to share a phone. */}
      {player?.imageUrl ? (
        <img
          src={player.imageUrl}
          alt=""
          aria-hidden
          className="hidden h-6 w-6 shrink-0 rounded-full object-cover sm:block"
        />
      ) : (
        <span className="hidden h-6 w-6 shrink-0 rounded-full bg-muted sm:block" aria-hidden />
      )}

      {team?.crestUrl ? (
        <img
          src={team.crestUrl}
          alt=""
          aria-hidden
          className="hidden h-4 w-4 shrink-0 object-contain sm:block"
        />
      ) : (
        <span className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
      )}

      <span className="min-w-0 flex-1 truncate text-xs sm:text-sm" title={name}>
        {name}
      </span>

      {showTally && (
        <span
          className="shrink-0 text-[10px] tabular-nums text-muted-foreground sm:text-xs"
          title={tallyLabel}
        >
          <span aria-hidden>{t('live.scorers.tallyShort', { goals, assists })}</span>
          <span className="sr-only">{tallyLabel}</span>
        </span>
      )}

      {/* Where the same player sits on the other list — the one thing that makes reading
          across a row worth doing. A row already green is in both places at once, so it
          gets the tick instead of a number it would only repeat. */}
      <span
        className={`w-5 shrink-0 text-right text-[10px] tabular-nums sm:w-8 sm:text-xs ${
          exact ? 'font-semibold text-green-700 dark:text-green-400' : 'text-muted-foreground'
        }`}
        title={counterpartLabel}
      >
        <span aria-hidden>
          {exact ? '✓' : counterpartPosition !== null ? `#${counterpartPosition}` : '–'}
        </span>
        <span className="sr-only">{counterpartLabel}</span>
      </span>
    </li>
  );
}
