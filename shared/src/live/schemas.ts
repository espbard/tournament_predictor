import { z } from 'zod';
import { LIVE_FORMAT_KEYS } from './formats';
import { LIVE_MAX_MULTIPLIER, LIVE_MIN_MULTIPLIER } from './types';

// Scores are entered by hand, so bound them the same way the manual type does
// (SaveBracketPredictionsSchema caps at 30).
const goals = z.number().int().min(0).max(30);

const points = z.number().int().min(0).max(100);

export const LiveScoringConfigSchema = z.object({
  correct_outcome: points,
  correct_goal_difference: points,
  exact_score: points,
  // Optional so a competition stored before these tiers existed still validates on
  // update; withLiveScoringDefaults fills them in on read.
  table_exact_position: points.optional(),
  table_correct_band: points.optional(),
});

export const CreateLiveTournamentSchema = z.object({
  presetKey: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  imageUrl: z.string().nullable().optional(),
});

export const UpdateLiveTournamentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  imageUrl: z.string().nullable().optional(),
  status: z.enum(['upcoming', 'active', 'completed']).optional(),
  syncEnabled: z.boolean().optional(),
  /** Null puts fixtures back on the tournament's main provider. */
  fixtureProvider: z.enum(['football_data', 'big_balls']).nullable().optional(),
  /** That provider's own identifier for the competition. Null falls back to the main one. */
  fixtureProviderCompetitionId: z.string().min(1).max(64).nullable().optional(),
});

export const SyncLiveTournamentSchema = z.object({
  /** Full structure sync (teams + all fixtures + standings) rather than the live window. */
  full: z.boolean().optional(),
});

export const CreateLiveCompetitionSchema = z.object({
  liveTournamentId: z.string().min(1),
  name: z.string().min(1).max(100),
  imageUrl: z.string().nullable().optional(),
  scoringConfig: LiveScoringConfigSchema.optional(),
});

export const UpdateLiveCompetitionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  imageUrl: z.string().nullable().optional(),
  scoringConfig: LiveScoringConfigSchema.optional(),
});

export const JoinLiveCompetitionSchema = z.object({
  inviteCode: z.string().min(1).max(16),
});

export const SaveLivePredictionSchema = z.object({
  fixtureId: z.string().min(1),
  homeScore: goals,
  awayScore: goals,
});

/**
 * A full predicted table, top to bottom.
 *
 * The server checks the ids against the tournament's actual teams — this only enforces
 * shape and a sane upper bound (no real league table is longer than this).
 */
export const SaveLiveTablePredictionSchema = z.object({
  stageKey: z.string().min(1),
  orderedTeamIds: z.array(z.string().min(1)).min(2).max(64),
});

/**
 * Register which fixtures of one gameweek users predict on.
 *
 * `fixtureIds: null` — or an empty array — resets the gameweek to its default, where
 * every fixture counts. That is why an empty selection is never stored: "nothing
 * selected" and "no selection registered" would otherwise be indistinguishable, and a
 * gameweek nobody can predict on is never what an admin means.
 */
export const SaveLiveGameweekSelectionSchema = z.object({
  stageKey: z.string().min(1),
  matchday: z.number().int().min(1).max(60),
  fixtureIds: z.array(z.string().min(1)).max(200).nullable(),
});

/**
 * A fixture's point multiplier.
 *
 * Whole numbers only, and never below 1 — see LIVE_MIN_MULTIPLIER. The upper bound is a
 * sanity limit rather than a rule of the game: a x10 match already dwarfs a gameweek.
 */
export const SaveLiveFixtureMultiplierSchema = z.object({
  multiplier: z.number().int().min(LIVE_MIN_MULTIPLIER).max(LIVE_MAX_MULTIPLIER),
});

// ── Bonus questions ───────────────────────────────────────────────────────────

const bonusAnswerType = z.enum(['number', 'player', 'team', 'yes_no', 'country']);

// Wide enough for any real question — "how many goals in the group stage?" — while still
// refusing a value that would only be a typo.
const bonusNumber = z.number().int().min(-100000).max(100000);

/**
 * What an admin may narrow about a question. All optional, and all meaningful only for
 * some answer types — see shared/src/live/bonus.ts for which.
 */
const bonusConstraints = {
  /** Inclusive bounds on a number answer. */
  minValue: bonusNumber.nullable().optional(),
  maxValue: bonusNumber.nullable().optional(),
  /** A number answer within ±leeway of the correct one scores in full. */
  leeway: z.number().int().min(0).max(100000).nullable().optional(),
  /** The only answers a player, team or country question accepts. Empty means all of them. */
  options: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
};

export const CreateLiveBonusQuestionSchema = z.object({
  question: z.string().min(1).max(500),
  answerType: bonusAnswerType,
  points: z.number().int().min(1).max(1000),
  /** Null means the default deadline — the tournament's first predictable kickoff − 60 min. */
  lockAt: z.string().datetime().nullable().optional(),
  ...bonusConstraints,
});

export const UpdateLiveBonusQuestionSchema = z.object({
  question: z.string().min(1).max(500).optional(),
  answerType: bonusAnswerType.optional(),
  points: z.number().int().min(1).max(1000).optional(),
  /** A JSON array of strings when several answers count; a plain string otherwise. */
  correctAnswer: z.string().nullable().optional(),
  lockAt: z.string().datetime().nullable().optional(),
  ...bonusConstraints,
});

export const SaveLiveBonusAnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1).max(500),
});

export const ListLiveFixturesQuerySchema = z.object({
  stageKey: z.string().min(1).optional(),
  matchday: z.coerce.number().int().min(1).max(60).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z
    .enum(['scheduled', 'in_play', 'paused', 'finished', 'postponed', 'suspended', 'cancelled'])
    .optional(),
});

/** Only used by an admin escape hatch; the UI always goes through a preset. */
export const LiveFormatKeySchema = z.enum(LIVE_FORMAT_KEYS as [string, ...string[]]);

export type LiveScoringConfigInput = z.infer<typeof LiveScoringConfigSchema>;
export type CreateLiveTournamentInput = z.infer<typeof CreateLiveTournamentSchema>;
export type UpdateLiveTournamentInput = z.infer<typeof UpdateLiveTournamentSchema>;
export type SyncLiveTournamentInput = z.infer<typeof SyncLiveTournamentSchema>;
export type CreateLiveCompetitionInput = z.infer<typeof CreateLiveCompetitionSchema>;
export type UpdateLiveCompetitionInput = z.infer<typeof UpdateLiveCompetitionSchema>;
export type JoinLiveCompetitionInput = z.infer<typeof JoinLiveCompetitionSchema>;
export type SaveLivePredictionInput = z.infer<typeof SaveLivePredictionSchema>;
export type SaveLiveTablePredictionInput = z.infer<typeof SaveLiveTablePredictionSchema>;
export type ListLiveFixturesQuery = z.infer<typeof ListLiveFixturesQuerySchema>;
export type SaveLiveGameweekSelectionInput = z.infer<typeof SaveLiveGameweekSelectionSchema>;
export type SaveLiveFixtureMultiplierInput = z.infer<typeof SaveLiveFixtureMultiplierSchema>;
export type CreateLiveBonusQuestionInput = z.infer<typeof CreateLiveBonusQuestionSchema>;
export type UpdateLiveBonusQuestionInput = z.infer<typeof UpdateLiveBonusQuestionSchema>;
export type SaveLiveBonusAnswerInput = z.infer<typeof SaveLiveBonusAnswerSchema>;
