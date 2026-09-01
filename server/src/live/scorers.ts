import { and, eq, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client';
import { livePlayers, liveTeams, liveTournaments } from '../db/liveSchema';
import { getProvider } from './providers';
import { ProviderError } from './providers/types';

// ── The player list ───────────────────────────────────────────────────────────
//
// Where the players an admin can shortlist come from, and where their goals come from.
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

export interface LiveScorerSyncResult {
  /** False when the tournament's provider serves neither squads nor a scorer list. */
  supported: boolean;
  /** Players the squads carried — the roster to pick a shortlist from. */
  squadFetched: number;
  /** Players the scorers list carried. Zero before anybody has scored, which is normal. */
  scorersFetched: number;
  /** Rows created across both passes. */
  created: number;
  /** Existing rows whose details or numbers were refreshed. */
  updated: number;
  /** Hand-added rows matched to a provider player by name and adopted. */
  adopted: number;
  /**
   * Hand-added players the provider did not mention, by name. Their goals stay whatever
   * the admin set — worth surfacing so nobody assumes a sync updated everyone.
   */
  unmatchedNames: string[];
  /** True when the scorers list came back at exactly `limit`, i.e. it was cut short. */
  truncated: boolean;
  /**
   * The season is not published by the provider yet. Not an error, and the reason an
   * admin should seed the list from the previous season instead.
   */
  seasonUnavailable: boolean;
}

export interface SyncLiveScorersOptions {
  /**
   * Whether to pull the squads as well as the scorers.
   *
   * True for an admin import, which is when a roster is wanted. False for the background
   * sync: goals move constantly and squads do not, so re-reading ~900 players every cold
   * tick would be work nobody asked for. A transfer therefore shows up on the next import
   * rather than by itself, which is the right trade for a list that is fixed before the
   * season starts anyway.
   */
  includeSquads?: boolean;
  /**
   * The season to read. Defaults to the tournament's own.
   *
   * Passing last season's is how a shortlist gets seeded before the new one has a goal in
   * it: football-data player ids are stable across seasons, so rows imported from 2025
   * begin matching by themselves once 2026/27 data appears.
   */
  season?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;

/** Rows per insert statement. Postgres is happy with far more; this is about payload size. */
const INSERT_CHUNK = 200;

/** One row as either pass wants to write it. The two differ only in what they know. */
interface IncomingPlayer {
  providerPlayerId: string;
  name: string;
  providerTeamId: string | null;
  position?: string | null;
  goals?: number;
  assists?: number;
}

/**
 * Import the tournament's players from the provider, and refresh what is known about them.
 *
 * Runs the two passes described at the top of this file. Neither is required: a season the
 * provider has not published yet yields no squads, and a competition that has not started
 * yields no scorers — both are ordinary states, reported rather than thrown, so an admin
 * can see which half answered.
 *
 * Never deletes. A player dropped from a squad — or out of the top N — keeps the goals last
 * seen rather than reverting to zero, and a player in somebody's saved ranking must never
 * vanish from under it.
 */
export async function syncLivePlayers(
  tournamentId: string,
  opts: SyncLiveScorersOptions = {},
): Promise<LiveScorerSyncResult> {
  const result: LiveScorerSyncResult = {
    supported: false,
    squadFetched: 0,
    scorersFetched: 0,
    created: 0,
    updated: 0,
    adopted: 0,
    unmatchedNames: [],
    truncated: false,
    seasonUnavailable: false,
  };

  const [tournament] = await db
    .select()
    .from(liveTournaments)
    .where(eq(liveTournaments.id, tournamentId));
  if (!tournament) return result;

  // Players are structure data, like teams and standings, so they come from the
  // tournament's main provider even when fixtures are read from a different one.
  const provider = getProvider(tournament.provider);
  if (!provider.fetchSquads && !provider.fetchScorers) return result;
  result.supported = true;

  const season = opts.season ?? tournament.season;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // ── Pass one: the roster ────────────────────────────────────────────────────
  let squad: IncomingPlayer[] = [];
  if (provider.fetchSquads && opts.includeSquads !== false) {
    try {
      const players = await provider.fetchSquads(tournament.providerCompetitionId, season);
      squad = players.map(p => ({
        providerPlayerId: p.providerPlayerId,
        name: p.name,
        providerTeamId: p.providerTeamId,
        position: p.position,
      }));
      result.squadFetched = squad.length;
    } catch (err) {
      // A season the provider has not created yet is the normal pre-draw state, and the
      // answer to it is to import the previous season — not to fail the whole import.
      if (err instanceof ProviderError && err.isSeasonUnavailable) result.seasonUnavailable = true;
      else throw err;
    }
  }

  // ── Pass two: the goals ─────────────────────────────────────────────────────
  let scorers: IncomingPlayer[] = [];
  if (provider.fetchScorers) {
    try {
      const rows = await provider.fetchScorers(tournament.providerCompetitionId, season, limit);
      scorers = rows.map(r => ({
        providerPlayerId: r.providerPlayerId,
        name: r.name,
        providerTeamId: r.providerTeamId,
        goals: r.goals,
        assists: r.assists,
      }));
      result.scorersFetched = rows.length;
      result.truncated = rows.length >= limit;
    } catch (err) {
      if (err instanceof ProviderError && err.isSeasonUnavailable) result.seasonUnavailable = true;
      else throw err;
    }
  }

  // ── Merge, then write once ──────────────────────────────────────────────────
  //
  // The two passes overlap: a player who has scored is in both, and each source knows
  // something the other does not — the squads have the position, the scorers list has the
  // goals. Merging them in memory first means every player is written exactly once, with
  // everything known about them. Writing pass by pass instead would have the second pass
  // trying to update rows the first had not inserted yet.
  const merged = new Map<string, IncomingPlayer>();
  for (const player of [...squad, ...scorers]) {
    const existing = merged.get(player.providerPlayerId);
    merged.set(
      player.providerPlayerId,
      existing
        ? {
            ...existing,
            ...player,
            // Neither source is allowed to blank what the other supplied.
            providerTeamId: player.providerTeamId ?? existing.providerTeamId,
            position: player.position ?? existing.position,
            goals: player.goals ?? existing.goals,
            assists: player.assists ?? existing.assists,
          }
        : player,
    );
  }
  if (merged.size === 0) return result;

  const [stored, teams] = await Promise.all([
    db.select().from(livePlayers).where(eq(livePlayers.liveTournamentId, tournament.id)),
    db
      .select({ id: liveTeams.id, providerTeamId: liveTeams.providerTeamId })
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id)),
  ]);

  const teamIdByProviderId = new Map(teams.map(t => [t.providerTeamId, t.id]));
  const byProviderId = new Map(
    stored.filter(p => p.providerPlayerId !== null).map(p => [p.providerPlayerId!, p]),
  );
  const handAddedByName = indexByName(stored.filter(p => p.providerPlayerId === null));
  const storedById = new Map(stored.map(p => [p.id, p]));

  const now = new Date();
  const adopted = new Set<string>();
  const pending: Array<typeof livePlayers.$inferInsert> = [];

  for (const player of merged.values()) {
    const teamId = player.providerTeamId
      ? (teamIdByProviderId.get(player.providerTeamId) ?? null)
      : null;

    const existing = byProviderId.get(player.providerPlayerId);
    if (existing) {
      const next = {
        // The provider's spelling is canonical for a row it owns.
        name: player.name,
        teamId: teamId ?? existing.teamId,
        position: player.position ?? existing.position,
        // Only the scorers list knows these. Before it has anything to say, whatever is
        // stored stands — which is how a hand-entered tally survives a squad import.
        goals: player.goals ?? existing.goals,
        assists: player.assists ?? existing.assists,
      };

      // A squad of 900 that has not changed since the last import is 900 writes for
      // nothing, and it would report every player as "updated". Only real changes count.
      const changed =
        existing.name !== next.name ||
        existing.teamId !== next.teamId ||
        existing.position !== next.position ||
        existing.goals !== next.goals ||
        existing.assists !== next.assists;

      if (changed) {
        await db
          .update(livePlayers)
          .set({ ...next, providerLastUpdated: now, updatedAt: now })
          .where(eq(livePlayers.id, existing.id));
        result.updated++;
      }
      continue;
    }

    const handAddedId = handAddedByName.get(normaliseLivePlayerName(player.name));
    if (handAddedId && !adopted.has(handAddedId)) {
      const row = storedById.get(handAddedId)!;
      await db
        .update(livePlayers)
        .set({
          providerPlayerId: player.providerPlayerId,
          // The provider's spelling wins from here on — "kylian mbappe" typed in a hurry
          // becomes "Kylian Mbappé". Taking it now rather than leaving it for the next
          // import is what keeps this path and the one above agreeing.
          name: player.name,
          // The picture and the shortlist tick are untouched — those are the admin's
          // choices, not the provider's data.
          teamId: teamId ?? row.teamId,
          position: player.position ?? row.position,
          goals: player.goals ?? row.goals,
          assists: player.assists ?? row.assists,
          providerLastUpdated: now,
          updatedAt: now,
        })
        .where(eq(livePlayers.id, row.id));
      adopted.add(handAddedId);
      result.adopted++;
      continue;
    }

    pending.push({
      id: generateId(15),
      liveTournamentId: tournament.id,
      providerPlayerId: player.providerPlayerId,
      name: player.name,
      teamId,
      position: player.position ?? null,
      imageUrl: null,
      goals: player.goals ?? 0,
      assists: player.assists ?? 0,
      // An imported player is not in the shortlist until an admin puts them there.
      isSelected: false,
      providerLastUpdated: now,
      createdAt: now,
      updatedAt: now,
    });
    result.created++;
  }

  // A first Champions League import is ~900 players. One statement each would be ~900
  // round trips and a request slow enough to look broken, so they go in as a handful of
  // multi-row inserts. Updates stay one at a time: after the first import there are very
  // few of them, and each sets different values.
  for (let i = 0; i < pending.length; i += INSERT_CHUNK) {
    await db.insert(livePlayers).values(pending.slice(i, i + INSERT_CHUNK));
  }

  result.unmatchedNames = stored
    .filter(p => p.providerPlayerId === null && !adopted.has(p.id))
    .map(p => p.name);

  return result;
}

/** The players in a tournament's shortlist — what the ranking is over. */
export async function loadSelectedLivePlayers(tournamentId: string) {
  return db
    .select()
    .from(livePlayers)
    .where(and(eq(livePlayers.liveTournamentId, tournamentId), eq(livePlayers.isSelected, true)));
}

/** Whether every id belongs to this tournament's shortlist. Used when saving a ranking. */
export async function selectedPlayerIds(tournamentId: string): Promise<string[]> {
  const rows = await loadSelectedLivePlayers(tournamentId);
  return rows.map(r => r.id);
}
