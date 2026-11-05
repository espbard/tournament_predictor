import { z } from 'zod';
import { LIVE_MAX_MULTIPLIER, LIVE_MIN_MULTIPLIER, type LiveFixtureView } from './types';

// ── Bonus rounds ──────────────────────────────────────────────────────────────
//
// Extra rounds of match predictions inside one live competition, made of fixtures that
// an admin hand-picks from *other* live tournaments — the UEFA Nations League to begin
// with, a tournament that exists only to lend its fixtures this way (`is_bonus_source`).
// A round may take fixtures from several matchdays, and could take them from several
// source tournaments.
//
// Only match predictions: a bonus round has no table, scorers or questions. Scoring is the
// competition's own three tiers, with a per-match multiplier set on the round.
//
// A round sits *between* the competition's own rounds. Its anchor says where:
//
//   afterStageKey  afterMatchday   placed
//   table stage    N               in that stage's gameweek strip, after gameweek N
//   any stage      null            after the whole stage, between the stage pills
//   null           null            before everything
//
// This module is the single source of truth for that placement, used by the fixtures tab
// and the admin's "place after" dropdown alike.

/** Who can see a round. 'test' is test accounts and admins only. */
export type LiveBonusRoundVisibility = 'test' | 'everyone';

export const LIVE_BONUS_ROUND_VISIBILITIES: LiveBonusRoundVisibility[] = ['test', 'everyone'];

export interface LiveBonusRoundAnchor {
  afterStageKey: string | null;
  afterMatchday: number | null;
}

export interface LiveBonusRound extends LiveBonusRoundAnchor {
  id: string;
  liveCompetitionId: string;
  name: string;
  visibility: LiveBonusRoundVisibility;
  createdAt: string;
  updatedAt: string;
}

/**
 * A bonus-round match as the fixtures tab renders it — the ordinary fixture view, so the
 * same cards draw it, with three things made to mean the round rather than the source:
 * `multiplier` is the round's, `normalTime*` is the score the round scores on (the
 * admin's override where set), and `prediction` is the caller's bonus-round prediction.
 */
export interface LiveBonusRoundFixtureView extends LiveFixtureView {
  sourceTournamentId: string;
  sourceTournamentName: string;
  /** The score shown is an admin override, not the provider's. */
  scoreOverridden: boolean;
}

export interface LiveBonusRoundView extends LiveBonusRound {
  fixtures: LiveBonusRoundFixtureView[];
  /** ISO 8601, the earliest kickoff among the fixtures. Null for an empty round. */
  firstKickoffAt: string | null;
}

/** Whether a user may see a round at all. Admins and test accounts see every round. */
export function canSeeLiveBonusRound(
  user: { isAdmin: boolean; isTestAccount: boolean },
  round: { visibility: LiveBonusRoundVisibility | string },
): boolean {
  return user.isAdmin || user.isTestAccount || round.visibility === 'everyone';
}

// ── Placement ─────────────────────────────────────────────────────────────────

/** A stage as the fixtures tab lists it: in order, with the gameweeks it has. */
export interface LiveRoundLayoutStage {
  key: string;
  kind: 'table' | 'knockout';
  /** The stage's gameweeks, ascending. Only meaningful for a table stage. */
  matchdays: number[];
}

/** A round as placement needs it: its anchor, and its first kickoff for ordering. */
export interface PlaceableBonusRound extends LiveBonusRoundAnchor {
  id: string;
  /** ISO 8601. Breaks ties between rounds sharing an anchor; null sorts last. */
  firstKickoffAt: string | null;
}

export type LiveRoundLayoutItem<R> =
  | { type: 'stage'; stageKey: string }
  | { type: 'bonus'; round: R };

export interface LiveRoundLayout<R> {
  /** Stage pills and the bonus rounds placed between them, in order. */
  top: LiveRoundLayoutItem<R>[];
  /**
   * Per table stage: the bonus rounds that sit after each of its gameweeks, keyed by
   * matchday. Shown in that stage's gameweek strip.
   */
  inStage: Map<string, Map<number, R[]>>;
}

function byKickoff(a: PlaceableBonusRound, b: PlaceableBonusRound): number {
  const ak = a.firstKickoffAt ?? '￿';
  const bk = b.firstKickoffAt ?? '￿';
  return ak === bk ? a.id.localeCompare(b.id) : ak.localeCompare(bk);
}

/**
 * Lay the competition's stages, gameweeks and bonus rounds out in one order.
 *
 * Forgiving by design, because an anchor can outlive what it points at — a stage the
 * provider has not filled yet, a gameweek that was renumbered:
 *
 *   - a matchday anchor on a knockout stage is treated as "after the stage";
 *   - a matchday the stage does not have goes after the nearest gameweek below it, or
 *     before the stage's first gameweek when there is none below;
 *   - a stage that is not in the list puts the round at the very end, so it is never lost.
 */
export function layoutLiveRounds<R extends PlaceableBonusRound>(
  stages: LiveRoundLayoutStage[],
  rounds: R[],
): LiveRoundLayout<R> {
  const sorted = [...rounds].sort(byKickoff);
  const stageByKey = new Map(stages.map(s => [s.key, s]));

  const beforeAll: R[] = [];
  const afterStage = new Map<string, R[]>();
  const orphans: R[] = [];
  const inStage = new Map<string, Map<number, R[]>>();

  for (const round of sorted) {
    if (round.afterStageKey === null) {
      beforeAll.push(round);
      continue;
    }
    const stage = stageByKey.get(round.afterStageKey);
    if (!stage) {
      orphans.push(round);
      continue;
    }
    if (round.afterMatchday === null || stage.kind !== 'table' || stage.matchdays.length === 0) {
      const bucket = afterStage.get(stage.key) ?? [];
      bucket.push(round);
      afterStage.set(stage.key, bucket);
      continue;
    }

    // The gameweek it goes after: the anchor itself, or the nearest one below it. None
    // below means "before the first gameweek", which is stored under matchday 0.
    const below = stage.matchdays.filter(m => m <= round.afterMatchday!);
    const slot = below.length > 0 ? below[below.length - 1] : 0;
    const byMatchday = inStage.get(stage.key) ?? new Map<number, R[]>();
    const bucket = byMatchday.get(slot) ?? [];
    bucket.push(round);
    byMatchday.set(slot, bucket);
    inStage.set(stage.key, byMatchday);
  }

  const top: LiveRoundLayoutItem<R>[] = beforeAll.map(round => ({ type: 'bonus', round }));
  for (const stage of stages) {
    top.push({ type: 'stage', stageKey: stage.key });
    for (const round of afterStage.get(stage.key) ?? []) top.push({ type: 'bonus', round });
  }
  for (const round of orphans) top.push({ type: 'bonus', round });

  return { top, inStage };
}

/** One entry of a table stage's gameweek strip: a gameweek, or a bonus round after one. */
export type LiveGameweekStripItem<R> =
  | { type: 'gameweek'; matchday: number }
  | { type: 'bonus'; round: R };

/** A table stage's gameweeks with its bonus rounds interleaved, for the progress strip. */
export function gameweekStrip<R>(
  matchdays: number[],
  roundsAfter: Map<number, R[]> | undefined,
): LiveGameweekStripItem<R>[] {
  const items: LiveGameweekStripItem<R>[] = [];
  for (const round of roundsAfter?.get(0) ?? []) items.push({ type: 'bonus', round });
  for (const matchday of matchdays) {
    items.push({ type: 'gameweek', matchday });
    for (const round of roundsAfter?.get(matchday) ?? []) items.push({ type: 'bonus', round });
  }
  return items;
}

/** A gameweek or stage the admin can place a round after, with when it starts. */
export interface LiveAnchorOption extends LiveBonusRoundAnchor {
  /** ISO 8601 first kickoff of the gameweek or stage. Null when it has no dated fixture. */
  firstKickoffAt: string | null;
}

/**
 * The anchor a new round most likely wants: after the last gameweek or stage that starts
 * before the round's first match. Null (before everything) when nothing does.
 *
 * `options` must be in display order — each table stage's gameweeks followed by the
 * stage itself, stage by stage.
 */
export function suggestLiveBonusRoundAnchor(
  options: LiveAnchorOption[],
  roundFirstKickoffAt: string | null,
): LiveBonusRoundAnchor {
  const none: LiveBonusRoundAnchor = { afterStageKey: null, afterMatchday: null };
  if (!roundFirstKickoffAt) return none;

  let best: LiveAnchorOption | null = null;
  for (const option of options) {
    if (option.firstKickoffAt && option.firstKickoffAt < roundFirstKickoffAt) best = option;
  }
  if (!best) return none;
  return { afterStageKey: best.afterStageKey, afterMatchday: best.afterMatchday };
}

// ── Scores ────────────────────────────────────────────────────────────────────

/**
 * The end-of-normal-time score a bonus round scores on: the admin's override when both
 * halves are set, the provider's otherwise. See `score_override_*` on live_fixtures.
 */
export function bonusRoundScore(fixture: {
  normalTimeHome: number | null;
  normalTimeAway: number | null;
  scoreOverrideHome: number | null;
  scoreOverrideAway: number | null;
}): { home: number | null; away: number | null; overridden: boolean } {
  if (fixture.scoreOverrideHome !== null && fixture.scoreOverrideAway !== null) {
    return { home: fixture.scoreOverrideHome, away: fixture.scoreOverrideAway, overridden: true };
  }
  return { home: fixture.normalTimeHome, away: fixture.normalTimeAway, overridden: false };
}

// ── Request schemas ───────────────────────────────────────────────────────────

const anchorFields = {
  afterStageKey: z.string().min(1).max(64).nullable(),
  afterMatchday: z.number().int().min(0).max(1000).nullable(),
};

export const CreateLiveBonusRoundSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ...anchorFields,
  visibility: z.enum(['test', 'everyone']).optional(),
});

export const UpdateLiveBonusRoundSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    afterStageKey: anchorFields.afterStageKey.optional(),
    afterMatchday: anchorFields.afterMatchday.optional(),
    visibility: z.enum(['test', 'everyone']).optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const SetLiveBonusRoundFixturesSchema = z.object({
  fixtures: z
    .array(
      z.object({
        fixtureId: z.string().min(1),
        multiplier: z.number().int().min(LIVE_MIN_MULTIPLIER).max(LIVE_MAX_MULTIPLIER).default(1),
      }),
    )
    .max(100),
  /**
   * Removing a fixture deletes the predictions already made on it in this competition.
   * Refused unless this is set, so it is never done by accident.
   */
  force: z.boolean().optional(),
});

export const SaveLiveBonusRoundPredictionSchema = z.object({
  fixtureId: z.string().min(1),
  homeScore: z.number().int().min(0).max(99),
  awayScore: z.number().int().min(0).max(99),
});

export const SetLiveFixtureScoreOverrideSchema = z.object({
  /** Both null clears the override. */
  homeScore: z.number().int().min(0).max(99).nullable(),
  awayScore: z.number().int().min(0).max(99).nullable(),
});

export type CreateLiveBonusRoundInput = z.infer<typeof CreateLiveBonusRoundSchema>;
export type UpdateLiveBonusRoundInput = z.infer<typeof UpdateLiveBonusRoundSchema>;
export type SetLiveBonusRoundFixturesInput = z.infer<typeof SetLiveBonusRoundFixturesSchema>;
export type SaveLiveBonusRoundPredictionInput = z.infer<typeof SaveLiveBonusRoundPredictionSchema>;
