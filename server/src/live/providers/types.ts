import type { LiveFixtureStatus, LiveProviderId } from '@tournament-predictor/shared';

// ── Provider abstraction ──────────────────────────────────────────────────────
//
// Provider-neutral DTOs plus the interface every adapter satisfies. Nothing above this
// layer — sync, scoring, routes — is allowed to know that football-data.org exists, so
// swapping or adding a provider is one new file plus one registry entry.
//
// These are *transport* types: they describe what an adapter returns, not what is stored.
// The sync engine maps them onto the live_* tables, resolving provider ids to local ones.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §6.

/** A home/away pair. Either side is null when the provider has no value yet. */
export interface ProviderScorePair {
  home: number | null;
  away: number | null;
}

export interface ProviderCompetitionSummary {
  providerCompetitionId: string;
  name: string;
  code: string | null;
  /** 'LEAGUE' | 'CUP' for football-data; kept as a free string, it is informational. */
  type: string | null;
  emblemUrl: string | null;
  currentSeason: string | null;
}

export interface ProviderTeam {
  providerTeamId: string;
  name: string;
  shortName?: string | null;
  tla?: string | null;
  crestUrl?: string | null;
  /** Null for formats with a single table (UCL league phase, any domestic league). */
  groupName?: string | null;
}

export interface ProviderFixtureScore {
  /**
   * End of 90 minutes — the only score that awards points.
   *
   * Both sides are null when the provider cannot tell us the normal-time result, which
   * for a finished fixture means it must not be scored. See normalTimeFromScore in
   * footballData.ts for why this is never allowed to fall back to full time.
   */
  normalTime: ProviderScorePair;
  halfTime: ProviderScorePair;
  extraTime: ProviderScorePair;
  penalties: ProviderScorePair;
  /**
   * The provider's own full-time score. Display only — never scored.
   *
   * Note this is not "normal time + extra time": for a shootout football-data reports
   * regular time plus the shootout tally (a 0-1 tie won 4-1 on penalties comes back as
   * 1-5), so it is not a football scoreline at all.
   */
  final: ProviderScorePair;
  winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
  /** The provider's score object verbatim, so any mapping bug stays diagnosable. */
  raw: unknown;
}

export interface ProviderFixture {
  providerFixtureId: string;
  /** Null before a draw has assigned teams to a knockout slot. */
  homeProviderTeamId: string | null;
  awayProviderTeamId: string | null;
  /**
   * The teams as embedded on the fixture itself.
   *
   * Redundant with the ids above when the teams endpoint already covers them, which is the
   * normal case. They matter when it does not: the sync engine backfills from these so a
   * fixture never ends up pointing at a team row that was never created — for instance if
   * `/teams` 404s for an unpublished season while `/matches` still returns data.
   */
  homeTeam: ProviderTeam | null;
  awayTeam: ProviderTeam | null;
  /** ISO 8601, or null when no date has been published. */
  kickoffAt: string | null;
  /** False while the date is a provisional placeholder rather than a confirmed time. */
  kickoffConfirmed: boolean;
  status: LiveFixtureStatus;
  /** Raw provider stage string. Mapped to an internal stage key by the sync engine. */
  providerStage: string | null;
  groupName: string | null;
  /**
   * Round number within the stage. For a two-legged knockout tie football-data uses this
   * as the leg number (1 or 2), which is more reliable than ordering legs by kickoff.
   */
  matchday: number | null;
  score: ProviderFixtureScore;
  /** Minutes played, when the provider reports it for an in-play fixture. */
  minute: number | null;
  providerLastUpdated: string | null;
}

export interface ProviderStandingRow {
  /** Raw provider stage string, mapped to an internal stage key by the sync engine. */
  providerStage: string | null;
  groupName: string | null;
  providerTeamId: string;
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
}

/**
 * One player in a competition's scorer list.
 *
 * `assists` is carried because the top-scorer ranking breaks a tie on goals with it —
 * a provider that does not report assists should send 0 rather than guessing, which
 * simply falls the tie-break through to the player's name.
 */
export interface ProviderScorer {
  providerPlayerId: string;
  name: string;
  /** The club the provider lists them under. Null when the payload omits it. */
  providerTeamId: string | null;
  goals: number;
  assists: number;
}

export interface FetchFixturesOptions {
  /** ISO date, inclusive. Used by the live window sync to fetch only today's fixtures. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Where the season sits in the calendar, for an adapter whose provider has no season
   * parameter — bigballsdata is keyed by date instead. Supplied by the sync engine,
   * which knows the competition and therefore its calendar; ignored by an adapter that
   * can simply ask for a season by name.
   */
  seasonWindow?: { dateFrom: string; dateTo: string };
}

/**
 * One endpoint a diagnostic run asked about.
 *
 * The keys are the questions worth asking of any football provider, not football-data's
 * URL shapes: does the competition list this season, does the season-filtered match list
 * have anything, does the unfiltered one, and do teams and a table exist. An adapter maps
 * them onto its own endpoints.
 */
export type ProviderProbeKey =
  | 'competition'
  | 'matches_season'
  /** The same request again, asking for a bigger page — does the cap lift? */
  | 'matches_paged'
  | 'matches_unfiltered'
  | 'teams'
  | 'standings'
  /** Does this provider serve a scorer list for the season, and how long is it? */
  | 'scorers';

export interface ProviderProbe {
  key: ProviderProbeKey;
  /**
   * Which adapter answered. Set by the diagnostic rather than the adapter, because a
   * tournament may read fixtures from one provider and everything else from another, and
   * a probe list that does not say which is which cannot be read at all.
   */
  provider?: LiveProviderId;
  /** The request as made, credentials excluded. Shown to an admin verbatim. */
  url: string;
  status: number | null;
  ok: boolean;
  /** Items returned — matches, teams, table rows. Null when the request failed. */
  count: number | null;
  /**
   * Matches that belong to the season asked for. Differs from `count` only on
   * `matches_unfiltered`, which serves whatever the provider calls the current season.
   */
  countForSeason: number | null;
  /** Anything else worth reading: a stage breakdown, the seasons listed, an error. */
  detail: string | null;
  /**
   * The response itself, trimmed: the envelope with its list cut to one item.
   *
   * The point is the *shape* — which keys wrap the data, what pagination is advertised,
   * what a record actually looks like — for a provider whose documentation does not say.
   * Never contains credentials: it is the response body, and the key travels in a header.
   */
  rawSample?: string | null;
}

export interface LiveProvider {
  readonly id: LiveProviderId;
  listCompetitions(): Promise<ProviderCompetitionSummary[]>;
  fetchTeams(competitionId: string, season: string): Promise<ProviderTeam[]>;
  fetchFixtures(
    competitionId: string,
    season: string,
    opts?: FetchFixturesOptions,
  ): Promise<ProviderFixture[]>;
  fetchStandings(competitionId: string, season: string): Promise<ProviderStandingRow[]>;
  /**
   * The competition's scorers, most goals first.
   *
   * Optional: a fixtures-only provider has none, and the top-scorer ranking falls back to
   * the goal counts an admin maintains by hand. An adapter that implements it should ask
   * for `limit` players and let the caller notice a truncated list rather than paging
   * silently — the shortlist is a handful of names, not the whole competition.
   */
  fetchScorers?(competitionId: string, season: string, limit?: number): Promise<ProviderScorer[]>;
  /**
   * Ask every endpoint separately and report what came back, without throwing.
   *
   * Exists because "0 fixtures" has several causes that look identical from the outside:
   * a season the provider has not created, a season it has created without a match
   * calendar, a filter that returns nothing, and a competition or season we have wrong.
   * Nothing here writes to the database.
   */
  probe(
    competitionId: string,
    season: string,
    seasonWindow?: { dateFrom: string; dateTo: string },
  ): Promise<ProviderProbe[]>;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Anything the provider refused or could not answer. The sync tick catches these and
 * records the message in live_tournaments.last_sync_error rather than crashing, so one
 * bad competition does not stop the others from syncing.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly path: string,
    /** True when retrying later is likely to succeed: rate limits, 5xx, network faults. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /**
   * A season the provider has not published yet. Expected rather than broken — a
   * tournament created before its draw 404s until the provider creates the season, so
   * the sync engine treats this as "no data yet" instead of an error worth surfacing.
   */
  get isSeasonUnavailable(): boolean {
    return this.status === 404;
  }
}
