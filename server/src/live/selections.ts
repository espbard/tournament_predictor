import { eq, inArray } from 'drizzle-orm';
import { indexLiveSelections } from '@tournament-predictor/shared';
import { db } from '../db/client';
import { liveGameweekSelections } from '../db/liveSchema';

// ── Selected matches ──────────────────────────────────────────────────────────
//
// Database access for the gameweek selections an admin registers. The rule itself — a
// gameweek with no row has every fixture selected — lives in shared/src/live/selection.ts
// so the client applies exactly the same one.
//
// Every read model that exposes fixtures, and every path that scores them, goes through
// here: a fixture left out of its gameweek's selection is not part of the game, so it
// must not take a prediction and must never award points.

/** Gameweek key → the fixture ids selected for it, for one tournament. */
export type SelectionIndex = Map<string, Set<string>>;

export async function loadSelectionIndex(liveTournamentId: string): Promise<SelectionIndex> {
  const rows = await db
    .select({
      stageKey: liveGameweekSelections.stageKey,
      matchday: liveGameweekSelections.matchday,
      selectedFixtureIds: liveGameweekSelections.selectedFixtureIds,
    })
    .from(liveGameweekSelections)
    .where(eq(liveGameweekSelections.liveTournamentId, liveTournamentId));

  return indexLiveSelections(
    rows.map(r => ({
      stageKey: r.stageKey,
      matchday: r.matchday,
      selectedFixtureIds: r.selectedFixtureIds ?? [],
    })),
  );
}

/**
 * The same, for several tournaments at once — one query rather than one per tournament.
 * A tournament with no registered selection is absent from the outer map; callers should
 * treat that as an empty index, which is what makes everything selected.
 */
export async function loadSelectionIndexes(
  liveTournamentIds: string[],
): Promise<Map<string, SelectionIndex>> {
  const byTournament = new Map<string, SelectionIndex>();
  if (liveTournamentIds.length === 0) return byTournament;

  const rows = await db
    .select()
    .from(liveGameweekSelections)
    .where(inArray(liveGameweekSelections.liveTournamentId, liveTournamentIds));

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = grouped.get(row.liveTournamentId);
    if (bucket) bucket.push(row);
    else grouped.set(row.liveTournamentId, [row]);
  }

  for (const [tournamentId, tournamentRows] of grouped) {
    byTournament.set(
      tournamentId,
      indexLiveSelections(
        tournamentRows.map(r => ({
          stageKey: r.stageKey,
          matchday: r.matchday,
          selectedFixtureIds: r.selectedFixtureIds ?? [],
        })),
      ),
    );
  }

  return byTournament;
}

export const EMPTY_SELECTION_INDEX: SelectionIndex = new Map();
