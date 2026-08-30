// ── Matching a team across providers ──────────────────────────────────────────
//
// Two providers do not agree on team ids, and one of them (bigballsdata) does not
// publish ids at all — a match names its teams and nothing more. So when fixtures come
// from a different provider than the teams, a fixture's team has to be found by name.
//
// This is the part of the two-provider setup that can go quietly wrong. Attaching a
// fixture to the wrong club would put real predictions against the wrong match, so the
// rule here is the same one the rest of the live code follows: match on strong evidence
// or not at all. An unmatched fixture is stored with no team link and reported to the
// admin, which is visible and recoverable; a mismatch is neither.
//
// Everything here is pure, and every rule below is pinned in teamMatching.test.ts.

/** A stored team to match against. */
export interface MatchableTeam {
  id: string;
  name: string;
  shortName: string | null;
  tla: string | null;
}

/** The names a provider gave us for one side of a fixture. */
export interface TeamNameHints {
  name: string | null;
  shortName?: string | null;
  tla?: string | null;
}

/**
 * Club-type words and league decorations that carry no identity.
 *
 * "FC Barcelona", "Barcelona FC" and "Barcelona" are one club; so are "BSC Young Boys"
 * and "Young Boys". Dropping these is what makes the comparison work across providers
 * that each pick a different convention.
 */
const NOISE_WORDS = new Set([
  'fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ss', 'ssc', 'sv', 'bsc', 'vfb', 'vfl', 'tsg',
  'fsv', 'bv', 'sk', 'ik', 'if', 'bk', 'cd', 'ud', 'rc', 'rcd', 'sd', 'ca', 'sl', 'cp',
  'club', 'clube', 'calcio', 'futbol', 'football', 'fussball', 'fotball', 'balompie',
  'de', 'do', 'da', 'del', 'della', 'di', 'du', 'the',
]);

// Deliberately NOT noise: "Atlético", "Athletic" and "Sporting" look like club-type words
// but are the identifying half of the name. Stripping "Atlético" from "Atlético Madrid"
// leaves "madrid", which any Madrid club could then claim.

/**
 * Strip a name to the letters that identify the club.
 *
 * Accents are folded (Bayern München → bayern munchen), punctuation dropped, digits
 * dropped (1899 Hoffenheim → hoffenheim), and the noise words above removed. What is
 * left is compared verbatim: this normalises spelling conventions, it does not do fuzzy
 * matching, because "close enough" is exactly how the wrong club gets picked.
 */
export function normaliseTeamName(raw: string | null | undefined): string {
  if (!raw) return '';

  const folded = raw
    .normalize('NFD')
    // Combining marks, so é → e. Letters that are not a base plus a mark (ø, æ, ß)
    // survive NFD untouched and are replaced individually below.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const words = folded.split(' ').filter(w => w !== '' && !/^\d+$/.test(w) && !NOISE_WORDS.has(w));

  // A name made entirely of noise ("Sporting CP") must not normalise to nothing, or every
  // such club would match every other. Fall back to the name without its punctuation.
  if (words.length === 0) return folded.replace(/\s+/g, '');

  return words.join('');
}

/**
 * Aliases no amount of normalising will bridge, because the two names share no words.
 *
 * Keyed by normalised form, mapping to the normalised form used elsewhere. Kept
 * deliberately short: every entry is a claim that two different names are the same club,
 * and a wrong one is a silent mismatch. Add only what a real payload has shown.
 *
 * Both sides fold through this table — the stored names when the index is built, the
 * incoming names when one is looked up — so an entry must name a token both sides can
 * reach rather than one provider's spelling. Hence rbsalzburg → salzburg *and*
 * redbullsalzburg → salzburg, rather than one mapping onto the other.
 */
const ALIASES = new Map<string, string>([
  // Inter: "FC Internazionale Milano" one side, "Inter" or "Inter Milan" the other.
  ['internazionale', 'inter'],
  ['internazionalemilano', 'inter'],
  ['intermilan', 'inter'],
  // Manchester clubs, where the abbreviations are not interchangeable.
  ['manutd', 'manchesterunited'],
  ['manunited', 'manchesterunited'],
  ['mancity', 'manchestercity'],
  // Spurs.
  ['tottenham', 'tottenhamhotspur'],
  ['spurs', 'tottenhamhotspur'],
  // Paris.
  ['psg', 'parissaintgermain'],
  ['parissg', 'parissaintgermain'],
  // Bayern: München / Munich / Munchen.
  ['bayern', 'bayernmunchen'],
  ['bayernmunich', 'bayernmunchen'],
  // Dortmund.
  ['borussiadortmund', 'dortmund'],
  ['bvb', 'dortmund'],
  // Red Bull sides, abbreviated differently by nearly everyone.
  ['rbsalzburg', 'salzburg'],
  ['redbullsalzburg', 'salzburg'],
  ['fcsalzburg', 'salzburg'],
  ['rbleipzig', 'leipzig'],
  ['redbullleipzig', 'leipzig'],
  // Greek and Ukrainian sides with several romanisations.
  ['olympiakos', 'olympiacos'],
  ['olympiacospiraeus', 'olympiacos'],
  ['olympiakospiraeus', 'olympiacos'],
  ['shakhtardonetsk', 'shakhtar'],
  // Sporting CP, whose full name shares no word with the way most providers write it.
  ['sportingcp', 'sporting'],
  ['sportinglisbon', 'sporting'],
  ['sportingportugal', 'sporting'],
  ['sportingclubedeportugal', 'sporting'],
]);

/** Normalise, then fold through the alias table. */
export function canonicalTeamName(raw: string | null | undefined): string {
  const normalised = normaliseTeamName(raw);
  return ALIASES.get(normalised) ?? normalised;
}

/**
 * Build a lookup from every name a stored team is known by to its id.
 *
 * A name claimed by two different teams is dropped from the index rather than resolved
 * arbitrarily: an ambiguous key must not match anything. That matters most for `tla`,
 * where three letters collide readily.
 */
export function buildTeamNameIndex(teams: MatchableTeam[]): Map<string, string> {
  const counts = new Map<string, Set<string>>();

  for (const team of teams) {
    for (const raw of [team.name, team.shortName, team.tla]) {
      const key = canonicalTeamName(raw);
      if (key === '') continue;
      const owners = counts.get(key);
      if (owners) owners.add(team.id);
      else counts.set(key, new Set([team.id]));
    }
  }

  const index = new Map<string, string>();
  for (const [key, owners] of counts) {
    if (owners.size === 1) index.set(key, [...owners][0]);
  }
  return index;
}

/**
 * Find the stored team a provider's fixture is talking about, or null.
 *
 * The full name is tried first, then the short name, then the three-letter code — most
 * to least specific, so a distinctive full name is never passed over in favour of an
 * abbreviation that happens to collide.
 */
export function matchTeamByName(
  hints: TeamNameHints,
  index: Map<string, string>,
): string | null {
  for (const raw of [hints.name, hints.shortName, hints.tla]) {
    const key = canonicalTeamName(raw);
    if (key === '') continue;
    const id = index.get(key);
    if (id) return id;
  }
  return null;
}
