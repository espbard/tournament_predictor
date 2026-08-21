import { api } from '@/lib/api';
import type {
  LiveCompetition,
  LiveFixture,
  LiveFormatDef,
  LiveFormatKey,
  LiveScoringConfig,
  LiveStageDef,
  LiveStanding,
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
  };
}

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
    body: { name?: string; imageUrl?: string | null; status?: string; syncEnabled?: boolean },
  ) => api.patch<LiveTournament>(`/live/tournaments/${id}`, body),
  deleteTournament: (id: string) => api.delete<{ ok: true }>(`/live/tournaments/${id}`),
  syncTournament: (id: string, full: boolean) =>
    api.post<LiveSyncResult>(`/live/tournaments/${id}/sync`, { full }),
  recalculateTournament: (id: string) =>
    api.post<{ scoredPredictions: number; affectedCompetitionIds: string[] }>(
      `/live/tournaments/${id}/recalculate`,
      {},
    ),
  tournamentTeams: (id: string) => api.get<LiveTeam[]>(`/live/tournaments/${id}/teams`),
  tournamentFixtures: (id: string, params: ListFixturesParams = {}) =>
    api.get<LiveFixtureView[]>(`/live/tournaments/${id}/fixtures${query(params)}`),
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
  otherUserPredictions: (competitionId: string, userId: string) =>
    api.get<Array<{ liveFixtureId: string; homeScore: number; awayScore: number; points: number | null }>>(
      `/live/competitions/${competitionId}/predictions/${userId}`,
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
  leaderboard: (competitionId: string) => ['live', 'leaderboard', competitionId] as const,
  members: (competitionId: string) => ['live', 'members', competitionId] as const,
  standings: (tournamentId: string, stageKey?: string) =>
    ['live', 'standings', tournamentId, stageKey ?? null] as const,
  tournaments: ['live', 'tournaments'] as const,
  tournament: (id: string) => ['live', 'tournament', id] as const,
  tournamentTeams: (id: string) => ['live', 'tournament', id, 'teams'] as const,
  presets: ['live', 'presets'] as const,
};
