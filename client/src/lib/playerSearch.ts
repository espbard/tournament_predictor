/**
 * Finding a football player by name, for the bonus-question picker.
 *
 * TheSportsDB's player search matches from the *start* of a player's full name. "Andreas H"
 * finds Andreas Helmersen; "Helmersen" finds nobody at all. Since almost everybody searches
 * by surname, that endpoint on its own makes the picker look broken.
 *
 * So a search has two legs:
 *
 *   * TheSportsDB directly. This is the good answer whenever the query happens to start the
 *     name, because it carries the club that tells two players of one name apart.
 *   * Wikipedia's article search. It matches a word anywhere in a title, which is exactly
 *     what a surname needs, and its hits are full names — a player TheSportsDB could not
 *     find from "Helmersen" it finds at once from "Andreas Helmersen". A player Wikipedia
 *     knows and TheSportsDB does not is still offered, since everybody spelling one player's
 *     name the same way is what the picker is for, and a name alone does that.
 *
 * ── Being quick about it ──────────────────────────────────────────────────────
 *
 * Three requests deep, against two free services, is far too slow to wait on in silence, so
 * nothing here is waited on in silence:
 *
 *   * both legs go out at once and every one of them reports as it lands, through
 *     `onResults` — Wikipedia usually answers first, so names are on screen long before
 *     TheSportsDB has said anything;
 *   * each leg's answer is cached on its own, so the last letters of a name that has already
 *     been searched cost nothing at all, not even the lookups behind it;
 *   * `narrowCachedPlayers` answers the next keystroke from what is already on screen, with
 *     no network whatsoever, while the real search runs behind it;
 *   * a leg that stops answering is dropped after LEG_TIMEOUT_MS rather than holding up
 *     what the other one found.
 */

export interface PlayerOption {
  /** Stable key for React, and how two hits for one player are told apart. */
  id: string;
  name: string;
  team: string | null;
  thumb: string | null;
}

/** Below this, a query matches so much that the suggestions are noise. */
export const PLAYER_SEARCH_MIN_LENGTH = 2;

/** How many suggestions the picker is offered. Sized to scroll, not to overwhelm. */
const MAX_RESULTS = 10;

/** Direct hits at or above this count are taken as answer enough; Wikipedia stays out of it. */
const DIRECT_HITS_ENOUGH = 5;

/** Wikipedia names looked up in TheSportsDB. Each one is a request, so: few. */
const MAX_NAME_LOOKUPS = 3;

/** How long one database gets before the search goes on without it. */
const LEG_TIMEOUT_MS = 6_000;

const SPORTSDB_ORIGIN = 'https://www.thesportsdb.com';
const SPORTSDB_SEARCH = `${SPORTSDB_ORIGIN}/api/v1/json/3/searchplayers.php`;
const WIKIPEDIA_ORIGIN = 'https://en.wikipedia.org';
const WIKIPEDIA_API = `${WIKIPEDIA_ORIGIN}/w/api.php`;

/**
 * Fold a name for comparison: accents dropped, punctuation dropped, case and spacing
 * normalised, so "Kylian Mbappé" and "kylian mbappe" are one person.
 *
 * The same folding as the server's normaliseLivePlayerName, and for the same reason — a
 * person's name has no noise words to strip, so nothing is stripped but accents.
 */
export function foldPlayerName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Talking to the two databases ──────────────────────────────────────────────

/**
 * A signal that gives up on its own.
 *
 * One database being slow must not cost what the other one already found, and a request
 * nobody ever answers must not leave the field spinning for good.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const stop = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  };
  function onOuterAbort() {
    controller.abort();
  }
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onOuterAbort);
  controller.signal.addEventListener('abort', stop);
  return controller.signal;
}

interface SportsDbPlayer {
  idPlayer: string;
  strPlayer: string;
  strTeam: string | null;
  strSport: string | null;
  strThumb: string | null;
}

// Every answer either database has already given, kept for the session. Typing a name,
// backspacing and typing it again is the normal way to use this field, and the tail of a
// name is searched over and over as it is typed — none of that is worth a second request.
const sportsDbCache = new Map<string, PlayerOption[]>();
const wikipediaCache = new Map<string, WikipediaHit[]>();
const searchCache = new Map<string, PlayerOption[]>();

/** Test seam, and a way out if a search is ever cached while a database was misbehaving. */
export function clearPlayerSearchCache(): void {
  sportsDbCache.clear();
  wikipediaCache.clear();
  searchCache.clear();
}

/** One search of TheSportsDB, kept to footballers. */
async function searchSportsDb(term: string, signal?: AbortSignal): Promise<PlayerOption[]> {
  const key = foldPlayerName(term);
  const cached = sportsDbCache.get(key);
  if (cached) return cached;

  const res = await fetch(`${SPORTSDB_SEARCH}?p=${encodeURIComponent(term)}`, {
    signal: withTimeout(signal, LEG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TheSportsDB responded ${res.status}`);
  const data: { player?: SportsDbPlayer[] | null } = await res.json();
  const players = (data.player ?? [])
    .filter(p => !p.strSport || p.strSport === 'Soccer')
    .map(p => ({
      id: p.idPlayer,
      name: p.strPlayer,
      team: p.strTeam || null,
      thumb: p.strThumb || null,
    }));

  sportsDbCache.set(key, players);
  return players;
}

/**
 * A Wikipedia short description that belongs to a footballer.
 *
 * The description is what keeps a surname page ("Helmersen", a list of people) and a club
 * out of the suggestions: only an article describing a person who plays football gets in.
 */
const FOOTBALLER_DESCRIPTION =
  /(footballer|football (player|forward|midfielder|defender|winger|striker|goalkeeper)|soccer player|association football player)/i;

interface WikipediaPage {
  pageid: number;
  title: string;
  description?: string;
  index?: number;
  thumbnail?: { source?: string };
}

interface WikipediaHit {
  name: string;
  thumb: string | null;
}

/**
 * Footballers whose article title contains every word typed.
 *
 * `intitle:` is the whole point: it matches a word anywhere in the title, so a surname
 * finds the player. A part-word — the "h" of "Andreas H" — would match nothing, so short
 * tokens are left out of the query rather than allowed to empty it.
 *
 * The article's picture is asked for in the same breath, so a suggestion has a face from the
 * moment it appears rather than a second later, when TheSportsDB gets round to answering.
 */
async function searchWikipedia(query: string, signal?: AbortSignal): Promise<WikipediaHit[]> {
  const tokens = query
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter(t => t.length >= 3);
  if (tokens.length === 0) return [];

  const key = foldPlayerName(tokens.join(' '));
  const cached = wikipediaCache.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `${tokens.map(t => `intitle:${t}`).join(' ')} football`,
    gsrnamespace: '0',
    gsrlimit: '8',
    prop: 'description|pageimages',
    piprop: 'thumbnail',
    pithumbsize: '80',
    pilimit: '10',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });

  const res = await fetch(`${WIKIPEDIA_API}?${params.toString()}`, {
    signal: withTimeout(signal, LEG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wikipedia responded ${res.status}`);
  const data: { query?: { pages?: WikipediaPage[] } } = await res.json();

  const hits = (data.query?.pages ?? [])
    .filter(page => FOOTBALLER_DESCRIPTION.test(page.description ?? ''))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(page => ({
      // "Andreas Helmersen (footballer, born 1999)" is stored as the name he is known by.
      name: page.title.replace(/\s*\([^)]*\)\s*$/, '').trim(),
      thumb: page.thumbnail?.source ?? null,
    }))
    .filter(hit => hit.name.length > 0);

  wikipediaCache.set(key, hits);
  return hits;
}

// ── Putting the two together ──────────────────────────────────────────────────

/**
 * Where a suggestion sorts: the closer the query is to the front of a name, the higher.
 *
 * A surname match must rank above a stray one, because the surname is what was typed.
 */
function matchRank(name: string, needle: string): number {
  const folded = foldPlayerName(name);
  if (folded === needle) return 0;
  if (folded.startsWith(needle)) return 1;
  if (folded.split(' ').some(word => word.startsWith(needle))) return 2;
  if (folded.includes(needle)) return 3;
  return 4;
}

function mergeOptions(groups: PlayerOption[][], needle: string): PlayerOption[] {
  const byName = new Map<string, PlayerOption>();
  for (const option of groups.flat()) {
    const key = foldPlayerName(option.name);
    if (key === '') continue;
    const existing = byName.get(key);
    // One player found twice keeps the richer record — the one that can show a club and a
    // face rather than a bare name. This is also how a row already on screen picks up its
    // club when the slow database finally answers.
    if (!existing || (!existing.thumb && option.thumb) || (!existing.team && option.team)) {
      byName.set(key, {
        // The row keeps the identity it first appeared with, so a club arriving late
        // fills the row in rather than replacing it under the cursor.
        id: existing?.id ?? option.id,
        name: existing?.name ?? option.name,
        team: option.team ?? existing?.team ?? null,
        thumb: option.thumb ?? existing?.thumb ?? null,
      });
    }
  }

  return [...byName.values()]
    .sort((a, b) => {
      const rankDiff = matchRank(a.name, needle) - matchRank(b.name, needle);
      if (rankDiff !== 0) return rankDiff;
      const aRich = a.team ? 0 : 1;
      const bRich = b.team ? 0 : 1;
      if (aRich !== bRich) return aRich - bRich;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_RESULTS);
}

/** The suggestions in a list that still match what has been typed since. */
export function filterPlayersByQuery(options: PlayerOption[], query: string): PlayerOption[] {
  const needle = foldPlayerName(query);
  if (needle === '') return [];
  return options.filter(option => matchRank(option.name, needle) <= 3);
}

/**
 * What can be shown for a query *right now*, without asking anybody.
 *
 * Typing "helmersen" one letter at a time is nine searches of the same person, and the eight
 * shorter ones already know the answer. Their results, narrowed to the ones still matching,
 * go on screen the instant a key is pressed — the real search then confirms or extends them
 * a moment later.
 *
 * A cached search covers this one when its text appears inside it, which is what makes both
 * ways of typing a name work: adding letters to "Helmerse", and putting "Andreas" in front
 * of "Helmersen". Every name that matches the longer text matched the shorter one too.
 *
 * Null when nothing searched so far covers the query, which is the caller's cue to narrow
 * whatever it has on screen instead.
 */
export function narrowCachedPlayers(query: string): PlayerOption[] | null {
  const needle = foldPlayerName(query);
  if (needle === '') return null;

  const exact = searchCache.get(needle);
  if (exact) return exact;

  // The longest one, because it is the one that has already thrown the most away.
  let best: PlayerOption[] | null = null;
  let bestLength = 0;
  for (const [cachedNeedle, options] of searchCache) {
    if (cachedNeedle.length <= bestLength || !needle.includes(cachedNeedle)) continue;
    best = options;
    bestLength = cachedNeedle.length;
  }
  if (!best) return null;

  const narrowed = filterPlayersByQuery(best, needle);
  return narrowed.length > 0 ? narrowed : null;
}

interface SearchOptions {
  signal?: AbortSignal;
  /**
   * Called with the best answer so far, every time one of the databases reports.
   *
   * Always in improving order — a later call never has less in it than an earlier one —
   * so it can be dropped straight into state.
   */
  onResults?: (options: PlayerOption[]) => void;
}

/**
 * Run one leg of a search, letting it fail without taking the other leg down with it.
 *
 * Only the caller's own signal counts as abandonment. A leg that timed out was aborted too,
 * but that is this module's doing, not the user's, and it means "carry on without me"
 * rather than "the field has moved on".
 */
async function attempt<T>(
  run: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<{ value: T | null; failed: boolean }> {
  try {
    return { value: await run(), failed: false };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { value: null, failed: true };
  }
}

/**
 * Suggestions for a typed name, best match first.
 *
 * Resolves with the finished list, and reports every better version of it through
 * `onResults` on the way — the first of those normally arrives in a fraction of the time the
 * last one does. Throws only when *nothing* could be reached; a search that found something
 * never fails.
 */
export async function searchPlayers(
  query: string,
  { signal, onResults }: SearchOptions = {},
): Promise<PlayerOption[]> {
  const term = query.trim();
  const needle = foldPlayerName(term);
  if (term.length < PLAYER_SEARCH_MIN_LENGTH || needle === '') return [];

  const cached = searchCache.get(needle);
  if (cached) {
    onResults?.(cached);
    return cached;
  }

  const groups: PlayerOption[][] = [];
  let latest: PlayerOption[] = [];
  function emit(found: PlayerOption[]): void {
    if (found.length === 0) return;
    groups.push(found);
    latest = mergeOptions(groups, needle);
    if (!signal?.aborted) onResults?.(latest);
  }

  // Looking one of Wikipedia's names up in TheSportsDB, for the club a title does not carry.
  // Each name is asked about once, however many times it comes up.
  const lookedUp = new Set<string>();
  function lookUp(names: string[]): Promise<unknown> {
    const fresh = names
      .filter(name => !lookedUp.has(foldPlayerName(name)))
      // MAX_NAME_LOOKUPS is the budget for the whole search, not for one batch of it.
      .slice(0, MAX_NAME_LOOKUPS - lookedUp.size);
    for (const name of fresh) lookedUp.add(foldPlayerName(name));
    return Promise.all(
      fresh.map(async name => {
        const found = await attempt(() => searchSportsDb(name, signal), signal);
        // TheSportsDB not answering is no reason to drop a name Wikipedia is sure of — the
        // name is already on screen, and this only ever adds to it.
        emit((found.value ?? []).filter(p => foldPlayerName(p.name) === foldPlayerName(name)));
      }),
    );
  }

  // Both legs at once, each reporting the moment it lands. Wikipedia is usually the quicker
  // of the two, which is what puts names on screen while TheSportsDB is still thinking.
  const directLeg = attempt(() => searchSportsDb(term, signal), signal).then(leg => {
    emit(leg.value ?? []);
    return leg;
  });
  let eager: Promise<unknown> = Promise.resolve();
  const wikipediaLeg = attempt(() => searchWikipedia(term, signal), signal).then(leg => {
    const hits = (leg.value ?? []).filter(hit => matchRank(hit.name, needle) <= 3);
    // A bare name is worth showing at once; the club it is missing arrives later.
    emit(hits.map(hit => ({ id: `name:${hit.name}`, name: hit.name, team: null, thumb: hit.thumb })));
    // A name the direct search cannot possibly return — because that search matches from the
    // *start* of a name, and this one does not start with what was typed — is looked up
    // straight away rather than after the slow leg has finished not finding it. That is a
    // second or more off the wait for a club on the surname searches, and costs no request
    // the search was not going to make anyway.
    eager = lookUp(
      hits.filter(hit => !foldPlayerName(hit.name).startsWith(needle)).map(hit => hit.name),
    );
    return leg;
  });

  const [direct, wikipedia] = await Promise.all([directLeg, wikipediaLeg]);
  const directHits = direct.value ?? [];
  // A direct search that already fills the list is answer enough; its hits carry a club,
  // which an article title does not.
  const hits = directHits.length < DIRECT_HITS_ENOUGH ? (wikipedia.value ?? []) : [];

  // Names already among the direct hits are not worth a second request. Nor are names the
  // typed text does not actually appear in: a short word is dropped from the Wikipedia
  // query rather than allowed to match nothing, so "Andreas H" is searched as "Andreas"
  // and would otherwise drag in every other Andreas who ever played.
  const known = new Set(directHits.map(p => foldPlayerName(p.name)));
  const wanted = hits
    .filter(hit => !known.has(foldPlayerName(hit.name)) && matchRank(hit.name, needle) <= 3)
    .map(hit => hit.name);

  await Promise.all([eager, lookUp(wanted)]);

  // Nothing to show *and* a database that did not answer is an outage, not an empty result,
  // and the two are worth telling apart on screen.
  if (direct.failed && (wikipedia.value ?? []).length === 0) {
    throw new Error('No player database could be reached');
  }

  // A search half of which never happened is not an answer worth remembering.
  if (!direct.failed && !wikipedia.failed) searchCache.set(needle, latest);
  return latest;
}

/**
 * Open the connections to both databases before there is anything to send down them.
 *
 * Called when somebody puts the cursor in a player field, which is a second or two before
 * they have typed enough to search: by then the handshakes are done and the first search is
 * a round trip rather than three. Costs nothing for anyone who never opens such a question.
 */
export function warmPlayerSearch(): void {
  if (typeof document === 'undefined') return;
  for (const origin of [SPORTSDB_ORIGIN, WIKIPEDIA_ORIGIN]) {
    if (document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }
}

export function isAborted(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
