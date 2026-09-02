import { and, eq, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client';
import { livePlayers, liveTeams, liveTournaments } from '../db/liveSchema';
import type { LiveScorerNationalities } from '@tournament-predictor/shared';
import { getProvider } from './providers';
import {
  ProviderError,
  SCORER_FEED_LIMIT,
  type ProviderScorer,
  type ProviderSquadPlayer,
} from './providers/types';

// ── The player list ───────────────────────────────────────────────────────────
//
// Where the players an admin can shortlist come from, and where their goals come from.
//
// The shortlist is built by searching: an admin types a name, the provider's squads are
// searched for it, and the player they pick becomes one row. Nothing else is stored — the
// competition's other ~880 players are never written down, because nobody is going to rank
// them and a table full of them is only in the way.
//
// Two different provider endpoints, because one of them alone is not enough:
//
//   * the **squads** on `/competitions/{id}/teams` are the roster — every player at every
//     club, whether or not they have kicked a ball. This is what a shortlist is picked
//     from, and before a competition starts it is the only source with anything in it;
//   * the **scorers** list is goals and assists, and by its nature contains only players
//     who have already scored. It is empty in August and useless for building a list.
//
// So an import does both: squads for who exists, scorers for what they have done. They
// meet on `providerPlayerId`, which football-data keeps stable across seasons and
// endpoints. Either half can fail on its own without costing the other.
//
// The admin is the source of truth where the provider has nothing — which is the whole
// reason `live_players.provider_player_id` is nullable.
//
// Two rules keep those two sources from fighting:
//
//   * a row carrying a provider id is refreshed from the provider, and nothing else is;
//   * a hand-added row is adopted — given that id — only on an unambiguous name match,
//     after which it too is kept up to date. Its name, picture and shortlist membership
//     stay as the admin left them: those are curation, not data.
//
// The admin's own edits therefore survive every sync until the provider positively
// identifies the player they were describing.

/**
 * Fold a player's name for comparison: accents dropped, punctuation dropped, case and
 * spacing normalised. "Kylian Mbappé" and "kylian mbappe" are the same person.
 *
 * Deliberately *not* normaliseTeamName from teamMatching.ts. That one strips club-type
 * words, and its noise list contains "de" and "da" — which would turn De Bruyne into
 * "bruyne" and quietly make him collide with anyone else named Bruyne. A person's name
 * has no noise words to strip.
 */
export function normaliseLivePlayerName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    // Combining marks, so é → e. Letters that survive NFD whole are folded individually,
    // exactly as normaliseTeamName does — Ødegaard and Odegaard are one player.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Index hand-added players by folded name.
 *
 * A name claimed by two rows is dropped rather than resolved arbitrarily, exactly as
 * buildTeamNameIndex does: an ambiguous name must match nothing, because adopting the
 * wrong row would attach one player's goals to another.
 */
function indexByName(players: Array<{ id: string; name: string }>): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const player of players) {
    const key = normaliseLivePlayerName(player.name);
    if (key === '') continue;
    const set = owners.get(key);
    if (set) set.add(player.id);
    else owners.set(key, new Set([player.id]));
  }

  const index = new Map<string, string>();
  for (const [key, ids] of owners) {
    if (ids.size === 1) index.set(key, [...ids][0]);
  }
  return index;
}

// ── Searching the squads ──────────────────────────────────────────────────────
//
// A search must answer while somebody is typing, and the provider allows ten requests a
// minute, so the squads are fetched once and kept for a few minutes. One admin filling in
// a shortlist is then one provider request, not one per keystroke.
//
// Deliberately in memory rather than in a table: this is a lookup list, not data we own,
// and a restart losing it costs exactly one request.

const SQUAD_CACHE_TTL_MS = 10 * 60_000;

interface CachedSquad {
  players: ProviderSquadPlayer[];
  fetchedAt: number;
}

const squadCache = new Map<string, CachedSquad>();

/** Test seam, and the escape hatch for an admin who has just corrected a season. */
export function clearLiveSquadCache(): void {
  squadCache.clear();
}

async function loadSquads(
  tournamentId: string,
  season: string,
  fetcher: () => Promise<ProviderSquadPlayer[]>,
): Promise<ProviderSquadPlayer[]> {
  const key = `${tournamentId}#${season}`;
  const cached = squadCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SQUAD_CACHE_TTL_MS) return cached.players;

  const players = await fetcher();
  // An empty answer is cached too. A season the provider has not published yet would
  // otherwise be re-requested on every keystroke, which is precisely when the rate limit
  // is least affordable.
  squadCache.set(key, { players, fetchedAt: Date.now() });
  return players;
}

export interface LivePlayerSearchHit extends ProviderSquadPlayer {
  /** The club as this tournament stores it, when the team is one we know. */
  teamId: string | null;
  teamName: string | null;
  /** True when this player is already in the tournament's list. */
  alreadyAdded: boolean;
}

/** How many hits a search returns. Enough to disambiguate a surname, few enough to scan. */
const SEARCH_LIMIT = 25;

export interface LivePlayerSearchResult {
  /** False when the tournament's provider publishes no squads to search. */
  supported: boolean;
  /** The provider has not published this season yet — try the previous one. */
  seasonUnavailable: boolean;
  hits: LivePlayerSearchHit[];
}

/**
 * Find players in the competition's squads whose name matches `query`.
 *
 * Matching is on the folded name (accents dropped, case ignored), so "mbappe" finds
 * "Kylian Mbappé". A hit whose name *starts* with the query sorts above one that merely
 * contains it, which is what makes typing a surname feel like it works.
 */
export async function searchLivePlayers(
  tournamentId: string,
  query: string,
  season?: string,
): Promise<LivePlayerSearchResult> {
  const empty: LivePlayerSearchResult = { supported: false, seasonUnavailable: false, hits: [] };

  const [tournament] = await db
    .select()
    .from(liveTournaments)
    .where(eq(liveTournaments.id, tournamentId));
  if (!tournament) return empty;

  const provider = getProvider(tournament.provider);
  if (!provider.fetchSquads) return empty;

  const wantedSeason = season ?? tournament.season;
  let squads: ProviderSquadPlayer[];
  try {
    squads = await loadSquads(tournament.id, wantedSeason, () =>
      provider.fetchSquads!(tournament.providerCompetitionId, wantedSeason),
    );
  } catch (err) {
    if (err instanceof ProviderError && err.isSeasonUnavailable) {
      return { supported: true, seasonUnavailable: true, hits: [] };
    }
    throw err;
  }

  const needle = normaliseLivePlayerName(query);
  if (needle === '') return { supported: true, seasonUnavailable: false, hits: [] };

  const matched = matchSquadPlayers(squads, needle);

  const [teams, stored] = await Promise.all([
    db
      .select({ id: liveTeams.id, providerTeamId: liveTeams.providerTeamId, name: liveTeams.name })
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id)),
    db
      .select({ providerPlayerId: livePlayers.providerPlayerId })
      .from(livePlayers)
      .where(eq(livePlayers.liveTournamentId, tournament.id)),
  ]);
  const teamByProviderId = new Map(teams.map(t => [t.providerTeamId, t]));
  const addedIds = new Set(stored.map(p => p.providerPlayerId).filter(Boolean));

  return {
    supported: true,
    seasonUnavailable: false,
    hits: matched.map(player => {
      const team = player.providerTeamId ? teamByProviderId.get(player.providerTeamId) : undefined;
      return {
        ...player,
        teamId: team?.id ?? null,
        teamName: team?.name ?? null,
        alreadyAdded: addedIds.has(player.providerPlayerId),
      };
    }),
  };
}

/**
 * The matching itself, pure so it can be tested without a provider or a database.
 *
 * `needle` must already be folded — see normaliseLivePlayerName.
 */
export function matchSquadPlayers(
  squads: ProviderSquadPlayer[],
  needle: string,
  limit = SEARCH_LIMIT,
): ProviderSquadPlayer[] {
  if (needle === '') return [];
  return squads
    .map(player => ({ player, folded: normaliseLivePlayerName(player.name) }))
    .filter(({ folded }) => folded.includes(needle))
    .sort((a, b) => {
      const aStarts = a.folded.startsWith(needle);
      const bStarts = b.folded.startsWith(needle);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.player.name.localeCompare(b.player.name);
    })
    .slice(0, limit)
    .map(({ player }) => player);
}

export interface LiveScorerSyncResult {
  /** False when the tournament's provider serves no scorer list at all. */
  supported: boolean;
  /** Players the scorers list carried. Zero before anybody has scored, which is normal. */
  scorersFetched: number;
  /**
   * How many players are in the shortlist at all.
   *
   * Reported because "nothing was updated" has three quite different causes — nobody has
   * scored yet, there is nobody to update, or the goals simply have not moved — and a bare
   * count of zero cannot tell them apart.
   */
  shortlistSize: number;
  /** Shortlisted players whose goals moved. */
  updated: number;
  /** Hand-added rows matched to a provider player by name and adopted. */
  adopted: number;
  /**
   * Shortlisted players the scorer list did not mention, by name. Either they have not
   * scored, or nothing matched them — worth surfacing so nobody assumes a refresh reached
   * everyone.
   */
  unmatchedNames: string[];
  /** True when the scorers list came back at exactly `limit`, i.e. it was cut short. */
  truncated: boolean;
  /**
   * How many nationalities the feed's goals were folded into. Zero either because nobody
   * has scored or because the provider sent no nationalities at all — worth telling apart,
   * since the second one silently empties the nationality stat card.
   */
  nationalitiesCounted: number;
  /** The provider has not published this season yet. Not an error. */
  seasonUnavailable: boolean;
}

export interface SyncLiveScorersOptions {
  /** The season to read. Defaults to the tournament's own. */
  season?: string;
  limit?: number;
}

/**
 * Kept in providers/types.ts so the diagnostic probe asks for the same number.
 *
 * It used to be 100, which is plenty for refreshing a ten-player shortlist — those players
 * are all near the top of a ranked list. It is not plenty for counting: a UCL league phase
 * has a few hundred distinct scorers, and a top-100 list omits exactly the one-goal tail a
 * nationality total is made of.
 */
const DEFAULT_LIMIT = SCORER_FEED_LIMIT;

/**
 * Fold a scorer feed into goals per nationality.
 *
 * Exported for its own test. Rows the provider gave no nationality for are simply left
 * out — there is no country to attribute them to, and guessing one from a name or a club
 * would be worse than a slightly low total that says so.
 */
export function foldScorersByNationality(
  scorers: ProviderScorer[],
): LiveScorerNationalities['byNationality'] {
  const byNationality: LiveScorerNationalities['byNationality'] = {};
  for (const scorer of scorers) {
    const nationality = scorer.nationality?.trim();
    if (!nationality) continue;
    // A player counts towards their country's player tally whether or not they have
    // scored: they are in the feed, so the provider has something to say about them. The
    // goals are what they are.
    const entry = (byNationality[nationality] ??= { goals: 0, players: 0 });
    entry.goals += Math.max(0, scorer.goals);
    entry.players += 1;
  }
  return byNationality;
}

/**
 * Refresh the goals and assists of the players already in the tournament's list.
 *
 * Deliberately never creates. The list is the admin's shortlist plus whatever they have
 * typed in by hand, and a scorer list containing a hundred players nobody picked has no
 * business adding any of them — that was the old bulk-import model, and it made the admin
 * page a haystack. Players get in one way now: an admin searches for them and picks them.
 *
 * A player who has not scored is simply not in the payload, which is why nothing here
 * writes a zero: their stored tally, hand-entered or not, stands until the provider has
 * something to say about them.
 */
export async function refreshLivePlayerGoals(
  tournamentId: string,
  opts: SyncLiveScorersOptions = {},
): Promise<LiveScorerSyncResult> {
  const result: LiveScorerSyncResult = {
    supported: false,
    scorersFetched: 0,
    shortlistSize: 0,
    updated: 0,
    adopted: 0,
    unmatchedNames: [],
    truncated: false,
    nationalitiesCounted: 0,
    seasonUnavailable: false,
  };

  const [tournament] = await db
    .select()
    .from(liveTournaments)
    .where(eq(liveTournaments.id, tournamentId));
  if (!tournament) return result;

  // Goals are structure data, like teams and standings, so they come from the tournament's
  // main provider even when fixtures are read from a different one.
  const provider = getProvider(tournament.provider);
  if (!provider.fetchScorers) return result;
  result.supported = true;

  const limit = opts.limit ?? DEFAULT_LIMIT;
  let scorers;
  try {
    scorers = await provider.fetchScorers(
      tournament.providerCompetitionId,
      opts.season ?? tournament.season,
      limit,
    );
  } catch (err) {
    if (err instanceof ProviderError && err.isSeasonUnavailable) {
      result.seasonUnavailable = true;
      return result;
    }
    throw err;
  }

  result.scorersFetched = scorers.length;
  result.truncated = scorers.length >= limit;

  // Written before the shortlist work below, which gives up early when there is nothing to
  // refresh. The nationality snapshot does not depend on the shortlist — it is the whole
  // feed — so a tournament whose admin has picked nobody still gets its goal counts.
  const snapshot: LiveScorerNationalities = {
    fetchedAt: new Date().toISOString(),
    count: scorers.length,
    truncated: result.truncated,
    byNationality: foldScorersByNationality(scorers),
  };
  await db
    .update(liveTournaments)
    .set({ scorerNationalities: snapshot })
    .where(eq(liveTournaments.id, tournament.id));
  result.nationalitiesCounted = Object.keys(snapshot.byNationality).length;

  const stored = await db
    .select()
    .from(livePlayers)
    .where(eq(livePlayers.liveTournamentId, tournament.id));
  result.shortlistSize = stored.filter(p => p.isSelected).length;
  if (stored.length === 0) return result;

  const byProviderId = new Map(
    stored.filter(p => p.providerPlayerId !== null).map(p => [p.providerPlayerId!, p]),
  );
  const handAddedByName = indexByName(stored.filter(p => p.providerPlayerId === null));
  const storedById = new Map(stored.map(p => [p.id, p]));

  const now = new Date();
  const seen = new Set<string>();

  for (const scorer of scorers) {
    const existing = byProviderId.get(scorer.providerPlayerId);
    if (existing) {
      seen.add(existing.id);
      // A tally that has not moved is not a write. The refresh runs on every cold sync,
      // and rewriting every row each time would churn updated_at for nothing.
      if (existing.goals === scorer.goals && existing.assists === scorer.assists) continue;

      await db
        .update(livePlayers)
        .set({
          goals: scorer.goals,
          assists: scorer.assists,
          providerLastUpdated: now,
          updatedAt: now,
        })
        .where(eq(livePlayers.id, existing.id));
      result.updated++;
      continue;
    }

    // A player the admin typed in rather than picked from the search: adopt them on an
    // unambiguous name match, and they are kept current from then on.
    const handAddedId = handAddedByName.get(normaliseLivePlayerName(scorer.name));
    if (handAddedId && !seen.has(handAddedId)) {
      const row = storedById.get(handAddedId)!;
      seen.add(row.id);
      await db
        .update(livePlayers)
        .set({
          providerPlayerId: scorer.providerPlayerId,
          goals: scorer.goals,
          assists: scorer.assists,
          providerLastUpdated: now,
          updatedAt: now,
        })
        .where(eq(livePlayers.id, row.id));
      result.adopted++;
    }
  }

  // Only the shortlist is worth reporting on: a candidate nobody selected is not something
  // an admin is waiting on a goal count for.
  result.unmatchedNames = stored
    .filter(p => p.isSelected && !seen.has(p.id))
    .map(p => p.name);

  return result;
}
