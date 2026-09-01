import { and, eq, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client';
import { livePlayers, liveTeams, liveTournaments } from '../db/liveSchema';
import { getProvider } from './providers';

// ── Top-scorer list ───────────────────────────────────────────────────────────
//
// Goals and assists for the players an admin can put in the ranking shortlist. The
// provider is the source of truth where it serves a scorer list, and the admin is where
// it does not — which is the whole reason `live_players.provider_player_id` is nullable.
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
  /** False when the tournament's provider serves no scorer list at all. */
  supported: boolean;
  /** Players the provider returned. */
  fetched: number;
  /** Rows created from the payload. */
  created: number;
  /** Rows already carrying a provider id whose numbers were refreshed. */
  updated: number;
  /** Hand-added rows matched to a provider player by name and adopted. */
  adopted: number;
  /**
   * Hand-added players the provider did not mention, by name. Their goals stay whatever
   * the admin set — worth surfacing so nobody assumes a sync updated everyone.
   */
  unmatchedNames: string[];
  /** True when the provider returned exactly `limit` players, i.e. the list was cut. */
  truncated: boolean;
}

export interface SyncLiveScorersOptions {
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

/**
 * Refresh the tournament's player list from the provider's scorers endpoint.
 *
 * Never deletes: a player who has stopped appearing in the top N — or whose competition
 * is over — keeps the goals last seen rather than silently reverting to zero, and a
 * player in somebody's saved ranking must not vanish underneath it.
 */
export async function syncLiveScorers(
  tournamentId: string,
  opts: SyncLiveScorersOptions = {},
): Promise<LiveScorerSyncResult> {
  const empty: LiveScorerSyncResult = {
    supported: false,
    fetched: 0,
    created: 0,
    updated: 0,
    adopted: 0,
    unmatchedNames: [],
    truncated: false,
  };

  const [tournament] = await db
    .select()
    .from(liveTournaments)
    .where(eq(liveTournaments.id, tournamentId));
  if (!tournament) return empty;

  // Scorers are structure data, like teams and standings, so they come from the
  // tournament's main provider even when fixtures are read from a different one.
  const provider = getProvider(tournament.provider);
  if (!provider.fetchScorers) return empty;

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const scorers = await provider.fetchScorers(
    tournament.providerCompetitionId,
    opts.season ?? tournament.season,
    limit,
  );

  const result: LiveScorerSyncResult = {
    ...empty,
    supported: true,
    fetched: scorers.length,
    truncated: scorers.length >= limit,
  };
  if (scorers.length === 0) return result;

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

  for (const scorer of scorers) {
    const teamId = scorer.providerTeamId
      ? (teamIdByProviderId.get(scorer.providerTeamId) ?? null)
      : null;

    const existing = byProviderId.get(scorer.providerPlayerId);
    if (existing) {
      await db
        .update(livePlayers)
        .set({
          // The provider's name wins for a row it owns — a player it has renamed (a
          // transliteration fixed, say) should follow — but its team only when it named
          // one we recognise, so an unmatched club does not blank an existing link.
          name: scorer.name,
          teamId: teamId ?? existing.teamId,
          goals: scorer.goals,
          assists: scorer.assists,
          providerLastUpdated: now,
          updatedAt: now,
        })
        .where(eq(livePlayers.id, existing.id));
      result.updated++;
      continue;
    }

    const handAddedId = handAddedByName.get(normaliseLivePlayerName(scorer.name));
    if (handAddedId && !adopted.has(handAddedId)) {
      const row = storedById.get(handAddedId)!;
      await db
        .update(livePlayers)
        .set({
          providerPlayerId: scorer.providerPlayerId,
          // Name and picture are left alone: the admin typed one and chose the other.
          teamId: teamId ?? row.teamId,
          goals: scorer.goals,
          assists: scorer.assists,
          providerLastUpdated: now,
          updatedAt: now,
        })
        .where(eq(livePlayers.id, row.id));
      adopted.add(handAddedId);
      result.adopted++;
      continue;
    }

    await db.insert(livePlayers).values({
      id: generateId(15),
      liveTournamentId: tournament.id,
      providerPlayerId: scorer.providerPlayerId,
      name: scorer.name,
      teamId,
      imageUrl: null,
      goals: scorer.goals,
      assists: scorer.assists,
      // An imported player is not in the shortlist until an admin puts them there.
      isSelected: false,
      providerLastUpdated: now,
      createdAt: now,
      updatedAt: now,
    });
    result.created++;
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
