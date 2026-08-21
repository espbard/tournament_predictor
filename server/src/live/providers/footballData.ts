import type { LiveFixtureStatus, LiveProviderId } from '@tournament-predictor/shared';
import { RateLimiter } from './rateLimiter';
import {
  ProviderError,
  type FetchFixturesOptions,
  type LiveProvider,
  type ProviderCompetitionSummary,
  type ProviderFixture,
  type ProviderFixtureScore,
  type ProviderScorePair,
  type ProviderStandingRow,
  type ProviderTeam,
} from './types';

// ── football-data.org v4 adapter ──────────────────────────────────────────────
//
// Docs: https://docs.football-data.org/general/v4/index.html
//
// Every field mapping below was verified against live payloads on 2026-08-21; the
// captured responses are committed under __fixtures__/ and drive footballData.test.ts,
// so the mapping is testable without network access.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §6.

const BASE_URL = 'https://api.football-data.org/v4';

/** Free tier: 10 requests per minute, counted per account. */
const DEFAULT_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

// ── Raw payload shapes ────────────────────────────────────────────────────────
//
// Only the fields this adapter reads are declared. The provider sends a good deal more
// (odds, referees, area, full squads); anything not listed here is deliberately ignored.

interface RawScorePair {
  home: number | null;
  away: number | null;
}

interface RawScore {
  winner: string | null;
  duration: string | null;
  fullTime?: RawScorePair;
  halfTime?: RawScorePair;
  /** Present only when duration !== 'REGULAR'. This is the score that counts. */
  regularTime?: RawScorePair;
  extraTime?: RawScorePair;
  penalties?: RawScorePair;
}

interface RawTeamRef {
  id: number | null;
  name?: string | null;
  shortName?: string | null;
  tla?: string | null;
  crest?: string | null;
}

interface RawMatch {
  id: number;
  utcDate: string | null;
  status: string;
  matchday: number | null;
  stage: string | null;
  group: string | null;
  lastUpdated: string | null;
  minute?: number | null;
  homeTeam?: RawTeamRef | null;
  awayTeam?: RawTeamRef | null;
  score?: RawScore;
}

// ── Status mapping ────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, LiveFixtureStatus> = {
  SCHEDULED: 'scheduled',
  TIMED: 'scheduled',
  IN_PLAY: 'in_play',
  PAUSED: 'paused',
  FINISHED: 'finished',
  AWARDED: 'finished',
  POSTPONED: 'postponed',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
};

/**
 * Normalise a provider status.
 *
 * An unrecognised value maps to 'suspended' rather than 'scheduled'. That is the
 * conservative choice: 'scheduled' and 'postponed' are the two statuses that leave a
 * fixture *open for predictions*, so guessing either one for an unknown state could
 * reopen a match that has already been played. 'suspended' locks it and awards nothing.
 */
export function mapFixtureStatus(raw: string | null | undefined): LiveFixtureStatus {
  if (!raw) return 'suspended';
  const mapped = STATUS_MAP[raw.trim().toUpperCase()];
  if (mapped) return mapped;
  console.warn(`[football-data] unknown match status "${raw}" — treating as suspended`);
  return 'suspended';
}

/**
 * A date is only a real kickoff time once the provider marks the match TIMED.
 * SCHEDULED means the date is provisional — typically a placeholder for a round whose
 * exact slots have not been announced.
 */
export function isKickoffConfirmed(rawStatus: string | null | undefined): boolean {
  const s = (rawStatus ?? '').trim().toUpperCase();
  return s !== '' && s !== 'SCHEDULED';
}

// ── Score mapping ─────────────────────────────────────────────────────────────

const EMPTY_PAIR: ProviderScorePair = { home: null, away: null };

function pair(raw: RawScorePair | null | undefined): ProviderScorePair {
  if (!raw) return { ...EMPTY_PAIR };
  return { home: raw.home ?? null, away: raw.away ?? null };
}

/**
 * Extract the end-of-normal-time score — the single most important mapping in the
 * adapter, because it is the only score that awards points.
 *
 *   duration REGULAR         → fullTime is the 90-minute score
 *   duration EXTRA_TIME      → regularTime holds it; fullTime includes extra time
 *   duration PENALTY_SHOOTOUT→ regularTime holds it; fullTime adds the shootout tally
 *   anything else            → unknown, so refuse
 *
 * There is deliberately no fallback to fullTime when regularTime is missing. A real
 * example from the captured data: Liverpool 0-1 PSG after 90, won 4-1 on penalties,
 * comes back with fullTime 1-5. Scoring that would award points on a scoreline that
 * never happened. Returning nulls instead leaves the fixture unscored and visible in
 * the admin UI, which is recoverable; handing out wrong points quietly is not.
 */
export function normalTimeFromScore(score: RawScore | null | undefined): ProviderScorePair {
  if (!score) return { ...EMPTY_PAIR };

  const duration = (score.duration ?? 'REGULAR').trim().toUpperCase();
  if (duration === 'REGULAR') return pair(score.fullTime);

  if (score.regularTime && (score.regularTime.home != null || score.regularTime.away != null)) {
    return pair(score.regularTime);
  }
  return { ...EMPTY_PAIR };
}

function mapWinner(raw: string | null | undefined): ProviderFixtureScore['winner'] {
  const w = (raw ?? '').trim().toUpperCase();
  return w === 'HOME_TEAM' || w === 'AWAY_TEAM' || w === 'DRAW' ? w : null;
}

export function mapScore(score: RawScore | null | undefined): ProviderFixtureScore {
  return {
    normalTime: normalTimeFromScore(score),
    halfTime: pair(score?.halfTime),
    extraTime: pair(score?.extraTime),
    penalties: pair(score?.penalties),
    final: pair(score?.fullTime),
    winner: mapWinner(score?.winner),
    raw: score ?? null,
  };
}

// ── Entity mapping ────────────────────────────────────────────────────────────

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function mapMatch(raw: RawMatch): ProviderFixture {
  return {
    providerFixtureId: String(raw.id),
    // Before a draw, football-data sends a team object whose id is null.
    homeProviderTeamId: raw.homeTeam?.id != null ? String(raw.homeTeam.id) : null,
    awayProviderTeamId: raw.awayTeam?.id != null ? String(raw.awayTeam.id) : null,
    kickoffAt: emptyToNull(raw.utcDate),
    kickoffConfirmed: isKickoffConfirmed(raw.status),
    status: mapFixtureStatus(raw.status),
    providerStage: emptyToNull(raw.stage),
    groupName: emptyToNull(raw.group),
    matchday: raw.matchday ?? null,
    score: mapScore(raw.score),
    minute: raw.minute ?? null,
    providerLastUpdated: emptyToNull(raw.lastUpdated),
  };
}

export function mapTeam(raw: RawTeamRef & { id: number }): ProviderTeam {
  return {
    providerTeamId: String(raw.id),
    name: emptyToNull(raw.name) ?? String(raw.id),
    shortName: emptyToNull(raw.shortName),
    tla: emptyToNull(raw.tla),
    crestUrl: emptyToNull(raw.crest),
    // football-data expresses groups on the fixture, not the team. The sync engine
    // backfills this from fixtures for formats that actually have groups.
    groupName: null,
  };
}

/**
 * Flatten a standings payload.
 *
 * The provider returns three tables per stage — TOTAL, HOME and AWAY — and only TOTAL is
 * the real table. Keeping all three would triple every row and break the
 * (tournament, stage, team) unique constraint on live_standings.
 */
export function mapStandings(payload: unknown): ProviderStandingRow[] {
  const tables = (payload as { standings?: unknown[] } | null)?.standings ?? [];
  const rows: ProviderStandingRow[] = [];

  for (const table of tables as Array<Record<string, any>>) {
    if (String(table?.type ?? '').toUpperCase() !== 'TOTAL') continue;

    for (const entry of (table.table ?? []) as Array<Record<string, any>>) {
      if (entry?.team?.id == null) continue;
      rows.push({
        providerStage: emptyToNull(table.stage),
        groupName: emptyToNull(table.group),
        providerTeamId: String(entry.team.id),
        position: entry.position ?? 0,
        // Note the provider's field names differ from ours: playedGames, draw.
        played: entry.playedGames ?? 0,
        won: entry.won ?? 0,
        drawn: entry.draw ?? 0,
        lost: entry.lost ?? 0,
        goalsFor: entry.goalsFor ?? 0,
        goalsAgainst: entry.goalsAgainst ?? 0,
        goalDifference: entry.goalDifference ?? 0,
        points: entry.points ?? 0,
        // Empty string on HOME/AWAY tables and early in a season; store null instead.
        form: emptyToNull(entry.form),
      });
    }
  }

  return rows;
}

export function mapCompetition(raw: Record<string, any>): ProviderCompetitionSummary {
  return {
    providerCompetitionId: emptyToNull(raw.code) ?? String(raw.id),
    name: emptyToNull(raw.name) ?? '',
    code: emptyToNull(raw.code),
    type: emptyToNull(raw.type),
    emblemUrl: emptyToNull(raw.emblem),
    // football-data identifies a season by the year it starts in.
    currentSeason: raw.currentSeason?.startDate
      ? String(raw.currentSeason.startDate).slice(0, 4)
      : null,
  };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class FootballDataProvider implements LiveProvider {
  readonly id: LiveProviderId = 'football_data';

  private readonly limiter: RateLimiter;

  constructor(
    private readonly apiKey: string | undefined = process.env.FOOTBALL_DATA_API_KEY,
    limiter?: RateLimiter,
  ) {
    this.limiter =
      limiter ??
      new RateLimiter({
        limit: Number(process.env.FOOTBALL_DATA_RATE_LIMIT) || DEFAULT_RATE_LIMIT,
        intervalMs: RATE_WINDOW_MS,
      });
  }

  /** Requests still available in the current rate-limit window. */
  availableRequests(): number {
    return this.limiter.availableNow();
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.apiKey) {
      throw new ProviderError('FOOTBALL_DATA_API_KEY is not set', null, path, false);
    }

    return this.limiter.schedule(async () => {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          headers: { 'X-Auth-Token': this.apiKey! },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ProviderError(`network error: ${message}`, null, path, true);
      }

      if (res.status === 429) {
        // Honour Retry-After so the whole queue backs off, not just this request.
        const retryAfter = Number(res.headers.get('Retry-After'));
        this.limiter.pauseFor(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_WINDOW_MS);
        throw new ProviderError('rate limited', 429, path, true);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderError(
          `${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
          res.status,
          path,
          res.status >= 500,
        );
      }

      return (await res.json()) as T;
    });
  }

  async listCompetitions(): Promise<ProviderCompetitionSummary[]> {
    const data = await this.get<{ competitions?: Record<string, any>[] }>('/competitions');
    return (data.competitions ?? []).map(mapCompetition);
  }

  async fetchTeams(competitionId: string, season: string): Promise<ProviderTeam[]> {
    const data = await this.get<{ teams?: Array<RawTeamRef & { id: number }> }>(
      `/competitions/${encodeURIComponent(competitionId)}/teams?season=${encodeURIComponent(season)}`,
    );
    return (data.teams ?? []).filter(t => t?.id != null).map(mapTeam);
  }

  async fetchFixtures(
    competitionId: string,
    season: string,
    opts: FetchFixturesOptions = {},
  ): Promise<ProviderFixture[]> {
    const params = new URLSearchParams({ season });
    if (opts.dateFrom) params.set('dateFrom', opts.dateFrom);
    if (opts.dateTo) params.set('dateTo', opts.dateTo);

    const data = await this.get<{ matches?: RawMatch[] }>(
      `/competitions/${encodeURIComponent(competitionId)}/matches?${params}`,
    );
    return (data.matches ?? []).map(mapMatch);
  }

  async fetchStandings(competitionId: string, season: string): Promise<ProviderStandingRow[]> {
    const data = await this.get<unknown>(
      `/competitions/${encodeURIComponent(competitionId)}/standings?season=${encodeURIComponent(season)}`,
    );
    return mapStandings(data);
  }
}
