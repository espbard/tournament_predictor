import type { LiveFixtureStatus } from './types';

// ── Selected matches ──────────────────────────────────────────────────────────
//
// A gameweek is one matchday inside one stage. An admin may register a *subset* of that
// gameweek's fixtures as the ones users predict on; the rest are ignored — no inputs, no
// points, not part of the game.
//
// The default is deliberately "everything counts": a gameweek with no registered
// selection has every one of its fixtures selected. That keeps a tournament playable the
// moment it is created, and means an admin only ever has to touch the gameweeks they
// actually want to narrow.
//
// This module is the single source of truth for that rule. The server enforces it when
// saving a prediction and when scoring, the client uses it to decide what to render, so
// the two cannot drift.

const KEY_SEPARATOR = '#';

/** The two fields that place a fixture in a gameweek. */
export interface LiveGameweekRef {
  stageKey: string | null;
  matchday: number | null;
}

/** One registered selection, as stored on `live_gameweek_selections`. */
export interface LiveGameweekSelectionRow {
  stageKey: string;
  matchday: number;
  selectedFixtureIds: string[];
}

export interface SelectableLiveFixture extends LiveGameweekRef {
  id: string;
}

/**
 * Stable key for a gameweek, or null when the fixture is not in one.
 *
 * A fixture with no stage (an unmapped provider stage) or no matchday (most knockout
 * fixtures) belongs to no gameweek and can therefore never be deselected.
 */
export function liveGameweekKey(stageKey: string | null, matchday: number | null): string | null {
  if (!stageKey || matchday == null) return null;
  return `${stageKey}${KEY_SEPARATOR}${matchday}`;
}

/** Selection rows indexed by gameweek key, for repeated lookups over a fixture list. */
export function indexLiveSelections(
  rows: LiveGameweekSelectionRow[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = liveGameweekKey(row.stageKey, row.matchday);
    if (!key) continue;
    index.set(key, new Set(row.selectedFixtureIds));
  }
  return index;
}

/**
 * Whether a fixture is part of the prediction game.
 *
 * True unless an admin has registered a selection for that fixture's gameweek and left
 * this fixture out of it. An empty selection is never stored — see the route — so this
 * can never report a gameweek in which nothing is playable.
 */
export function isLiveFixtureSelected(
  fixture: SelectableLiveFixture,
  selectionsByGameweek: Map<string, Set<string>>,
): boolean {
  const key = liveGameweekKey(fixture.stageKey, fixture.matchday);
  if (!key) return true;
  const selected = selectionsByGameweek.get(key);
  if (!selected) return true;
  return selected.has(fixture.id);
}

/**
 * Narrow a fixture list to the ones that count.
 *
 * Used by the scoring trigger, where scoring a deselected fixture would quietly award
 * points nobody agreed to play for.
 */
export function filterSelectedLiveFixtures<T extends SelectableLiveFixture>(
  fixtures: T[],
  selectionsByGameweek: Map<string, Set<string>>,
): T[] {
  return fixtures.filter(f => isLiveFixtureSelected(f, selectionsByGameweek));
}

/** A gameweek's fixtures plus which of them are selected — the admin read model. */
export interface LiveGameweekView {
  stageKey: string;
  matchday: number;
  /** False when no selection is registered, i.e. every fixture counts by default. */
  isCustomised: boolean;
  fixtureCount: number;
  selectedCount: number;
  selectedFixtureIds: string[];
}

interface SummarisableFixture extends SelectableLiveFixture {
  status?: LiveFixtureStatus;
}

/**
 * Summarise every gameweek present in a fixture list.
 *
 * Ordered by stage key then matchday. The stage part is alphabetical rather than
 * chronological — a caller that wants the format's stage order should regroup using
 * `LiveFormatDef.stages`, which the admin UI does.
 *
 * Fixtures outside any gameweek are skipped: there is nothing for an admin to configure
 * for a fixture that cannot belong to a gameweek in the first place. Registered ids that
 * are no longer fixtures of the gameweek are ignored, so a fixture the provider has
 * dropped cannot inflate `selectedCount`.
 */
export function summariseLiveGameweeks(
  fixtures: SummarisableFixture[],
  selectionsByGameweek: Map<string, Set<string>>,
): LiveGameweekView[] {
  const byKey = new Map<string, SummarisableFixture[]>();
  for (const fixture of fixtures) {
    const key = liveGameweekKey(fixture.stageKey, fixture.matchday);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(fixture);
    else byKey.set(key, [fixture]);
  }

  const views: LiveGameweekView[] = [];
  for (const [key, bucket] of byKey) {
    const selected = selectionsByGameweek.get(key);
    const selectedIds = bucket
      .filter(f => (selected ? selected.has(f.id) : true))
      .map(f => f.id);
    views.push({
      stageKey: bucket[0].stageKey!,
      matchday: bucket[0].matchday!,
      isCustomised: !!selected,
      fixtureCount: bucket.length,
      selectedCount: selectedIds.length,
      selectedFixtureIds: selectedIds,
    });
  }

  return views.sort(
    (a, b) => a.stageKey.localeCompare(b.stageKey) || a.matchday - b.matchday,
  );
}
