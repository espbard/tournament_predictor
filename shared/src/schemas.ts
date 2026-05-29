import { z } from 'zod';

export const RegisterSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores'),
  password: z.string().min(6),
  imageUrl: z.string().url().nullable().optional(),
});

export const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const CreateTournamentSchema = z.object({
  name: z.string().min(1).max(100),
  imageUrl: z.string().url().nullable().optional(),
});

export const UpdateTournamentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['upcoming', 'active', 'completed']).optional(),
  imageUrl: z.string().url().nullable().optional(),
});

export const CreateTeamSchema = z.object({
  name: z.string().min(1).max(100),
  group: z.string().max(10).optional(),
  imageUrl: z.string().url().nullable().optional(),
});

export const UpdateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  imageUrl: z.string().url().nullable().optional(),
});

export const UpdateUserSchema = z.object({
  imageUrl: z.string().url().nullable().optional(),
});

export const CreateMatchSchema = z.object({
  homeTeamId: z.string().nullable().optional(),
  awayTeamId: z.string().nullable().optional(),
  stage: z.enum(['group', 'round_of_16', 'quarter_final', 'semi_final', 'final']),
  scheduledAt: z.string().datetime().nullable().optional(),
});

export const UpdateMatchSchema = z.object({
  homeScore: z.number().int().min(0),
  awayScore: z.number().int().min(0),
});

export const CreateCompetitionSchema = z.object({
  tournamentId: z.string().min(1),
  name: z.string().min(1).max(100),
  predictionDeadline: z.string().datetime().nullable().optional(),
});

export const CreatePredictionSchema = z.object({
  matchId: z.string().min(1),
  homeScore: z.number().int().min(0),
  awayScore: z.number().int().min(0),
  progressingTeamId: z.string().nullable().optional(),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type CreateTournamentInput = z.infer<typeof CreateTournamentSchema>;
export type UpdateTournamentInput = z.infer<typeof UpdateTournamentSchema>;
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;
export type UpdateTeamInput = z.infer<typeof UpdateTeamSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type CreateMatchInput = z.infer<typeof CreateMatchSchema>;
export type UpdateMatchInput = z.infer<typeof UpdateMatchSchema>;
export type CreateCompetitionInput = z.infer<typeof CreateCompetitionSchema>;
export type CreatePredictionInput = z.infer<typeof CreatePredictionSchema>;
