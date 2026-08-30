import type { LiveFixtureStatus, LiveProviderId } from '@tournament-predictor/shared';
import { RateLimiter } from './rateLimiter';
import {
  ProviderError,
  type FetchFixturesOptions,
  type LiveProvider,
  type ProviderCompetitionSummary,
  type ProviderFixture,
  type ProviderFixtureScore,
  type ProviderProbe,
  type ProviderProbeKey,
  type ProviderScorePair,
  type ProviderStandingRow,
  type ProviderTeam,
} from './types';

// ── bigballsdata.com adapter — FIXTURES ONLY ──────────────────────────────────
//
// Added because football-data did not publish the Champions League 2026/27 match
// calendar in time to be useful. This adapter serves fixtures; teams and standings stay
// on football-data, which is what `live_tournaments.fixture_provider` expresses.
//
// ⚠ READ THIS BEFORE TRUSTING IT FOR KNOCKOUTS. The documented match schema is:
//
//   id, sport, league, home{name,short_name,logo_url}, away{…}, kickoff_utc, status,
//   score{home,away}, linescore, attendance, broadcast, has_odds
//
// Four things our fixture model wants are not in it:
//
//   1. No team ids. A match names its clubs and nothing else, so a fixture is joined to
//      a stored team by name — see server/src/live/teamMatching.ts. Unmatched fixtures
//      are stored unlinked and reported, never guessed at.
//   2. No stage. Every fixture would land with stage_key = null and so be unpredictable,
//      which is useless. The sync engine therefore files a stage-less fixture under the
//      tournament's startStageKey — correct for the Champions League league phase, and
//      wrong for the knockout rounds, which this provider cannot describe.
//   3. No matchday, and the matchday *is* the gameweek here — selections are keyed by it
//      and the fixtures tab pages by it. It is derived from the kickoff calendar instead,
//      in server/src/live/matchdays.ts, which recovers the published round numbering as
//      long as rounds are separated by a break. Nothing to do in this adapter beyond
//      reporting null, but do not assume a null matchday is harmless.
//   4. No breakdown of the score. `score` is one pair with no half-time, extra-time,
//      penalty or regular-time split. The whole scoring model rests on the
//      end-of-90-minutes score (see normalTimeFromScore in footballData.ts, and why it
//      refuses to guess), and for a knockout tie decided in extra time this field cannot
//      be told apart from one that includes it.
//
// So: fine for a league phase, where every match ends at 90 minutes, there is one stage,
// and the rounds are a fortnight apart. Not sufficient for two-legged knockouts. Whoever
// revisits this in February should move fixtures back to football-data — by then it will
// have the season — or confirm that a richer field set exists and map it here.
//
// The endpoint shapes below follow bigballsdata's published documentation. They have NOT
// been exercised against the live API from this repo: the host is unreachable from the
// environment this was written in. `npm run live:capture -w server` fetches and saves
// real payloads under __fixtures__/ so the mapping can be pinned the way the
// football-data one is — run it before relying on any of this.

const BASE_URL = process.env.BIG_BALLS_BASE_URL ?? 'https://api.bigballsdata.com';

/** Free tier: 1,000 requests per day. The per-minute cap is a courtesy, not a rule. */
const DEFAULT_RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

// ── Raw payload shapes ────────────────────────────────────────────────────────

interface RawTeamRef {
  name?: string | null;
  short_name?: string | null;
  logo_url?: string | null;
}

interface RawScore {
  home?: number | null;
  away?: number | null;
}

interface RawMatch {
  id: string;
  sport?: string | null;
  league?: string | null;
  home?: RawTeamRef | null;
  away?: RawTeamRef | null;
  kickoff_utc?: string | null;
  status?: string | null;
  score?: RawScore | null;
  /**
   * Not in the documented field list, but read when present: without a stage and a round
   * this adapter cannot describe a knockout tie at all, so if the API does supply them
   * under any of these names it is worth using rather than discarding.
   */
  stage?: string | null;
  round?: string | null;
  matchday?: number | string | null;
  minute?: number | null;
  updated_at?: string | null;
}

// ── Status mapping ────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, LiveFixtureStatus> = {
  scheduled: 'scheduled',
  upcoming: 'scheduled',
  timed: 'scheduled',
  pre: 'scheduled',
  live: 'in_play',
  in_progress: 'in_play',
  inprogress: 'in_play',
  playing: 'in_play',
  half_time: 'paused',
  halftime: 'paused',
  paused: 'paused',
  break: 'paused',
  final: 'finished',
  finished: 'finished',
  ft: 'finished',
  complete: 'finished',
  completed: 'finished',
  ended: 'finished',
  postponed: 'postponed',
  delayed: 'postponed',
  suspended: 'suspended',
  abandoned: 'suspended',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

/**
 * Normalise a provider status.
 *
 * Same safety rule as the football-data adapter: an unrecognised value becomes
 * 'suspended', never 'scheduled'. 'scheduled' and 'postponed' leave a fixture open for
 * predictions, so guessing either for an unknown state could reopen a played match.
 */
export function mapBigBallsStatus(raw: string | null | undefined): LiveFixtureStatus {
  if (!raw) return 'suspended';
  const mapped = STATUS_MAP[raw.trim().toLowerCase().replace(/[\s-]+/g, '_')];
  if (mapped) return mapped;
  console.warn(`[big-balls] unknown match status "${raw}" — treating as suspended`);
  return 'suspended';
}

// ── Score mapping ─────────────────────────────────────────────────────────────

const EMPTY_PAIR: ProviderScorePair = { home: null, away: null };

/**
 * Map the one score this provider gives.
 *
 * It is reported as `normalTime` because for a league-phase match that is exactly what it
 * is. Everything else stays null rather than being invented: `final` is deliberately not
 * filled in from the same numbers, so nothing downstream can mistake a single pair for a
 * provider that distinguishes 90 minutes from extra time.
 */
export function mapBigBallsScore(raw: RawScore | null | undefined): ProviderFixtureScore {
  const home = typeof raw?.home === 'number' ? raw.home : null;
  const away = typeof raw?.away === 'number' ? raw.away : null;

  return {
    normalTime: { home, away },
    halfTime: { ...EMPTY_PAIR },
    extraTime: { ...EMPTY_PAIR },
    penalties: { ...EMPTY_PAIR },
    final: { home, away },
    winner: home == null || away == null ? null : home > away ? 'HOME_TEAM' : away > home ? 'AWAY_TEAM' : 'DRAW',
    raw: raw ?? null,
  };
}

// ── Entity mapping ────────────────────────────────────────────────────────────

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function toMatchday(raw: number | string | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A team as named on a fixture.
 *
 * `providerTeamId` is the normalised name rather than a real id, because there is no id
 * to use. It exists only so the DTO is well-formed; the sync engine never stores a team
 * under it — a fixture from this provider is joined to a team football-data already
 * created, by name. See server/src/live/teamMatching.ts.
 */
export function mapBigBallsTeam(raw: RawTeamRef | null | undefined): ProviderTeam | null {
  const name = emptyToNull(raw?.name);
  if (!name) return null;
  return {
    providerTeamId: `name:${name.toLowerCase()}`,
    name,
    shortName: emptyToNull(raw?.short_name),
    tla: null,
    crestUrl: emptyToNull(raw?.logo_url),
    groupName: null,
  };
}

export function mapBigBallsMatch(raw: RawMatch): ProviderFixture {
  const home = mapBigBallsTeam(raw.home);
  const away = mapBigBallsTeam(raw.away);

  return {
    providerFixtureId: String(raw.id),
    // No ids exist, so nothing can be linked by id. The sync engine matches by name off
    // the embedded teams below.
    homeProviderTeamId: null,
    awayProviderTeamId: null,
    homeTeam: home,
    awayTeam: away,
    kickoffAt: emptyToNull(raw.kickoff_utc),
    // Every kickoff this provider publishes is a real time; there is no provisional
    // marker in the schema, so a fixture with a date is treated as confirmed.
    kickoffConfirmed: emptyToNull(raw.kickoff_utc) !== null,
    status: mapBigBallsStatus(raw.status),
    // Null for the documented schema. The sync engine fills a stage-less fixture with the
    // tournament's startStageKey — see the warning at the top of this file.
    providerStage: emptyToNull(raw.stage) ?? emptyToNull(raw.round),
    groupName: null,
    matchday: toMatchday(raw.matchday),
    score: mapBigBallsScore(raw.score),
    minute: typeof raw.minute === 'number' ? raw.minute : null,
    providerLastUpdated: emptyToNull(raw.updated_at),
  };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class BigBallsProvider implements LiveProvider {
  readonly id: LiveProviderId = 'big_balls';

  private readonly limiter: RateLimiter;

  constructor(
    private readonly apiKey: string | undefined = process.env.BIG_BALLS_API_KEY,
    limiter?: RateLimiter,
  ) {
    this.limiter =
      limiter ??
      new RateLimiter({
        limit: Number(process.env.BIG_BALLS_RATE_LIMIT) || DEFAULT_RATE_LIMIT,
        intervalMs: RATE_WINDOW_MS,
      });
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.apiKey) {
      throw new ProviderError('BIG_BALLS_API_KEY is not set', null, path, false);
    }

    return this.limiter.schedule(async () => {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          headers: {
            Authorization: `Bearer ${this.apiKey!}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ProviderError(`network error: ${message}`, null, path, true);
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        this.limiter.pauseFor(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_WINDOW_MS,
        );
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

  /**
   * Pull the match array out of the response.
   *
   * Accepts a bare array or a `data` / `matches` / `results` envelope: the documentation
   * shows one match object rather than a whole response, so the wrapper is not pinned
   * down. An unrecognised shape throws rather than being read as "no matches" — the one
   * outcome this whole exercise exists to stop being silent.
   */
  private static matchesFrom(body: unknown, path: string): RawMatch[] {
    if (Array.isArray(body)) return body as RawMatch[];
    for (const key of ['data', 'matches', 'results', 'items']) {
      const value = (body as Record<string, unknown> | null)?.[key];
      if (Array.isArray(value)) return value as RawMatch[];
    }
    throw new ProviderError(
      `unrecognised response shape: expected an array of matches, got ${
        body === null ? 'null' : typeof body
      } with keys ${Object.keys((body as object) ?? {}).slice(0, 8).join(', ') || 'none'}`,
      200,
      path,
      false,
    );
  }

  private matchesPath(competitionId: string, opts: FetchFixturesOptions = {}): string {
    const params = new URLSearchParams({ sport: 'football', league: competitionId });
    if (opts.dateFrom) params.set('date_from', opts.dateFrom);
    if (opts.dateTo) params.set('date_to', opts.dateTo);
    return `/v1/matches?${params}`;
  }

  async listCompetitions(): Promise<ProviderCompetitionSummary[]> {
    const body = await this.get<any>('/v1/leagues?sport=football');
    const leagues: any[] = Array.isArray(body) ? body : (body?.data ?? body?.leagues ?? []);
    return leagues.map(l => ({
      providerCompetitionId: String(l.key ?? l.id ?? l.slug ?? ''),
      name: String(l.name ?? l.key ?? ''),
      code: emptyToNull(l.key ?? l.slug),
      type: emptyToNull(l.type),
      emblemUrl: emptyToNull(l.logo_url ?? l.logo),
      currentSeason: emptyToNull(l.season != null ? String(l.season) : null),
    }));
  }

  /**
   * Not served here. Teams come from the tournament's main provider, which is the whole
   * point of the split — this adapter has no team identity to offer, only names.
   */
  async fetchTeams(): Promise<ProviderTeam[]> {
    throw new ProviderError(
      'big_balls serves fixtures only; teams come from the tournament provider',
      null,
      '/v1/matches',
      false,
    );
  }

  /** Not served here. Standings stay on the tournament's main provider. */
  async fetchStandings(): Promise<ProviderStandingRow[]> {
    throw new ProviderError(
      'big_balls serves fixtures only; standings come from the tournament provider',
      null,
      '/v1/standings',
      false,
    );
  }

  /**
   * The season is not a parameter here.
   *
   * bigballsdata's match list is keyed by league and date, not by season the way
   * football-data's is, so a season is expressed as a date range. Callers that pass one
   * without dates get the league's current calendar, which for an in-progress season is
   * what they want; `syncLiveWindow` passes the window it cares about.
   */
  async fetchFixtures(
    competitionId: string,
    _season: string,
    opts: FetchFixturesOptions = {},
  ): Promise<ProviderFixture[]> {
    const path = this.matchesPath(competitionId, opts);
    const body = await this.get<unknown>(path);
    return BigBallsProvider.matchesFrom(body, path).map(mapBigBallsMatch);
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  private async probeOne(
    key: ProviderProbeKey,
    path: string,
    summarise: (body: any) => { count: number | null; countForSeason: number | null; detail: string | null },
  ): Promise<ProviderProbe> {
    try {
      const body = await this.get<any>(path);
      const { count, countForSeason, detail } = summarise(body);
      return { key, url: `${BASE_URL}${path}`, status: 200, ok: true, count, countForSeason, detail };
    } catch (err) {
      return {
        key,
        url: `${BASE_URL}${path}`,
        status: err instanceof ProviderError ? err.status : null,
        ok: false,
        count: null,
        countForSeason: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probe(competitionId: string, _season: string): Promise<ProviderProbe[]> {
    const matchesPath = this.matchesPath(competitionId);

    return [
      await this.probeOne('competition', '/v1/leagues?sport=football', body => {
        const leagues: any[] = Array.isArray(body) ? body : (body?.data ?? body?.leagues ?? []);
        const keys = leagues.map(l => String(l.key ?? l.id ?? l.slug ?? '')).filter(Boolean);
        return {
          count: keys.length,
          countForSeason: keys.includes(competitionId) ? 1 : 0,
          detail:
            `league "${competitionId}" is ${keys.includes(competitionId) ? 'listed' : 'NOT listed'}` +
            ` · keys: ${keys.slice(0, 12).join(', ') || 'none'}`,
        };
      }),

      await this.probeOne('matches_season', matchesPath, body => {
        const matches = BigBallsProvider.matchesFrom(body, matchesPath);
        const dated = matches.filter(m => !!m.kickoff_utc).length;
        const named = matches.filter(m => m.home?.name && m.away?.name).length;
        return {
          count: matches.length,
          countForSeason: matches.length,
          detail:
            matches.length === 0
              ? 'the response carried no matches at all'
              : `${dated} with a kickoff time, ${named} with both teams named · ` +
                `first: ${matches[0]?.home?.name ?? '?'} v ${matches[0]?.away?.name ?? '?'} ` +
                `${matches[0]?.kickoff_utc ?? 'no date'}`,
        };
      }),
    ];
  }
}
