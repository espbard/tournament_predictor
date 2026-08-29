import { describe, it, expect } from 'vitest';
import {
  filterSelectedLiveFixtures,
  indexLiveSelections,
  isLiveFixtureSelected,
  liveGameweekKey,
  summariseLiveGameweeks,
} from '@tournament-predictor/shared';

// ── Selected matches ──────────────────────────────────────────────────────────
//
// The rule under test: every fixture in a gameweek counts until an admin registers a
// selection for that gameweek, after which only the registered ones do.

function fixture(id: string, stageKey: string | null, matchday: number | null) {
  return { id, stageKey, matchday };
}

const LEAGUE = 'league_phase';

describe('liveGameweekKey', () => {
  it('combines stage and matchday', () => {
    expect(liveGameweekKey(LEAGUE, 3)).toBe('league_phase#3');
  });

  it('is null for a fixture that belongs to no gameweek', () => {
    expect(liveGameweekKey(null, 3)).toBeNull();
    expect(liveGameweekKey(LEAGUE, null)).toBeNull();
  });

  // Matchday 1 in the league phase and matchday 1 of a knockout leg are different weeks.
  it('separates the same matchday in different stages', () => {
    expect(liveGameweekKey(LEAGUE, 1)).not.toBe(liveGameweekKey('round_of_16', 1));
  });
});

describe('isLiveFixtureSelected', () => {
  it('selects everything when nothing has been registered', () => {
    const index = indexLiveSelections([]);
    expect(isLiveFixtureSelected(fixture('a', LEAGUE, 1), index)).toBe(true);
    expect(isLiveFixtureSelected(fixture('b', LEAGUE, 1), index)).toBe(true);
  });

  it('selects only the registered fixtures of a registered gameweek', () => {
    const index = indexLiveSelections([
      { stageKey: LEAGUE, matchday: 1, selectedFixtureIds: ['a', 'c'] },
    ]);
    expect(isLiveFixtureSelected(fixture('a', LEAGUE, 1), index)).toBe(true);
    expect(isLiveFixtureSelected(fixture('b', LEAGUE, 1), index)).toBe(false);
    expect(isLiveFixtureSelected(fixture('c', LEAGUE, 1), index)).toBe(true);
  });

  it('leaves other gameweeks at their default', () => {
    const index = indexLiveSelections([
      { stageKey: LEAGUE, matchday: 1, selectedFixtureIds: ['a'] },
    ]);
    expect(isLiveFixtureSelected(fixture('z', LEAGUE, 2), index)).toBe(true);
    expect(isLiveFixtureSelected(fixture('z', 'round_of_16', 1), index)).toBe(true);
  });

  // A knockout fixture has no matchday, and an unmapped provider stage has no stage key.
  // Neither sits in a gameweek, so neither can be deselected by one.
  it('selects a fixture that belongs to no gameweek', () => {
    const index = indexLiveSelections([
      { stageKey: LEAGUE, matchday: 1, selectedFixtureIds: ['a'] },
    ]);
    expect(isLiveFixtureSelected(fixture('b', LEAGUE, null), index)).toBe(true);
    expect(isLiveFixtureSelected(fixture('b', null, 1), index)).toBe(true);
  });
});

describe('filterSelectedLiveFixtures', () => {
  it('drops the fixtures left out of their gameweek', () => {
    const index = indexLiveSelections([
      { stageKey: LEAGUE, matchday: 1, selectedFixtureIds: ['a'] },
    ]);
    const kept = filterSelectedLiveFixtures(
      [fixture('a', LEAGUE, 1), fixture('b', LEAGUE, 1), fixture('c', LEAGUE, 2)],
      index,
    );
    expect(kept.map(f => f.id)).toEqual(['a', 'c']);
  });
});

describe('summariseLiveGameweeks', () => {
  const fixtures = [
    fixture('a', LEAGUE, 1),
    fixture('b', LEAGUE, 1),
    fixture('c', LEAGUE, 2),
    fixture('knockout', 'round_of_16', null),
  ];

  it('reports an untouched gameweek as fully selected but not customised', () => {
    const views = summariseLiveGameweeks(fixtures, indexLiveSelections([]));
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      stageKey: LEAGUE,
      matchday: 1,
      isCustomised: false,
      fixtureCount: 2,
      selectedCount: 2,
    });
  });

  it('reports the registered subset', () => {
    const views = summariseLiveGameweeks(
      fixtures,
      indexLiveSelections([{ stageKey: LEAGUE, matchday: 1, selectedFixtureIds: ['b'] }]),
    );
    expect(views[0]).toMatchObject({
      matchday: 1,
      isCustomised: true,
      fixtureCount: 2,
      selectedCount: 1,
      selectedFixtureIds: ['b'],
    });
    // The untouched gameweek is unaffected.
    expect(views[1]).toMatchObject({ matchday: 2, isCustomised: false, selectedCount: 1 });
  });

  // A fixture the provider has since dropped leaves a stale id behind; it must not be
  // counted as selected, or the admin UI would claim a match that no longer exists.
  it('ignores registered ids that are no longer fixtures of the gameweek', () => {
    const views = summariseLiveGameweeks(
      fixtures,
      indexLiveSelections([{ stageKey: LEAGUE, matchday: 1, selectedFixtureIds: ['a', 'gone'] }]),
    );
    expect(views[0]).toMatchObject({ selectedCount: 1, selectedFixtureIds: ['a'] });
  });

  it('skips fixtures that belong to no gameweek', () => {
    const views = summariseLiveGameweeks(fixtures, indexLiveSelections([]));
    expect(views.some(v => v.stageKey === 'round_of_16')).toBe(false);
  });

  it('orders by stage then matchday', () => {
    const views = summariseLiveGameweeks(
      [fixture('c', LEAGUE, 10), fixture('a', LEAGUE, 2), fixture('b', LEAGUE, 1)],
      indexLiveSelections([]),
    );
    expect(views.map(v => v.matchday)).toEqual([1, 2, 10]);
  });
});
