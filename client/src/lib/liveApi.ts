import { api } from '@/lib/api';
import type {
  LiveBonusAnswer,
  LiveBonusAnswerType,
  LiveBonusQuestion,
  LiveBonusQuestionView,
  LiveCompetition,
  LiveFixture,
  LiveFormatDef,
  LiveFormatKey,
  LiveScoringConfig,
  LiveStageDef,
  LiveStanding,
  LiveTableBand,
  LiveTablePrediction,
  LiveTeam,
  LiveTournament,
  LiveTournamentPreset,
} from '@tournament-predictor/shared';

// ── Live tournament API client ────────────────────────────────────────────────
//
// Thin typed wrappers over the shared fetch helper in @/lib/api. The server's response
// shapes are re-declared here where they extend the shared entity types — the routes
// return a fixture joined with its teams, the caller's prediction and the lock state,
// and nothing in shared/ describes that composite.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §10 and §11.

/** A fixture as GET /live/competitions/:id/fixtures returns it. */
export interface LiveFixtureView extends LiveFixture {
  homeTeam: LiveTeam | null;
  awayTeam: LiveTeam | null;
  prediction: {
    homeScore: number;
    awayScore: number;
    points: number | null;
    correctOutcomePoints: number;
    correctGoalDifferencePoints: number;
    exactScorePoints: number;
  } | null;
  /** kickoff − 60 min, or null when the kickoff time is still unknown. */
  lockedAt: string | null;
  isLocked: boolean;
  /** False for fixtures below the tournament's startStageKey. */
  isPredictable: boolean;
  /**
   * False when the admin has narrowed this fixture's gameweek to a set of selected
   * matches that leaves this one out. True by default.
   */
  isSelected: boolean;
}

export interface LiveStandingView extends LiveStanding {
  team: LiveTeam | null;
}

export interface LiveLeaderboardRow {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  totalPoints: number;
  rank: number;
  breakdown: {
    correctOutcomePoints: number;
    correctGoalDifferencePoints: number;
    exactScorePoints: number;
    tablePoints: number;
    /** Zero until the tournament is marked completed — bonus points are withheld until then. */
    bonusPoints: number;
  };
}

/**
 * One member's prediction for a single fixture, as the "what everyone predicted" dropdown
 * under a played match reads it. `prediction` is null for a member who never predicted it.
 */
export interface LiveFixturePredictionRow {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  prediction: {
    homeScore: number;
    awayScore: number;
    points: number | null;
    correctOutcomePoints: number;
    correctGoalDifferencePoints: number;
    exactScorePoints: number;
  } | null;
}

/**
 * The table-prediction tab's payload. A discriminated union because a format without a
 * table stage has nothing else to send, and the UI should not have to guess.
 */
export type LiveTablePredictionView =
  | { available: false }
  | {
      available: true;
      stageKey: string;
      stageLabelKey: string;
      bands: LiveTableBand[];
      teams: LiveTeam[];
      prediction: LiveTablePrediction | null;
      /** First kickoff of the stage − 60 min, or null when no date is published yet. */
      lockedAt: string | null;
      isLocked: boolean;
      /** Current standings order, top first. The natural starting point for a new table. */
      currentOrder: string[];
      scoringConfig: LiveScoringConfig;
    };

export interface LiveCompetitionDetail extends LiveCompetition {
  tournament: LiveTournament | null;
  /** Stage definitions from the tournament's format — render the tab from these. */
  stages: LiveStageDef[];
  tableScope: 'single' | 'per_group';
}

export interface LiveTournamentDetail extends LiveTournament {
  teamCount: number;
  qualifiedCount: number;
  expectedTeamCount: number | null;
  fixtureCount: number;
  /** Finished fixtures with no normal-time score, so they cannot be scored. */
  unscorableFixtures: number;
  /** Provider stage strings the format does not know about. */
  unmappedStages: string[];
  /** Fixtures with a kickoff time but a team missing on one side. */
  fixturesMissingTeams: number;
  /** Predictable fixtures that belong to no gameweek, so nobody can ever select them. */
  fixturesOutsideGameweek: number;
  /** What a complete starting stage looks like, and how much of it we hold. */
  expectedStartStageFixtures: number | null;
  startStageFixtureCount: number;
}

/** What an admin may narrow about a bonus question. See shared/src/live/bonus.ts. */
export interface LiveBonusConstraintsPayload {
  minValue: number | null;
  maxValue: number | null;
  leeway: number | null;
  options: string[] | null;
}

/** One gameweek — a matchday inside a stage — as the admin selection UI sees it. */
export interface LiveGameweekView {
  stageKey: string;
  matchday: number;
  /** False while the gameweek is at its default of every match selected. */
  isCustomised: boolean;
  fixtureCount: number;
  selectedCount: number;
  selectedFixtureIds: string[];
}

export interface SaveLiveSelectionResult {
  isCustomised: boolean;
  selectedFixtureIds: string[];
  fixtureCount: number;
  /** Predictions rescored as a result of the change. */
  scoredPredictions: number;
}

/** One provider endpoint a diagnostic run asked about. Mirrors ProviderProbe. */
export interface LiveProviderProbe {
  key:
    | 'competition'
    | 'matches_season'
    | 'matches_paged'
    | 'matches_unfiltered'
    | 'teams'
    | 'standings';
  /** Which adapter answered — a tournament may read fixtures from a second one. */
  provider?: string;
  url: string;
  status: number | null;
  ok: boolean;
  count: number | null;
  countForSeason: number | null;
  detail: string | null;
  /** The response envelope with its list trimmed to one item — the shape, not the data. */
  rawSample?: string | null;
}

export interface LiveFixtureDiagnosis {
  provider: string;
  providerCompetitionId: string;
  fixtureProvider: string | null;
  fixtureProviderCompetitionId: string | null;
  season: string;
  storedFixtures: number;
  storedTeams: number;
  lastStructureSyncAt: string | null;
  lastSyncError: string | null;
  probes: LiveProviderProbe[];
  expectedStartStageFixtures: number | null;
  verdict:
    | 'fixtures_available'
    | 'provider_has_partial_fixtures'
    | 'season_filter_hides_fixtures'
    | 'provider_has_no_fixtures'
    | 'season_not_published'
    | 'provider_unreachable'
    | 'never_fully_synced';
}

export interface LiveSyncResult {
  teams: number;
  fixtures: number;
  standings: number;
  newlyFinishedFixtureIds: string[];
  changedFixtureIds: string[];
  unmappedStages: string[];
  /** True when the provider has not published this season yet — a state, not an error. */
  seasonUnavailable: boolean;
  /** Fixtures removed because their kickoff falls outside the tournament's season. */
  outOfSeasonRemoved: number;
  /** Crests copied into R2 by this sync. Zero on every sync after the first. */
  crestsMirrored: number;
}

export interface LiveMember {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  joinedAt: string;
}

// A type alias rather than an interface: only aliases get an implicit index signature,
// which is what lets this be passed to the Record-typed query() helper below.
export type ListFixturesParams = {
  stageKey?: string;
  matchday?: number;
  status?: string;
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const liveApi = {
  // ── Metadata ──────────────────────────────────────────────────────────────
  presets: () => api.get<LiveTournamentPreset[]>('/live/presets'),
  formats: () => api.get<Record<LiveFormatKey, LiveFormatDef>>('/live/formats'),

  // ── Tournaments (admin) ───────────────────────────────────────────────────
  tournaments: () => api.get<LiveTournament[]>('/live/tournaments'),
  tournament: (id: string) => api.get<LiveTournamentDetail>(`/live/tournaments/${id}`),
  createTournament: (body: { presetKey: string; name?: string; imageUrl?: string | null }) =>
    // POST returns the tournament plus a report on the inline first sync. Both the
    // "season not published yet" and "sync failed" cases still return 201 with the
    // tournament created, so the admin can retry rather than start over.
    api.post<
      LiveTournament & {
        syncSeasonUnavailable?: boolean;
        syncFailed?: boolean;
        syncedTeams?: number;
        syncedFixtures?: number;
        syncedStandings?: number;
        unmappedStages?: string[];
      }
    >('/live/tournaments', body),
  updateTournament: (
    id: string,
    body: {
      name?: string;
      imageUrl?: string | null;
      status?: string;
      syncEnabled?: boolean;
      fixtureProvider?: 'football_data' | 'big_balls' | null;
      fixtureProviderCompetitionId?: string | null;
    },
  ) => api.patch<LiveTournament>(`/live/tournaments/${id}`, body),
  deleteTournament: (id: string) => api.delete<{ ok: true }>(`/live/tournaments/${id}`),
  syncTournament: (id: string, full: boolean) =>
    api.post<LiveSyncResult>(`/live/tournaments/${id}/sync`, { full }),
  /** Ask the provider directly what it has for this tournament. Admin-only. */
  diagnoseTournament: (id: string) =>
    api.post<LiveFixtureDiagnosis>(`/live/tournaments/${id}/diagnose`, {}),
  recalculateTournament: (id: string) =>
    api.post<{ scoredPredictions: number; affectedCompetitionIds: string[] }>(
      `/live/tournaments/${id}/recalculate`,
      {},
    ),
  tournamentTeams: (id: string) => api.get<LiveTeam[]>(`/live/tournaments/${id}/teams`),
  tournamentFixtures: (id: string, params: ListFixturesParams = {}) =>
    api.get<LiveFixtureView[]>(`/live/tournaments/${id}/fixtures${query(params)}`),
  selectedMatches: (id: string) =>
    api.get<LiveGameweekView[]>(`/live/tournaments/${id}/selected-matches`),
  // `fixtureIds: null` resets the gameweek to its default, where every match is selected.
  saveSelectedMatches: (
    id: string,
    body: { stageKey: string; matchday: number; fixtureIds: string[] | null },
  ) => api.put<SaveLiveSelectionResult>(`/live/tournaments/${id}/selected-matches`, body),
  // ── Bonus questions ───────────────────────────────────────────────────────
  // Questions belong to the tournament; answers to a competition.
  tournamentBonusQuestions: (id: string) =>
    api.get<LiveBonusQuestion[]>(`/live/tournaments/${id}/bonus-questions`),
  createBonusQuestion: (
    id: string,
    body: {
      question: string;
      answerType: LiveBonusAnswerType;
      points: number;
      lockAt?: string | null;
    } & Partial<LiveBonusConstraintsPayload>,
  ) => api.post<LiveBonusQuestion>(`/live/tournaments/${id}/bonus-questions`, body),
  updateBonusQuestion: (
    id: string,
    questionId: string,
    body: {
      question?: string;
      answerType?: LiveBonusAnswerType;
      points?: number;
      correctAnswer?: string | null;
      lockAt?: string | null;
    } & Partial<LiveBonusConstraintsPayload>,
  ) => api.patch<LiveBonusQuestion>(`/live/tournaments/${id}/bonus-questions/${questionId}`, body),
  deleteBonusQuestion: (id: string, questionId: string) =>
    api.delete<{ ok: true }>(`/live/tournaments/${id}/bonus-questions/${questionId}`),
  tournamentStandings: (id: string, stageKey?: string) =>
    api.get<LiveStandingView[]>(`/live/tournaments/${id}/standings${query({ stageKey })}`),

  // ── Competitions ──────────────────────────────────────────────────────────
  competitions: () => api.get<LiveCompetition[]>('/live/competitions'),
  competition: (id: string) => api.get<LiveCompetitionDetail>(`/live/competitions/${id}`),
  createCompetition: (body: {
    liveTournamentId: string;
    name: string;
    imageUrl?: string | null;
    scoringConfig?: LiveScoringConfig;
  }) => api.post<LiveCompetition>('/live/competitions', body),
  updateCompetition: (
    id: string,
    body: { name?: string; imageUrl?: string | null; scoringConfig?: LiveScoringConfig },
  ) => api.patch<LiveCompetition>(`/live/competitions/${id}`, body),
  deleteCompetition: (id: string) => api.delete<{ ok: true }>(`/live/competitions/${id}`),
  join: (inviteCode: string) =>
    api.post<LiveCompetition>('/live/competitions/join', { inviteCode }),
  leave: (id: string) => api.delete<{ ok: true }>(`/live/competitions/${id}/leave`),
  members: (id: string) => api.get<LiveMember[]>(`/live/competitions/${id}/members`),
  leaderboard: (id: string) => api.get<LiveLeaderboardRow[]>(`/live/competitions/${id}/leaderboard`),
  recalculateCompetition: (id: string) =>
    api.post<{ scoredPredictions: number }>(`/live/competitions/${id}/recalculate`, {}),

  // ── Fixtures and predictions ──────────────────────────────────────────────
  fixtures: (competitionId: string, params: ListFixturesParams = {}) =>
    api.get<LiveFixtureView[]>(`/live/competitions/${competitionId}/fixtures${query(params)}`),
  savePrediction: (competitionId: string, body: { fixtureId: string; homeScore: number; awayScore: number }) =>
    api.put<{ id: string }>(`/live/competitions/${competitionId}/predictions`, body),
  // ── League table prediction ───────────────────────────────────────────────
  tablePrediction: (competitionId: string) =>
    api.get<LiveTablePredictionView>(`/live/competitions/${competitionId}/table-prediction`),
  saveTablePrediction: (competitionId: string, body: { stageKey: string; orderedTeamIds: string[] }) =>
    api.put<LiveTablePrediction>(`/live/competitions/${competitionId}/table-prediction`, body),
  /** Drops the caller's table prediction. Refused once the table has locked. */
  clearTablePrediction: (competitionId: string) =>
    api.delete<{ deleted: number }>(`/live/competitions/${competitionId}/table-prediction`),
  otherUserTablePrediction: (competitionId: string, userId: string) =>
    api.get<LiveTablePrediction | null>(
      `/live/competitions/${competitionId}/table-prediction/${userId}`,
    ),

  bonusQuestions: (competitionId: string) =>
    api.get<LiveBonusQuestionView[]>(`/live/competitions/${competitionId}/bonus-questions`),
  bonusAnswers: (competitionId: string) =>
    api.get<LiveBonusAnswer[]>(`/live/competitions/${competitionId}/bonus-answers`),
  otherUserBonusAnswers: (competitionId: string, userId: string) =>
    api.get<LiveBonusAnswer[]>(`/live/competitions/${competitionId}/bonus-answers/${userId}`),
  saveBonusAnswer: (competitionId: string, body: { questionId: string; answer: string }) =>
    api.put<LiveBonusAnswer>(`/live/competitions/${competitionId}/bonus-answers`, body),
  /** Drops the caller's answers to every question that has not locked yet. */
  clearBonusAnswers: (competitionId: string) =>
    api.delete<{ deleted: number }>(`/live/competitions/${competitionId}/bonus-answers`),

  /** Another member's predictions, restricted server-side to fixtures that have locked. */
  otherUserPredictions: (competitionId: string, userId: string) =>
    api.get<
      Array<{
        liveFixtureId: string;
        homeScore: number;
        awayScore: number;
        points: number | null;
        correctOutcomePoints: number;
        correctGoalDifferencePoints: number;
        exactScorePoints: number;
      }>
    >(`/live/competitions/${competitionId}/predictions/${userId}`),

  /** Every member's prediction for one fixture. Refused until that fixture has locked. */
  fixturePredictions: (competitionId: string, fixtureId: string) =>
    api.get<LiveFixturePredictionRow[]>(
      `/live/competitions/${competitionId}/fixtures/${fixtureId}/predictions`,
    ),
};

// ── Query keys ────────────────────────────────────────────────────────────────
//
// Centralised so the SSE handler and the mutations invalidate exactly what the queries
// registered, rather than two files guessing at the same string array.

export const liveKeys = {
  competitions: ['live', 'competitions'] as const,
  competition: (id: string) => ['live', 'competition', id] as const,
  fixtures: (competitionId: string, stageKey?: string, matchday?: number) =>
    ['live', 'fixtures', competitionId, stageKey ?? null, matchday ?? null] as const,
  fixturePredictions: (competitionId: string, fixtureId: string) =>
    ['live', 'fixture-predictions', competitionId, fixtureId] as const,
  /** Prefix of every fixture's dropdown in one competition — scoring changes all of them. */
  allFixturePredictions: (competitionId: string) =>
    ['live', 'fixture-predictions', competitionId] as const,
  userPredictions: (competitionId: string, userId: string) =>
    ['live', 'user-predictions', competitionId, userId] as const,
  userTablePrediction: (competitionId: string, userId: string) =>
    ['live', 'user-table-prediction', competitionId, userId] as const,
  leaderboard: (competitionId: string) => ['live', 'leaderboard', competitionId] as const,
  tablePrediction: (competitionId: string) => ['live', 'table-prediction', competitionId] as const,
  members: (competitionId: string) => ['live', 'members', competitionId] as const,
  standings: (tournamentId: string, stageKey?: string) =>
    ['live', 'standings', tournamentId, stageKey ?? null] as const,
  tournaments: ['live', 'tournaments'] as const,
  tournament: (id: string) => ['live', 'tournament', id] as const,
  tournamentTeams: (id: string) => ['live', 'tournament', id, 'teams'] as const,
  tournamentFixtures: (id: string) => ['live', 'tournament', id, 'fixtures'] as const,
  selectedMatches: (id: string) => ['live', 'tournament', id, 'selected-matches'] as const,
  tournamentBonusQuestions: (id: string) => ['live', 'tournament', id, 'bonus-questions'] as const,
  bonusQuestions: (competitionId: string) => ['live', 'bonus-questions', competitionId] as const,
  bonusAnswers: (competitionId: string, userId?: string) =>
    ['live', 'bonus-answers', competitionId, userId ?? 'me'] as const,
  presets: ['live', 'presets'] as const,
};
