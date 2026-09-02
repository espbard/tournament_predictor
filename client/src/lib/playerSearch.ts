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
 *     name, because it carries the club and the photo that make a suggestion recognisable.
 *   * Wikipedia's article search when the first leg comes back thin. It matches a word
 *     anywhere in a title, which is exactly what a surname needs, and its hits are full
 *     names — a player TheSportsDB could not find from "Helmersen" it finds at once from
 *     "Andreas Helmersen". A player Wikipedia knows and TheSportsDB does not is still
 *     offered, with no club or photo: everybody spelling one player's name the same way is
 *     what the picker is for, and a name alone does that.
 *
 * Both legs are asked at once — waiting on the first would put a whole round trip between a
 * keystroke and a suggestion — but the second leg's names are only looked up when the first
 * has not already filled the list. Every answer is cached for the session.
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

const SPORTSDB_SEARCH = 'https://www.thesportsdb.com/api/v1/json/3/searchplayers.php';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

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

interface SportsDbPlayer {
  idPlayer: string;
  strPlayer: string;
  strTeam: string | null;
  strSport: string | null;
  strThumb: string | null;
}

/** One search of TheSportsDB, kept to footballers. */
async function searchSportsDb(term: string, signal?: AbortSignal): Promise<PlayerOption[]> {
  const res = await fetch(`${SPORTSDB_SEARCH}?p=${encodeURIComponent(term)}`, { signal });
  if (!res.ok) throw new Error(`TheSportsDB responded ${res.status}`);
  const data: { player?: SportsDbPlayer[] | null } = await res.json();
  return (data.player ?? [])
    .filter(p => !p.strSport || p.strSport === 'Soccer')
    .map(p => ({
      id: p.idPlayer,
      name: p.strPlayer,
      team: p.strTeam || null,
      thumb: p.strThumb || null,
    }));
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
}

/**
 * Full names of footballers whose article title contains every word typed.
 *
 * `intitle:` is the whole point: it matches a word anywhere in the title, so a surname
 * finds the player. A part-word — the "h" of "Andreas H" — would match nothing, so short
 * tokens are left out of the query rather than allowed to empty it.
 */
async function searchWikipediaNames(query: string, signal?: AbortSignal): Promise<string[]> {
  const tokens = query
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter(t => t.length >= 3);
  if (tokens.length === 0) return [];

  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `${tokens.map(t => `intitle:${t}`).join(' ')} football`,
    gsrnamespace: '0',
    gsrlimit: '8',
    prop: 'description',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });

  const res = await fetch(`${WIKIPEDIA_API}?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Wikipedia responded ${res.status}`);
  const data: { query?: { pages?: WikipediaPage[] } } = await res.json();

  return (data.query?.pages ?? [])
    .filter(page => FOOTBALLER_DESCRIPTION.test(page.description ?? ''))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    // "Andreas Helmersen (footballer, born 1999)" is stored as the name he is known by.
    .map(page => page.title.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter(name => name.length > 0);
}

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
    // face rather than a bare name.
    if (!existing || (!existing.thumb && option.thumb) || (!existing.team && option.team)) {
      byName.set(key, option);
    }
  }

  return [...byName.values()]
    .sort((a, b) => {
      const rankDiff = matchRank(a.name, needle) - matchRank(b.name, needle);
      if (rankDiff !== 0) return rankDiff;
      const aRich = a.team || a.thumb ? 0 : 1;
      const bRich = b.team || b.thumb ? 0 : 1;
      if (aRich !== bRich) return aRich - bRich;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_RESULTS);
}

// A session-lived cache. Typing a name, backspacing and typing it again is the normal way
// to use this field, and neither database needs to be asked twice for the same word.
const cache = new Map<string, PlayerOption[]>();

/** Test seam, and a way out if a search is ever cached while a database was misbehaving. */
export function clearPlayerSearchCache(): void {
  cache.clear();
}

/** Run one leg of a search, letting it fail without taking the other leg down with it. */
async function attempt<T>(run: () => Promise<T>): Promise<{ value: T | null; failed: boolean }> {
  try {
    return { value: await run(), failed: false };
  } catch (err) {
    // An abandoned search is not a failed one — the field has simply moved on.
    if (isAborted(err)) throw err;
    return { value: null, failed: true };
  }
}

/**
 * Suggestions for a typed name, best match first.
 *
 * Throws only when *nothing* could be reached — a Wikipedia that is down costs the surname
 * leg and no more, and a search that found something never fails.
 */
export async function searchPlayers(query: string, signal?: AbortSignal): Promise<PlayerOption[]> {
  const term = query.trim();
  const needle = foldPlayerName(term);
  if (term.length < PLAYER_SEARCH_MIN_LENGTH || needle === '') return [];

  const cached = cache.get(needle);
  if (cached) return cached;

  // Both legs at once. The surname leg is the slow one and the one that usually matters,
  // and waiting to see whether the first leg needed help would put a whole round trip
  // between a keystroke and a suggestion.
  const [directLeg, namesLeg] = await Promise.all([
    attempt(() => searchSportsDb(term, signal)),
    attempt(() => searchWikipediaNames(term, signal)),
  ]);
  const direct = directLeg.value ?? [];
  const directFailed = directLeg.failed;
  // A direct search that already fills the list is answer enough; its hits carry a club and
  // a face, which a bare article title does not.
  const names = direct.length < DIRECT_HITS_ENOUGH ? (namesLeg.value ?? []) : [];
  const namesFailed = namesLeg.failed;

  // Names already among the direct hits are not worth a second request. Nor are names the
  // typed text does not actually appear in: a short word is dropped from the Wikipedia
  // query rather than allowed to match nothing, so "Andreas H" is searched as "Andreas"
  // and would otherwise drag in every other Andreas who ever played.
  const known = new Set(direct.map(p => foldPlayerName(p.name)));
  const wanted = names
    .filter(name => !known.has(foldPlayerName(name)) && matchRank(name, needle) <= 3)
    .slice(0, MAX_NAME_LOOKUPS);

  const looked = await Promise.all(
    wanted.map(async (name): Promise<PlayerOption[]> => {
      const fallback: PlayerOption[] = [{ id: `name:${name}`, name, team: null, thumb: null }];
      try {
        const hits = await searchSportsDb(name, signal);
        const exact = hits.filter(p => foldPlayerName(p.name) === foldPlayerName(name));
        return exact.length > 0 ? exact : fallback;
      } catch (err) {
        if (isAborted(err)) throw err;
        // TheSportsDB not answering is no reason to drop a name Wikipedia is sure of.
        return fallback;
      }
    }),
  );

  // Nothing to show *and* a database that did not answer is an outage, not an empty result,
  // and the two are worth telling apart on screen.
  if (directFailed && names.length === 0) throw new Error('No player database could be reached');

  const merged = mergeOptions([direct, ...looked], needle);
  // A search half of which never happened is not an answer worth remembering.
  if (!directFailed && !namesFailed) cache.set(needle, merged);
  return merged;
}

export function isAborted(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
