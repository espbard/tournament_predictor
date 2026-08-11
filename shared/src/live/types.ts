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
}

export const DEFAULT_LIVE_SCORING_CONFIG: LiveScoringConfig = {
  correct_outcome: 1,
  correct_goal_difference: 1,
  exact_score: 2,
};

export interface LiveScoreBreakdown {
  correctOutcomePoints: number;
  correctGoalDifferencePoints: number;
  exactScorePoints: number;
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
}
