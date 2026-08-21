import { z } from 'zod';
import { LIVE_FORMAT_KEYS } from './formats';

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
