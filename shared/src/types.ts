export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  imageUrl?: string | null;
}

export type KnockoutFirstRound = 'round_of_32' | 'round_of_16' | 'quarter_final' | 'semi_final' | 'final';

export interface KnockoutConfig {
  firstRound: KnockoutFirstRound;
  hasBronzeFinal: boolean;
  directQualifiers: number;
  luckyLosers: number;
  bracketSlots: Record<string, string>;
}

export interface Tournament {
  id: string;
  name: string;
  status: 'upcoming' | 'active' | 'completed';
  imageUrl?: string | null;
  createdAt: string;
  knockoutConfig: KnockoutConfig | null;
}

export interface Group {
  id: string;
  tournamentId: string;
  name: string;
}

export interface Team {
  id: string;
  tournamentId: string;
  name: string;
  groupId: string | null;
  imageUrl?: string | null;
}

export type MatchStage = 'group' | 'round_of_32' | 'round_of_16' | 'quarter_final' | 'semi_final' | 'bronze_final' | 'final';

export interface Match {
  id: string;
  tournamentId: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  stage: MatchStage;
  scheduledAt: string | null;
  status: 'scheduled' | 'completed';
  homeScore: number | null;
  awayScore: number | null;
  progressingTeamId: string | null;
}

export interface ScoringConfig {
  exact_score: number;
  correct_result: number;
  correct_group_position: number;
  correct_team_progresses: number;
  correct_team_in_knockout_tie: number;
  correct_team_in_final: number;
  correct_winner: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  exact_score: 3,
  correct_result: 1,
  correct_group_position: 2,
  correct_team_progresses: 3,
  correct_team_in_knockout_tie: 2,
  correct_team_in_final: 5,
  correct_winner: 10,
};

export interface Competition {
  id: string;
  tournamentId: string;
  name: string;
  imageUrl?: string | null;
  inviteCode: string;
  scoringConfig: ScoringConfig;
  predictionDeadline: string | null;
  createdAt: string;
}

export interface Prediction {
  id: string;
  competitionId: string;
  userId: string;
  matchId: string;
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
  points: number | null;
  createdAt: string;
}

export interface LeaderboardEntry {
  userId: string;
  username: string;
  totalPoints: number;
  rank: number;
}

export interface BracketMatchPrediction {
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
}

export type BracketPredictions = Record<string, BracketMatchPrediction>;

export type BonusAnswerType = 'number' | 'player' | 'team' | 'yes_no';

export interface BonusQuestion {
  id: string;
  competitionId: string;
  question: string;
  answerType: BonusAnswerType;
  points: number;
  correctAnswer: string | null;
  createdAt: string;
}

export interface BonusAnswer {
  id: string;
  questionId: string;
  competitionId: string;
  userId: string;
  answer: string;
  points: number | null;
  createdAt: string;
}
