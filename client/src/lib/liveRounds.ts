import type { LiveStageDef } from '@tournament-predictor/shared';

// ── Naming a round ────────────────────────────────────────────────────────────
//
// A round is one (stage, matchday) pair. A table stage's rounds are its gameweeks; each
// leg of a two-legged knockout stage is a round of its own, numbered by leg; a
// single-legged knockout stage (the final) is one round. See shared/src/live/rounds.ts.

type T = (key: string, params?: Record<string, string | number>) => string;

/** The short name of one round: "Gameweek 3", "1st leg", or the stage name for a final. */
export function liveRoundShortName(
  t: T,
  stage: Pick<LiveStageDef, 'kind' | 'legs' | 'labelKey'> | null | undefined,
  matchday: number,
): string {
  if (!stage || stage.kind === 'table') return t('live.gameweekHeading', { matchday });
  if (stage.legs === 2 && (matchday === 1 || matchday === 2)) return t(`live.knockoutLeg.${matchday}`);
  return t(stage.labelKey);
}

/** The heading over one round: "Gameweek 3", "Round of 16: 1st leg", "Final". */
export function liveRoundHeading(
  t: T,
  stage: Pick<LiveStageDef, 'kind' | 'legs' | 'labelKey'> | null | undefined,
  matchday: number,
): string {
  if (stage?.kind === 'knockout' && stage.legs === 2 && (matchday === 1 || matchday === 2)) {
    return t('live.knockoutLegHeading', {
      stage: t(stage.labelKey),
      leg: t(`live.knockoutLeg.${matchday}`),
    });
  }
  return liveRoundShortName(t, stage, matchday);
}

// ── One strip for the whole competition ───────────────────────────────────────
//
// Every round of every stage on one progress bar, in order: the league phase's gameweeks,
// then each knockout leg, then the final. A dot picks a stage and a round together, so no
// stage tabs are needed. Bonus rounds are stars placed among the dots.

/** One dot of the strip. */
export interface LiveStripRound {
  key: string;
  stageKey: string;
  matchday: number;
}

export function liveRoundKey(stageKey: string, matchday: number): string {
  return `${stageKey}#${matchday}`;
}

/**
 * The strip's rounds, stage by stage in the order given (the format's), each stage's rounds
 * ascending. A round comes from a fixture's matchday or from the round calendar, so a
 * knockout leg nobody has fetched matches for yet still has its dot.
 */
export function buildLiveRoundStrip(
  stages: Array<{ key: string }>,
  fixtures: Array<{ stageKey: string | null; matchday: number | null }>,
  calendar: Array<{ stageKey: string; matchday: number }> = [],
): LiveStripRound[] {
  return stages.flatMap(stage => {
    const matchdays = new Set<number>();
    for (const f of fixtures) if (f.stageKey === stage.key && f.matchday != null) matchdays.add(f.matchday);
    for (const r of calendar) if (r.stageKey === stage.key) matchdays.add(r.matchday);
    return [...matchdays]
      .sort((a, b) => a - b)
      .map(matchday => ({ key: liveRoundKey(stage.key, matchday), stageKey: stage.key, matchday }));
  });
}

/**
 * Where each bonus round goes on the strip: the key of the dot it follows, or null for
 * before the first. Read off layoutLiveRounds, which decides placement for the app:
 *
 *   after a gameweek       after that gameweek's dot
 *   before a stage's first gameweek (slot 0)   after the previous stage's last dot
 *   after a whole stage    after that stage's last dot
 *   before everything      at the very start
 *   an anchor that is gone at the very end
 */
export function placeBonusRoundsOnStrip<R>(
  layout: { top: Array<{ type: 'stage'; stageKey: string } | { type: 'bonus'; round: R }>; inStage: Map<string, Map<number, R[]>> },
  strip: LiveStripRound[],
): Array<{ round: R; afterKey: string | null }> {
  const out: Array<{ round: R; afterKey: string | null }> = [];
  const lastOfStage = (stageKey: string) => [...strip].reverse().find(r => r.stageKey === stageKey)?.key;

  let lastKey: string | null = null;
  for (const item of layout.top) {
    if (item.type === 'stage') {
      lastKey = lastOfStage(item.stageKey) ?? lastKey;
    } else {
      out.push({ round: item.round, afterKey: lastKey });
    }
  }

  for (const [stageKey, byMatchday] of layout.inStage) {
    const firstIndex = strip.findIndex(r => r.stageKey === stageKey);
    for (const [matchday, rounds] of byMatchday) {
      const afterKey =
        matchday > 0
          ? liveRoundKey(stageKey, matchday)
          : firstIndex > 0
            ? strip[firstIndex - 1].key
            : null;
      for (const round of rounds) out.push({ round, afterKey });
    }
  }
  return out;
}

/** Whether a stage's round is drawn as a trophy on the strip: a single-legged knockout stage, the final. */
export function isTrophyStage(stage: Pick<LiveStageDef, 'kind' | 'legs'> | null | undefined): boolean {
  return !!stage && stage.kind === 'knockout' && stage.legs === 1;
}
