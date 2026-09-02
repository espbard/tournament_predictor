export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  isTestAccount: boolean;
  isLeaderboardUser: boolean;
  isComparisonUser: boolean;
  isLateAddition: boolean;
  imageUrl?: string | null;
  iconColor?: string | null;
}

export type KnockoutFirstRound = 'round_of_32' | 'round_of_16' | 'quarter_final' | 'semi_final' | 'final';

export interface KnockoutConfig {
  firstRound: KnockoutFirstRound;
  hasBronzeFinal: boolean;
  directQualifiers: number;
  luckyLosers: number;
  bracketSlots: Record<string, string>;
  groupDisciplinaryChoices?: Record<string, string[]>;
  luckyLoserDisciplinaryChoices?: Record<string, string[]>;
  groupStandingsLocked?: boolean;
  confirmedGroupStandings?: Record<string, string[]>;
  confirmedLuckyLosers?: string[];
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
  bracketIndex: number | null;
  nextMatchId: string | null;
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
  correct_group_position: 1,
  correct_team_progresses: 2,
  correct_team_in_knockout_tie: 1,
  correct_team_in_final: 5,
  correct_winner: 7,
};

export interface Competition {
  id: string;
  tournamentId: string;
  name: string;
  imageUrl?: string | null;
  inviteCode: string;
  scoringConfig: ScoringConfig;
  predictionDeadline: string | null;
  allowLateAdditions: boolean;
  createdAt: string;
  /**
   * The status of the tournament this competition plays, where the endpoint joined it in
   * — the competition list does, so finished leagues can be sorted last. Absent elsewhere.
   */
  tournamentStatus?: 'upcoming' | 'active' | 'completed' | null;
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
  isReplacement: boolean;
  createdAt: string;
}

export interface ScoreBreakdown {
  exactScorePoints: number;
  correctResultPoints: number;
  correctTeamProgressesPoints: number;
  correctGroupPositionPoints: number;
  correctTeamInKnockoutTiePoints: number;
  correctTeamInFinalPoints: number;
  correctWinnerPoints: number;
  bonusQuestionPoints: number;
  lateAdditionPoints: number;
}

export interface LeaderboardEntry {
  userId: string;
  username: string;
  imageUrl?: string | null;
  iconColor?: string | null;
  totalPoints: number;
  rank: number;
  breakdown: ScoreBreakdown;
  inactive?: boolean;
  isComparisonUser?: boolean;
  isLateAddition?: boolean;
  lateAdditionWindowEndsAt?: string | null;
}

export interface BracketMatchPrediction {
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
  flipped?: boolean;
}

export type BracketPredictions = Record<string, BracketMatchPrediction>;

export type BonusAnswerType = 'number' | 'player' | 'team' | 'yes_no';

export interface BonusQuestion {
  id: string;
  tournamentId: string;
  question: string;
  answerType: BonusAnswerType;
  points: number;
  correctAnswer: string | null;
  createdAt: string;
}

export interface UserStatSubject {
  /**
   * How the card should picture this subject. 'team' is a crest — a logo on empty space,
   * shown whole; 'user' and 'player' are photographs, cropped to a circle.
   */
  type: 'user' | 'team' | 'player';
  id: string;
  name: string;
  imageUrl?: string | null;
  iconColor?: string | null;
}

export interface LeaderboardProgressionMatch {
  matchId: string;
  label: string;
  stage: string;
  cumulativePoints: Record<string, number>;
}

export interface LeaderboardProgressionResponse {
  matches: LeaderboardProgressionMatch[];
  users: Array<{ userId: string; username: string; imageUrl?: string | null; iconColor?: string | null }>;
}

export interface UserStatCardData {
  id: string;
  title: string;
  statistic: string;
  subjects: UserStatSubject[];
  linkType: 'match' | 'user' | 'userBonus' | 'leaderboard' | null;
  matchId?: string | null;
  overlayImageUrl?: string | null;
  iconImageUrl?: string | null;
  backgroundImageUrl?: string | null;
  backgroundImagePosition?: 'center' | 'right' | null;
  backgroundImageFilter?: string | null;
  backgroundImageBlend?: 'multiply' | 'screen' | null;
  // 'blend' (default) layers backgroundImageUrl on top of the subject via blend mode;
  // 'behind' renders it as a plain full-bleed backdrop with the subject shown semi-transparent on top.
  backgroundImageMode?: 'blend' | 'behind' | null;
  distributionData?: { value: number; count: number }[] | null;
  distributionActualValue?: number | null;
}

export interface Player {
  id: string;
  tournamentId: string;
  name: string;
  gamesPlayed: number;
  goalsScored: number;
}

export type FeedbackType = 'feature_request' | 'improvement' | 'bug';
export type FeedbackStatus = 'pending' | 'will_do' | 'implemented' | 'fixed' | 'wont_do';

export interface Feedback {
  id: string;
  userId: string;
  username?: string;
  type: FeedbackType;
  message: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
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

// ── Invite links ──────────────────────────────────────────────────────────────
//
// A second way into a competition, alongside the five-digit invite code: a share link
// carrying an unguessable token. The token lives on the competition row itself, is
// created the first time somebody presses Invite, and never expires — it is the same
// standing invitation as the code, just clickable.

/** Which of the two tournament types a competition belongs to. */
export type CompetitionKind = 'manual' | 'live';

/** What the Invite button gets back. The client builds the absolute URL from `path`. */
export interface CompetitionInvite {
  token: string;
  /** Client-side route the token resolves at, e.g. `/invite/abc123`. */
  path: string;
  /** The five-digit code, so the dialog can offer both ways in. */
  inviteCode: string;
}

/** What an invite link shows before the visitor commits to joining. */
export interface InvitePreview {
  kind: CompetitionKind;
  competitionId: string;
  competitionName: string;
  imageUrl: string | null;
  tournamentName: string | null;
  /** False whenever the visitor is not signed in. */
  isMember: boolean;
}

/** Where to send the visitor once the invite is accepted. */
export interface InviteAcceptResult {
  kind: CompetitionKind;
  competitionId: string;
}
