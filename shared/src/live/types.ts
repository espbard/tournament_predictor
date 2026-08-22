// ── Live (API-linked) tournaments ─────────────────────────────────────────────
//
// This module is the type surface for the *live* tournament type — tournaments bound
// to a real competition through a data provider. It is deliberately independent of the
// manual tournament types in ../types.ts: nothing here should be merged with
// Tournament / Team / Match / Competition / Prediction.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md.

export type LiveProviderId = 'football_data';

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
export interface LiveScoringConfig {
  correct_outcome: number;
  correct_goal_difference: number;
  exact_score: number;
  /** Per team placed in exactly the right final table position. */
  table_exact_position: number;
  /**
   * Per team placed in the right band of the table (Champions League: top 8, 9th–24th,
   * 25th and below). Stacks with the exact-position award, so a team in exactly the right
   * place is worth both. Formats without bands never award this.
   */
  table_correct_band: number;
}

export const DEFAULT_LIVE_SCORING_CONFIG: LiveScoringConfig = {
  correct_outcome: 1,
  correct_goal_difference: 1,
  exact_score: 2,
  table_exact_position: 1,
  table_correct_band: 1,
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

export interface LiveScoreBreakdown {
  correctOutcomePoints: number;
  correctGoalDifferencePoints: number;
  exactScorePoints: number;
  /** Combined exact-position and band points from the table prediction. */
  tablePoints: number;
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
 * The set of fixtures an admin has picked out of one gameweek (a matchday within a
 * stage) as the ones users predict on.
 *
 * A gameweek with no row here has every fixture selected — the default. `selectedFixtureIds`
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
 * own type surface, and the two lists are free to diverge. `player` is answered through
 * the same external player search the manual type uses, so it needs no live player table.
 */
export type LiveBonusAnswerType = 'number' | 'player' | 'team' | 'yes_no';

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
