import { z } from 'zod';

export const RegisterSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores'),
  password: z.string().min(6),
  imageUrl: z.string().nullable().optional(),
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  isLeaderboardUser: z.boolean().optional(),
  isLateAddition: z.boolean().optional(),
});

export const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const CreateTournamentSchema = z.object({
  name: z.string().min(1).max(100),
  imageUrl: z.string().nullable().optional(),
});

export const UpdateTournamentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['upcoming', 'active', 'completed']).optional(),
  imageUrl: z.string().nullable().optional(),
});

export const CreateTeamSchema = z.object({
  name: z.string().min(1).max(100),
  groupId: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
});

export const UpdateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  groupId: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
});

export const CreateGroupSchema = z.object({
  name: z.string().min(1).max(20),
});

export const UpdateUserSchema = z.object({
  imageUrl: z.string().nullable().optional(),
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

export const CreateMatchSchema = z.object({
  homeTeamId: z.string().nullable().optional(),
  awayTeamId: z.string().nullable().optional(),
  stage: z.enum(['group', 'round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final']),
  scheduledAt: z.string().datetime().nullable().optional(),
});

export const UpdateMatchSchema = z.object({
  homeScore: z.number().int().min(0).optional(),
  awayScore: z.number().int().min(0).optional(),
  homeTeamId: z.string().nullable().optional(),
  awayTeamId: z.string().nullable().optional(),
  stage: z.enum(['group', 'round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final']).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  progressingTeamId: z.string().nullable().optional(),
});

export const CreateCompetitionSchema = z.object({
  tournamentId: z.string().min(1),
  name: z.string().min(1).max(100),
  imageUrl: z.string().nullable().optional(),
  predictionDeadline: z.string().datetime().nullable().optional(),
});

export const UpdateCompetitionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  imageUrl: z.string().nullable().optional(),
  predictionDeadline: z.string().datetime().nullable().optional(),
  allowLateAdditions: z.boolean().optional(),
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
export type CreateGroupInput = z.infer<typeof CreateGroupSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type CreateMatchInput = z.infer<typeof CreateMatchSchema>;
export type UpdateMatchInput = z.infer<typeof UpdateMatchSchema>;
export type CreateCompetitionInput = z.infer<typeof CreateCompetitionSchema>;
export type UpdateCompetitionInput = z.infer<typeof UpdateCompetitionSchema>;
export type CreatePredictionInput = z.infer<typeof CreatePredictionSchema>;

export const UpdateKnockoutConfigSchema = z.object({
  firstRound: z.enum(['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final']).optional(),
  hasBronzeFinal: z.boolean().optional(),
  directQualifiers: z.number().int().min(1).max(4).optional(),
  luckyLosers: z.number().int().min(0).optional(),
  bracketSlots: z.record(z.string()).optional(),
  groupDisciplinaryChoices: z.record(z.array(z.string())).optional(),
  luckyLoserDisciplinaryChoices: z.record(z.array(z.string())).optional(),
});

export type UpdateKnockoutConfigInput = z.infer<typeof UpdateKnockoutConfigSchema>;

export const SaveBracketPredictionsSchema = z.object({
  predictions: z.record(
    z.object({
      homeScore: z.number().int().min(0).max(30),
      awayScore: z.number().int().min(0).max(30),
      progressingTeamId: z.string().nullable(),
      flipped: z.boolean().optional(),
    }),
  ),
});

export type SaveBracketPredictionsInput = z.infer<typeof SaveBracketPredictionsSchema>;

export const AdminSetBracketProgressingTeamSchema = z.object({
  predKey: z.string().min(1),
  progressingTeamId: z.string().min(1),
});

export type AdminSetBracketProgressingTeamInput = z.infer<typeof AdminSetBracketProgressingTeamSchema>;

export const CreateBonusQuestionSchema = z.object({
  question: z.string().min(1).max(500),
  answerType: z.enum(['number', 'player', 'team', 'yes_no']),
  points: z.number().int().min(1).max(1000),
});

export const UpdateBonusQuestionSchema = z.object({
  question: z.string().min(1).max(500).optional(),
  answerType: z.enum(['number', 'player', 'team', 'yes_no']).optional(),
  points: z.number().int().min(1).max(1000).optional(),
  correctAnswer: z.string().nullable().optional(),
});

export const CreatePlayerSchema = z.object({
  name: z.string().min(1).max(100),
  gamesPlayed: z.number().int().min(0).optional(),
  goalsScored: z.number().int().min(0).optional(),
});

export const UpdatePlayerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  gamesPlayed: z.number().int().min(0).optional(),
  goalsScored: z.number().int().min(0).optional(),
});

export type CreatePlayerInput = z.infer<typeof CreatePlayerSchema>;
export type UpdatePlayerInput = z.infer<typeof UpdatePlayerSchema>;

export const SaveBonusAnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

export type CreateBonusQuestionInput = z.infer<typeof CreateBonusQuestionSchema>;
export type UpdateBonusQuestionInput = z.infer<typeof UpdateBonusQuestionSchema>;
export type SaveBonusAnswerInput = z.infer<typeof SaveBonusAnswerSchema>;
