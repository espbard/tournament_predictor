import type { LiveFixtureStatus, LiveProviderId } from '@tournament-predictor/shared';
import { RateLimiter } from './rateLimiter';
import { trimmedSample } from './sample';
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
/** Pages a single fixture fetch will follow before giving up. */
const MAX_PAGES = 20;
/** Page size asked for when probing whether this API takes a size at all. */
const PROBE_PAGE_SIZE = 500;
/** Paging parameter names to try, in the order they are worth trying. */
const LIMIT_PARAMS = ['limit', 'per_page', 'page_size', 'count'];
const PAGE_PARAMS = ['page', 'page_number'];
const OFFSET_PARAMS = ['offset', 'skip', 'start'];
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

/** Narrow an unknown body to something indexable, without throwing on null. */
function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' ? (value as Record<string, any>) : {};
}

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

/**
 * The calendar span of a season the provider names by its starting year.
 *
 * June of that year through July of the next: wide enough for qualifiers in July and a
 * final in June, and narrow enough that it cannot pull in a neighbouring season.
 */
export function seasonDateRange(season: string): FetchFixturesOptions {
  const start = Number.parseInt(season, 10);
  // Not a year we understand, so ask without a range and let the provider decide.
  if (!Number.isFinite(start)) return {};
  return { dateFrom: `${start}-06-01`, dateTo: `${start + 1}-07-31` };
}

/**
 * Matches per calendar date, for the diagnostic.
 *
 * A Champions League league-phase round is 18 matches across two nights. Seeing "9, 9,
 * 9, 9" or "10, 10" instead is the quickest way to tell a truncated response from a
 * complete one, without anyone having to count fixtures in the UI.
 */
function countRounds(matches: RawMatch[]): Array<{ date: string; count: number }> {
  const byDate = new Map<string, number>();
  for (const match of matches) {
    const date = (match.kickoff_utc ?? '').slice(0, 10);
    if (date === '') continue;
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 12)
    .map(([date, count]) => ({ date, count }));
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
  static matchesFrom(body: unknown, path: string): RawMatch[] {
    if (Array.isArray(body)) return body as RawMatch[];
    for (const key of ['data', 'matches', 'results', 'items']) {
      const value = (body as Record<string, unknown> | null)?.[key];
      if (Array.isArray(value)) return value as RawMatch[];
    }
    throw new ProviderError(
      `unrecognised response shape: expected an array of matches, got ${
        body === null ? 'null' : typeof body
      } with keys ${Object.keys((object(body))).slice(0, 8).join(', ') || 'none'}`,
      200,
      path,
      false,
    );
  }

  /**
   * How many matches the provider says exist for this query, if it says at all.
   *
   * Worth more than the array length: it is the only way to notice that a response was
   * a page rather than the whole answer.
   */
  static totalFrom(body: unknown): number | null {
    const b = object(body);
    const meta = object(b.meta ?? b.pagination ?? b);
    for (const key of ['total', 'total_count', 'count', 'total_results']) {
      const value = (meta as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  }

  /**
   * The request that fetches the next page, or null when this is the last one.
   *
   * Written against the pagination shapes a JSON API is likely to use, because
   * bigballsdata's documentation shows a single match object and never a whole response.
   * A `next` link is followed verbatim; otherwise page/offset are advanced from whatever
   * metadata is present. When nothing is recognised this returns null and
   * `looksTruncated` below is what catches a silently paged response.
   */
  static nextPagePath(body: unknown, currentPath: string, fetched: number): string | null {
    const b = object(body);
    const meta = object(b.meta ?? b.pagination ?? b);

    // Best case: the provider hands us the URL.
    const link = b.next ?? b.next_url ?? object(b.links).next;
    if (typeof link === 'string' && link !== '') {
      return link.startsWith('http') ? link.slice(new URL(link).origin.length) : link;
    }

    const url = new URL(currentPath, 'https://x');
    const params = url.searchParams;
    const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

    const cursor = b.next_cursor ?? meta.next_cursor;
    if (typeof cursor === 'string' && cursor !== '') {
      params.set('cursor', cursor);
      return `${url.pathname}?${params}`;
    }

    const total = BigBallsProvider.totalFrom(body);
    const hasMore =
      typeof b.has_more === 'boolean'
        ? b.has_more
        : total !== null
          ? fetched < total
          : null;
    if (hasMore === false) return null;

    const page = num(meta.page ?? meta.current_page);
    const totalPages = num(meta.total_pages ?? meta.last_page);
    if (page !== null && (totalPages === null || page < totalPages)) {
      params.set('page', String(page + 1));
      return `${url.pathname}?${params}`;
    }

    // Offset/limit, either stated in the metadata or inferred from what we asked for.
    // Note the guard on the query parameter: an absent one reads as 0 through Number(),
    // which would ask for a page of nothing and end the walk one page in.
    const askedLimit = params.get('limit');
    const limit =
      num(meta.limit ?? meta.per_page ?? meta.page_size) ??
      (askedLimit !== null ? num(Number(askedLimit)) : null);
    if (limit !== null && hasMore === true) {
      params.set('offset', String(fetched));
      params.set('limit', String(limit));
      return `${url.pathname}?${params}`;
    }

    if (hasMore === true && page === null) {
      params.set('page', '2');
      return `${url.pathname}?${params}`;
    }

    return null;
  }

  /**
   * Whether a response that claimed no more pages looks like it was one anyway.
   *
   * A whole Champions League league phase is 144 matches. Getting back exactly 50, or any
   * other round page size, with no pagination metadata to explain it, is the signature of
   * a provider that pages by default and describes it somewhere this adapter does not
   * read. Loud, because the alternative is quietly playing a season on a third of it.
   */
  static looksTruncated(count: number, total: number | null): boolean {
    if (total !== null) return count < total;
    return [20, 25, 50, 100, 200, 250, 500].includes(count);
  }

  private matchesPath(competitionId: string, opts: FetchFixturesOptions = {}): string {
    const params = new URLSearchParams({ sport: 'football', league: competitionId });
    if (opts.dateFrom) params.set('date_from', opts.dateFrom);
    if (opts.dateTo) params.set('date_to', opts.dateTo);
    return `/v1/matches?${params}`;
  }

  /** Follow pagination until the provider runs out, or the cap trips. */
  private async fetchAllMatches(firstPath: string): Promise<RawMatch[]> {
    const byId = new Map<string, RawMatch>();
    const add = (matches: RawMatch[]): number => {
      let added = 0;
      for (const match of matches) {
        const id = String(match.id);
        if (byId.has(id)) continue;
        byId.set(id, match);
        added++;
      }
      return added;
    };

    const firstBody = await this.get<unknown>(firstPath);
    const first = BigBallsProvider.matchesFrom(firstBody, firstPath);
    add(first);

    // Best case: the response says how to get the rest, and we just follow it.
    const requested = new Set([firstPath]);
    let path = BigBallsProvider.nextPagePath(firstBody, firstPath, byId.size);
    while (path !== null && requested.size < MAX_PAGES && !requested.has(path)) {
      requested.add(path);
      const body: unknown = await this.get<unknown>(path);
      add(BigBallsProvider.matchesFrom(body, path));
      path = BigBallsProvider.nextPagePath(body, path, byId.size);
    }

    const total = BigBallsProvider.totalFrom(firstBody);
    if (requested.size > 1 || !BigBallsProvider.looksTruncated(byId.size, total)) {
      return [...byId.values()];
    }

    // Nothing in the envelope explained a suspiciously round count, so find out by
    // asking. Every convention below is tried against the provider and kept only if it
    // actually returns matches we do not already hold — no guessing at which one this
    // API uses, and a provider that ignores an unknown parameter simply returns the same
    // page again and is discarded. See discoverPaging.
    console.warn(
      `[big-balls] ${firstPath}: ${byId.size} matches with no pagination in the response — ` +
        'probing for a paging convention',
    );
    const walked = await this.discoverPaging(firstPath, byId, add);
    if (!walked) {
      console.warn(
        `[big-balls] ${firstPath}: no paging convention found; ${byId.size} matches may be ` +
          'a truncated page. Run the tournament diagnostic and check the response envelope.',
      );
    }

    return [...byId.values()];
  }

  /**
   * Work out how this API pages, by trying.
   *
   * The documentation shows one match object and never a whole response, so the paging
   * convention is unknown — and three rounds of guessing at it is three rounds of a
   * season quietly arriving one page short. So rather than assume, each candidate is
   * sent and judged by its answer: a parameter that yields matches we do not already
   * hold is the right one, and anything else (an error, an ignored parameter, the same
   * page again) is not. Costs a handful of requests, once, only when a response looked
   * truncated.
   *
   * Returns true if it found a convention and walked it to the end.
   */
  private async discoverPaging(
    basePath: string,
    byId: Map<string, RawMatch>,
    add: (matches: RawMatch[]) => number,
  ): Promise<boolean> {
    const pageSize = byId.size;

    /** Fetch one candidate, tolerating the rejection an unknown parameter may draw. */
    const tryPath = async (path: string): Promise<RawMatch[] | null> => {
      try {
        return BigBallsProvider.matchesFrom(await this.get<unknown>(path), path);
      } catch (err) {
        if (err instanceof ProviderError) return null;
        throw err;
      }
    };

    const withParam = (name: string, value: string | number): string => {
      const url = new URL(basePath, 'https://x');
      url.searchParams.set(name, String(value));
      return `${url.pathname}?${url.searchParams}`;
    };

    // 1. A bigger page. The cheapest fix by far when it works: one request, no walking.
    for (const name of LIMIT_PARAMS) {
      const matches = await tryPath(withParam(name, PROBE_PAGE_SIZE));
      if (matches !== null && matches.length > pageSize) {
        add(matches);
        console.warn(`[big-balls] paging by "${name}": ${byId.size} matches`);
        // A response that filled the bigger page may still be short of the whole season.
        if (matches.length >= PROBE_PAGE_SIZE) {
          await this.walk(basePath, byId, add, n => withParam(name, PROBE_PAGE_SIZE) + `&offset=${n}`);
        }
        return true;
      }
    }

    // 2. Page numbers, then offsets. Judged the same way: does page two hold anything
    //    page one did not?
    for (const name of PAGE_PARAMS) {
      const matches = await tryPath(withParam(name, 2));
      if (matches !== null && add(matches) > 0) {
        console.warn(`[big-balls] paging by "${name}": walking from page 3`);
        await this.walk(basePath, byId, add, (_n, page) => withParam(name, page + 1));
        return true;
      }
    }

    for (const name of OFFSET_PARAMS) {
      const matches = await tryPath(withParam(name, pageSize));
      if (matches !== null && add(matches) > 0) {
        console.warn(`[big-balls] paging by "${name}": walking from offset ${byId.size}`);
        await this.walk(basePath, byId, add, n => withParam(name, n));
        return true;
      }
    }

    return false;
  }

  /** Keep requesting until a page adds nothing new, or the cap trips. */
  private async walk(
    basePath: string,
    byId: Map<string, RawMatch>,
    add: (matches: RawMatch[]) => number,
    pathFor: (fetched: number, page: number) => string,
  ): Promise<void> {
    for (let page = 2; page < MAX_PAGES; page++) {
      const path = pathFor(byId.size, page);
      let matches: RawMatch[];
      try {
        matches = BigBallsProvider.matchesFrom(await this.get<unknown>(path), path);
      } catch (err) {
        if (err instanceof ProviderError) return;
        throw err;
      }
      // Nothing new means the end, whether the provider says so or just repeats itself.
      if (add(matches) === 0) return;
    }
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
   * Fetch a season's fixtures, or a window of them.
   *
   * bigballsdata's match list is keyed by league and date rather than by season the way
   * football-data's is, so a whole season is asked for as an explicit date range. That
   * range is deliberate rather than left to the endpoint's default: a "live + scheduled
   * fixtures" list may well answer with only the near-term matches, and a season that
   * quietly arrives two-thirds short is the failure this adapter exists to avoid.
   *
   * A European season starting in year N runs to the summer of N+1, so the range is
   * generous on both ends — asking for more days than exist costs nothing.
   */
  async fetchFixtures(
    competitionId: string,
    season: string,
    opts: FetchFixturesOptions = {},
  ): Promise<ProviderFixture[]> {
    const window: FetchFixturesOptions =
      opts.dateFrom || opts.dateTo ? opts : seasonDateRange(season);

    return (await this.fetchAllMatches(this.matchesPath(competitionId, window))).map(
      mapBigBallsMatch,
    );
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
      return {
        key,
        url: `${BASE_URL}${path}`,
        status: 200,
        ok: true,
        count,
        countForSeason,
        detail,
        rawSample: trimmedSample(body),
      };
    } catch (err) {
      return {
        key,
        url: `${BASE_URL}${path}`,
        status: err instanceof ProviderError ? err.status : null,
        ok: false,
        count: null,
        countForSeason: null,
        detail: err instanceof Error ? err.message : String(err),
        rawSample: null,
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
        const total = BigBallsProvider.totalFrom(body);
        const dated = matches.filter(m => !!m.kickoff_utc).length;
        const named = matches.filter(m => m.home?.name && m.away?.name).length;

        // The three things that turn a full season into a short one, each named so the
        // admin can tell them apart instead of guessing at a small number.
        const notes = [
          `${matches.length} on this page${total !== null ? ` of ${total} reported` : ''}`,
          `${dated} with a kickoff time`,
          `${named} with both teams named`,
          `envelope: ${Array.isArray(body) ? 'bare array' : Object.keys(object(body)).join(', ') || 'none'}`,
          `next page: ${BigBallsProvider.nextPagePath(body, matchesPath, matches.length) ?? 'none offered'}`,
        ];
        if (BigBallsProvider.looksTruncated(matches.length, total)) {
          notes.push('⚠ this looks like a truncated page, not the whole season');
        }
        const rounds = countRounds(matches);
        if (rounds.length > 0) {
          notes.push(`rounds by date: ${rounds.map(r => `${r.date}×${r.count}`).join(', ')}`);
        }

        return {
          count: matches.length,
          countForSeason: matches.length,
          detail: matches.length === 0 ? 'the response carried no matches at all' : notes.join(' · '),
        };
      }),
    ];
  }
}
