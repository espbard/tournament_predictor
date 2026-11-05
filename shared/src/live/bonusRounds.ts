import { z } from 'zod';
import { LIVE_MAX_MULTIPLIER, LIVE_MIN_MULTIPLIER, type LiveFixtureView } from './types';

// ── Bonus rounds ──────────────────────────────────────────────────────────────
//
// Extra rounds of match predictions inside one live competition, made of matches an admin
// sets up by hand: two team names, a kickoff and, once played, the score after 90 minutes.
// The same way the manual tournament type works, rather than through a data provider.
// They are typically matches from another competition — the UEFA Nations League to begin
// with — from any dates, in any number.
//
// Only match predictions: a bonus round has no table, scorers or questions. Scoring is the
// competition's own three tiers, with a per-match multiplier.
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
 * A bonus-round match as the fixtures tab renders it: shaped as the ordinary fixture view,
 * so the same cards draw it. The teams are bonus teams (name + logo, as `crestUrl`);
 * `normalTime*` is the admin's result and `prediction` the caller's bonus-round prediction.
 */
export interface LiveBonusRoundFixtureView extends LiveFixtureView {
  /** Free text the admin gave the match, such as "UEFA Nations League". */
  label: string | null;
}

/** A hand-entered match as stored, for the admin page. */
export interface LiveBonusFixture {
  id: string;
  bonusRoundId: string;
  liveCompetitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  label: string | null;
  kickoffAt: string;
  multiplier: number;
  homeScore: number | null;
  awayScore: number | null;
}

export interface LiveBonusRoundView extends LiveBonusRound {
  fixtures: LiveBonusRoundFixtureView[];
  /** ISO 8601, the earliest kickoff among the fixtures. Null for an empty round. */
  firstKickoffAt: string | null;
}

/** A team bonus-round matches can be played by. */
export interface LiveBonusTeam {
  id: string;
  name: string;
  imageUrl: string | null;
}

/**
 * One entry of the admin's team picker. `bonus` is a registered bonus team; `manual` and
 * `live` are teams of a manual or live tournament, offered so they need not be set up
 * again. Picking one of those registers it as a bonus team when the match is saved — their
 * `id` is prefixed (`manual:<id>`, `live:<id>`) so the server can tell.
 */
export interface LiveBonusTeamOption extends LiveBonusTeam {
  source: 'bonus' | 'manual' | 'live';
}

/** Prefix on a picker id that names a team of another tournament, not a bonus team. */
export const BONUS_TEAM_SOURCE_PREFIXES = ['manual:', 'live:'] as const;

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

// ── The next round ────────────────────────────────────────────────────────────

/** A competition fixture, as far as deciding the next round goes. */
export interface NextRoundFixture {
  kickoffAt: string | null;
  stageKey: string | null;
  matchday: number | null;
}

export type NextLiveRound =
  | { type: 'gameweek'; stageKey: string | null; matchday: number | null }
  | { type: 'bonus'; roundId: string };

/**
 * Which round comes next: the one holding the earliest kickoff among the given matches,
 * whether that is one of the competition's own gameweeks or a bonus round. The caller
 * decides what "still to come" means — still open to predict, or not yet finished — and
 * passes only those matches. Null when there are none.
 *
 * A bonus round has to kick off strictly earlier to win a tie, so a round of borrowed
 * matches never hides a gameweek starting at the same moment.
 */
export function nextLiveRound<R extends { id: string }>(
  fixtures: NextRoundFixture[],
  bonusRounds: Array<{ round: R; fixtures: Array<{ kickoffAt: string | null }> }>,
): NextLiveRound | null {
  let best: { at: string; next: NextLiveRound } | null = null;

  for (const f of fixtures) {
    if (!f.kickoffAt) continue;
    if (!best || f.kickoffAt < best.at) {
      best = { at: f.kickoffAt, next: { type: 'gameweek', stageKey: f.stageKey, matchday: f.matchday } };
    }
  }
  for (const { round, fixtures: matches } of bonusRounds) {
    for (const f of matches) {
      if (!f.kickoffAt) continue;
      if (!best || f.kickoffAt < best.at) best = { at: f.kickoffAt, next: { type: 'bonus', roundId: round.id } };
    }
  }
  return best?.next ?? null;
}

// ── Results ───────────────────────────────────────────────────────────────────

/** A hand-entered match is finished once both halves of its result are set. */
export function bonusFixtureStatus(fixture: {
  homeScore: number | null;
  awayScore: number | null;
}): 'scheduled' | 'finished' {
  return fixture.homeScore !== null && fixture.awayScore !== null ? 'finished' : 'scheduled';
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

/** A bonus team id, or a picker id naming another tournament's team (`manual:…`, `live:…`). */
const teamRef = z.string().min(1).max(80);
const score = z.number().int().min(0).max(99);

export const CreateLiveBonusTeamSchema = z.object({
  name: z.string().trim().min(1).max(60),
  imageUrl: z.string().max(500).nullable().optional(),
});

export const CreateLiveBonusFixtureSchema = z
  .object({
    homeTeamId: teamRef,
    awayTeamId: teamRef,
    label: z.string().trim().max(60).nullable().optional(),
    /** ISO 8601. */
    kickoffAt: z.string().datetime({ offset: true }),
    multiplier: z.number().int().min(LIVE_MIN_MULTIPLIER).max(LIVE_MAX_MULTIPLIER).default(1),
  })
  .refine(v => v.homeTeamId !== v.awayTeamId, { message: 'A team cannot play itself' });

export const UpdateLiveBonusFixtureSchema = z
  .object({
    homeTeamId: teamRef.optional(),
    awayTeamId: teamRef.optional(),
    label: z.string().trim().max(60).nullable().optional(),
    kickoffAt: z.string().datetime({ offset: true }).optional(),
    multiplier: z.number().int().min(LIVE_MIN_MULTIPLIER).max(LIVE_MAX_MULTIPLIER).optional(),
    /** The score after 90 minutes. Both null clears the result; one alone is refused. */
    homeScore: score.nullable().optional(),
    awayScore: score.nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine(
    v =>
      (v.homeScore === undefined) === (v.awayScore === undefined) &&
      (v.homeScore === null) === (v.awayScore === null),
    { message: 'Set both scores, or clear both' },
  );

export const SaveLiveBonusRoundPredictionSchema = z.object({
  fixtureId: z.string().min(1),
  homeScore: score,
  awayScore: score,
});

export type CreateLiveBonusRoundInput = z.infer<typeof CreateLiveBonusRoundSchema>;
export type UpdateLiveBonusRoundInput = z.infer<typeof UpdateLiveBonusRoundSchema>;
export type CreateLiveBonusTeamInput = z.infer<typeof CreateLiveBonusTeamSchema>;
export type CreateLiveBonusFixtureInput = z.infer<typeof CreateLiveBonusFixtureSchema>;
export type UpdateLiveBonusFixtureInput = z.infer<typeof UpdateLiveBonusFixtureSchema>;
export type SaveLiveBonusRoundPredictionInput = z.infer<typeof SaveLiveBonusRoundPredictionSchema>;
