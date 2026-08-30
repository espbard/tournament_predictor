import type { LiveFixtureStatus } from './types';

// ── Selected matches ──────────────────────────────────────────────────────────
//
// A gameweek is one matchday inside one stage. An admin registers which of that
// gameweek's fixtures users predict on; the rest are ignored — no inputs, no points, not
// part of the game.
//
// The default is "nothing counts": a gameweek with no registered selection has none of
// its fixtures selected. A live competition therefore shows no fixtures at all until an
// admin has been through the gameweeks and picked, which is the point — a match nobody
// chose should never quietly become part of the game, least of all one that appears
// mid-season when the provider adds it.
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
 * A fixture with no stage (an unmapped provider stage) or no matchday belongs to no
 * gameweek, and so can never be selected: there is no gameweek for an admin to register
 * it under. It is excluded rather than silently included — see isLiveFixtureSelected.
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
 * True only where an admin has registered a selection for that fixture's gameweek and
 * this fixture is in it. Both ways of having no selection — no row for the gameweek, and
 * no gameweek at all — mean the fixture does not count.
 *
 * An empty selection is stored as no row rather than an empty list (see the route), and
 * the two are equivalent under this rule: neither selects anything.
 */
export function isLiveFixtureSelected(
  fixture: SelectableLiveFixture,
  selectionsByGameweek: Map<string, Set<string>>,
): boolean {
  const key = liveGameweekKey(fixture.stageKey, fixture.matchday);
  if (!key) return false;
  return selectionsByGameweek.get(key)?.has(fixture.id) ?? false;
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
  /** False when no selection is registered, i.e. none of its fixtures count yet. */
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
 * dropped cannot inflate `selectedCount` — and a gameweek nobody has registered reports
 * zero selected, which is what it is.
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
    const selectedIds = selected ? bucket.filter(f => selected.has(f.id)).map(f => f.id) : [];
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
