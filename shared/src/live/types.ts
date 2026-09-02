// ── Live (API-linked) tournaments ─────────────────────────────────────────────
//
// This module is the type surface for the *live* tournament type — tournaments bound
// to a real competition through a data provider. It is deliberately independent of the
// manual tournament types in ../types.ts: nothing here should be merged with
// Tournament / Team / Match / Competition / Prediction.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md.

/**
 * Providers we can read from.
 *
 * `big_balls` (bigballsdata.com) serves *fixtures only* — see the adapter for what its
 * match schema does and does not carry. A tournament names a provider for teams and
 * standings and may name a different one for fixtures; see `fixtureProvider`.
 */
export type LiveProviderId = 'football_data' | 'big_balls';

/** Normalised fixture status. Provider-specific values are mapped onto these. */
export type LiveFixtureStatus =
  | 'scheduled'
  | 'in_play'
  | 'paused'
  | 'finished'
  | 'postponed'
  | 'suspended'
  | 'cancelled';

export type LiveTournamentStatus = 'upcoming' | 'active' | 'completed';

/**
 * Whether a team has reached the part of the competition we actually predict on.
 * Derived from the provider's data, never set by hand — see the sync engine.
 */
export type LiveQualificationStatus = 'qualified' | 'pending' | 'eliminated';

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Three stacking tiers, evaluated per fixture against the end-of-normal-time score.
 * The tiers are nested — an exact scoreline necessarily also has the right goal
 * difference and outcome — so the awarded values simply add. Max 4 points by default.
 */
/**
 * The provider's scorer feed folded into goals per nationality, stored on the tournament.
 *
 * A snapshot rather than a live query: it is rebuilt whole every time the shortlist's
 * goals are refreshed, from the same payload, so it costs no extra provider request.
 *
 * `truncated` is the honest part. The feed is a *ranked* list capped at a limit, so a
 * competition with more scorers than that limit returns its top N and omits the tail of
 * one-goal players. When it is set, every total here is a floor rather than a total, and
 * anything reading them has to say so.
 */
export interface LiveScorerNationalities {
  /** ISO 8601, when the feed this was folded from was fetched. */
  fetchedAt: string;
  /** How many rows the feed returned. */
  count: number;
  /** The feed came back at the request limit, so the totals below are floors. */
  truncated: boolean;
  /** Keyed by the provider's own English country name, kept verbatim. */
  byNationality: Record<string, { goals: number; players: number }>;
}

export interface LiveScoringConfig {
  correct_outcome: number;
  correct_goal_difference: number;
  exact_score: number;
  /** Per team placed in exactly the right final table position. Worth more than a band. */
  table_exact_position: number;
  /**
   * Per team placed in the right band of the table (Champions League: top 8, 9th–24th,
   * 25th and below). Stacks with the exact-position award, so a team in exactly the right
   * place is worth both — 3 points by default. Formats without bands never award this.
   */
  table_correct_band: number;
  /**
   * Per player placed in exactly the right position of the final top-scorer ranking.
   * That ranking has no bands — a player is in the right place or is not.
   */
  scorer_exact_position: number;
}

export const DEFAULT_LIVE_SCORING_CONFIG: LiveScoringConfig = {
  correct_outcome: 1,
  correct_goal_difference: 1,
  exact_score: 2,
  table_exact_position: 2,
  table_correct_band: 1,
  scorer_exact_position: 2,
};

/**
 * Fill in any tier missing from a stored config.
 *
 * Competitions created before a tier existed have a JSON blob without it, and arithmetic
 * on `undefined` would silently produce NaN points. Always read a stored config through
 * this rather than using it directly.
 */
export function withLiveScoringDefaults(
  config: Partial<LiveScoringConfig> | null | undefined,
): LiveScoringConfig {
  return { ...DEFAULT_LIVE_SCORING_CONFIG, ...(config ?? {}) };
}

// ── Fixture point multipliers ─────────────────────────────────────────────────

/**
 * Bounds on a fixture's multiplier. Whole numbers only, and never below 1: a multiplier
 * is there to make a match matter more, not to take points away from one.
 */
export const LIVE_MIN_MULTIPLIER = 1;
export const LIVE_MAX_MULTIPLIER = 10;

/**
 * A fixture's multiplier as scoring should read it.
 *
 * A fixture stored before the column existed reads as null, and a value outside the
 * bounds should never reach scoring at all — both fall back to 1 rather than wiping out
 * or inflating everyone's points on a fixture that has already been predicted.
 */
export function liveFixtureMultiplier(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const whole = Math.trunc(value);
  if (whole < LIVE_MIN_MULTIPLIER) return 1;
  return Math.min(whole, LIVE_MAX_MULTIPLIER);
}

export interface LiveScoreBreakdown {
  correctOutcomePoints: number;
  correctGoalDifferencePoints: number;
  exactScorePoints: number;
  /** Everything highlighted matches added on top of those three. */
  multiplierBonusPoints: number;
  /** Combined exact-position and band points from the table prediction. */
  tablePoints: number;
  /** Exact-position points from the top-scorer ranking. Awarded at completion. */
  scorerPoints: number;
  /** Awarded only once the tournament is marked completed. */
  bonusPoints: number;
}

// ── Entities ──────────────────────────────────────────────────────────────────

export interface LiveTournament {
  id: string;
  name: string;
  imageUrl: string | null;
  presetKey: string | null;
  provider: LiveProviderId;
  /** Where fixtures come from, when that is not `provider`. Null means it is. */
  fixtureProvider: LiveProviderId | null;
  /** That provider's identifier for the competition. Null falls back to the main one. */
  fixtureProviderCompetitionId: string | null;
  providerCompetitionId: string;
  season: string;
  format: string;
  startStageKey: string;
  status: LiveTournamentStatus;
  syncEnabled: boolean;
  lastStructureSyncAt: string | null;
  lastFixtureSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface LiveTeam {
  id: string;
  liveTournamentId: string;
  providerTeamId: string;
  name: string;
  shortName: string | null;
  tla: string | null;
  crestUrl: string | null;
  groupName: string | null;
  qualificationStatus: LiveQualificationStatus;
}

export interface LiveFixture {
  id: string;
  liveTournamentId: string;
  providerFixtureId: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  kickoffAt: string | null;
  /** Provider distinguishes a placeholder date from a confirmed kickoff time. */
  kickoffConfirmed: boolean;
  status: LiveFixtureStatus;
  /** Internal stage key from the tournament's format; null when the provider stage is unmapped. */
  stageKey: string | null;
  /** Raw provider stage string, kept so unmapped values are debuggable rather than lost. */
  providerStage: string | null;
  groupName: string | null;
  matchday: number | null;
  /** Groups the two legs of a two-legged tie. Null for single-leg fixtures. */
  tieKey: string | null;
  legNumber: number | null;
  /**
   * Whole-number multiplier applied to every point this fixture awards, set by an admin.
   * 1 — the default — leaves scoring exactly as the tiers describe it.
   */
  multiplier: number;

  /** End of normal time — the only score that awards points. */
  normalTimeHome: number | null;
  normalTimeAway: number | null;
  halfTimeHome: number | null;
  halfTimeAway: number | null;
  extraTimeHome: number | null;
  extraTimeAway: number | null;
  penaltiesHome: number | null;
  penaltiesAway: number | null;
  /** Provider full-time score, including extra time. Display only. */
  finalHome: number | null;
  finalAway: number | null;

  winner: string | null;
  minute: number | null;
  providerLastUpdated: string | null;
  updatedAt: string;
}

export interface LiveStanding {
  id: string;
  liveTournamentId: string;
  stageKey: string;
  groupName: string | null;
  teamId: string;
  position: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  form: string | null;
  updatedAt: string;
}

export interface LiveCompetition {
  id: string;
  liveTournamentId: string;
  name: string;
  imageUrl: string | null;
  inviteCode: string;
  scoringConfig: LiveScoringConfig;
  createdAt: string;
}

export interface LivePrediction {
  id: string;
  liveCompetitionId: string;
  userId: string;
  liveFixtureId: string;
  homeScore: number;
  awayScore: number;
  points: number | null;
  correctOutcomePoints: number;
  correctGoalDifferencePoints: number;
  exactScorePoints: number;
  /** What a highlighted (multiplied) fixture added on top of the tiers. */
  multiplierBonusPoints: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user's predicted final order for a table stage.
 *
 * `orderedTeamIds` is the whole table top to bottom — index 0 is 1st place. It is stored
 * as an array rather than a row per team because it is only ever read and written whole,
 * and the ordering *is* the prediction.
 */
export interface LiveTablePrediction {
  id: string;
  liveCompetitionId: string;
  userId: string;
  stageKey: string;
  orderedTeamIds: string[];
  /** Null until the stage finishes and scoring runs. */
  points: number | null;
  exactPositionPoints: number;
  bandPoints: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A player in the tournament's top-scorer ranking.
 *
 * Tournament-scoped like a team, not competition-scoped: every league playing the
 * tournament ranks the same shortlist, exactly as they all answer the same bonus
 * questions.
 *
 * Goals and assists come from the provider where it serves them and from the admin where
 * it does not — `providerPlayerId` is what tells the two apart. A hand-added player has
 * none and is never overwritten by a sync.
 */
export interface LivePlayer {
  id: string;
  liveTournamentId: string;
  /** The provider's own player id. Null for a player an admin added by hand. */
  providerPlayerId: string | null;
  name: string;
  /** The club they are listed under. Null when nothing matched, or for a hand-added player. */
  teamId: string | null;
  /** The provider's own wording — "Centre-Forward". Shown next to the name. */
  position: string | null;
  imageUrl: string | null;
  /**
   * A hex colour the admin picked for this player, used as a glow on their row in the
   * ranking. Null leaves the row plain.
   */
  glowColor: string | null;
  goals: number;
  /** Only used to break a tie on goals — see rankLiveScorers in the server's scorerScoring. */
  assists: number;
  /** Whether the player is in the shortlist users rank. Admin-chosen. */
  isSelected: boolean;
  providerLastUpdated: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user's predicted order for the tournament's top scorers.
 *
 * `orderedPlayerIds` is the whole shortlist, index 0 being the player they think finishes
 * top. Stored as an array for the same reason the table prediction is: it is only ever
 * read and written whole, and the ordering *is* the prediction.
 */
export interface LiveScorerPrediction {
  id: string;
  liveCompetitionId: string;
  userId: string;
  orderedPlayerIds: string[];
  /** Null until the tournament is completed and the ranking is scored. */
  points: number | null;
  exactPositionPoints: number;
  createdAt: string;
  updatedAt: string;
}

/** Per-player scoring detail, for showing a user how their ranking did. */
export interface LiveScorerPredictionPlayerResult {
  playerId: string;
  predictedPosition: number;
  /** Where the player actually finished. Null if they left the shortlist. */
  actualPosition: number | null;
  exactPosition: boolean;
  points: number;
}

/**
 * The set of fixtures an admin has picked out of one gameweek (a matchday within a
 * stage) as the ones users predict on.
 *
 * A gameweek with no row here has nothing selected — the default. `selectedFixtureIds`
 * is stored whole rather than a row per fixture because it is only ever read and written
 * complete, and because "no row" is what expresses the default.
 */
export interface LiveGameweekSelection {
  id: string;
  liveTournamentId: string;
  stageKey: string;
  matchday: number;
  selectedFixtureIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * What a bonus question expects as an answer.
 *
 * Deliberately re-declared rather than imported from ../types: the live module keeps its
 * own type surface, and the two lists have diverged — `country` exists only here. `player`
 * is answered through the same external player search the manual type uses, so it needs no
 * live player table.
 */
export type LiveBonusAnswerType = 'number' | 'player' | 'team' | 'yes_no' | 'country';

/**
 * A season-long side bet on a live tournament — "how many goals will X score?".
 *
 * Questions belong to the tournament rather than a competition, so every league playing
 * that tournament asks the same ones, exactly as the manual type works.
 */
export interface LiveBonusQuestion {
  id: string;
  liveTournamentId: string;
  question: string;
  answerType: LiveBonusAnswerType;
  points: number;
  /**
   * Null until an admin records it. A JSON array of strings when several answers count,
   * a plain string otherwise. Redacted from non-admins until the tournament is completed.
   */
  correctAnswer: string | null;
  /**
   * When answers close. Null means the default: one hour before the first match of the
   * tournament's starting stage — the same instant the table prediction locks.
   */
  lockAt: string | null;

  // ── Optional constraints (see shared/src/live/bonus.ts) ─────────────────────
  /** Inclusive bounds on a number answer. Null on either side leaves that side open. */
  minValue: number | null;
  maxValue: number | null;
  /** A number answer within ±leeway of the correct one scores in full. */
  leeway: number | null;
  /**
   * The only answers a player, team or country question accepts. Null or empty means
   * every option is available — the tournament's teams, the European countries, or any
   * player.
   */
  options: string[] | null;

  createdAt: string;
}

export interface LiveBonusAnswer {
  id: string;
  questionId: string;
  liveCompetitionId: string;
  userId: string;
  answer: string;
  /** Null until the tournament is completed and bonus scoring runs. */
  points: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A question plus its lock state — what the bonus tab renders from. */
export interface LiveBonusQuestionView extends LiveBonusQuestion {
  /** The resolved deadline: the question's own, or the tournament's first kickoff − 60 min. */
  lockedAt: string | null;
  isLocked: boolean;
}

/** Per-team scoring detail, for showing a user how their table prediction did. */
export interface LiveTablePredictionTeamResult {
  teamId: string;
  predictedPosition: number;
  actualPosition: number | null;
  exactPosition: boolean;
  correctBand: boolean;
  predictedBand: string | null;
  actualBand: string | null;
  points: number;
}

export interface LiveLeaderboardEntry {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  totalPoints: number;
  rank: number;
  breakdown: LiveScoreBreakdown;
}

// ── Read models ───────────────────────────────────────────────────────────────

/** A fixture plus everything the fixtures view needs, in one payload. */
export interface LiveFixtureView extends LiveFixture {
  homeTeam: LiveTeam | null;
  awayTeam: LiveTeam | null;
  /** The caller's own prediction, if any. */
  prediction: Pick<LivePrediction, 'homeScore' | 'awayScore' | 'points'> | null;
  /** kickoff − LIVE_LOCK_MINUTES, or null when the kickoff time is still TBD. */
  lockedAt: string | null;
  isLocked: boolean;
  /** False for fixtures below the tournament's startStageKey (e.g. summer qualifiers). */
  isPredictable: boolean;
  /**
   * False when the admin has registered a selection for this fixture's gameweek and left
   * this fixture out of it. True by default — see shared/src/live/selection.ts.
   */
  isSelected: boolean;
}
