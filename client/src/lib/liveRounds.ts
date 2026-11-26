import type { LiveStageDef } from '@tournament-predictor/shared';

// ── Naming a round ────────────────────────────────────────────────────────────
//
// A round is one (stage, matchday) pair. A table stage's rounds are its gameweeks; each
// leg of a two-legged knockout stage is a round of its own, numbered by leg; a
// single-legged knockout stage (the final) is one round. See shared/src/live/rounds.ts.

type T = (key: string, params?: Record<string, string | number>) => string;

/** Whether a stage is paged round by round, with the gameweek strip above it. */
export function isRoundedStage(stage: Pick<LiveStageDef, 'kind' | 'legs'> | null | undefined): boolean {
  return !!stage && (stage.kind === 'table' || stage.legs === 2);
}

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
