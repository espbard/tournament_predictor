import { describe, expect, it } from 'vitest';
import { LIVE_TOURNAMENT_PRESETS } from '@tournament-predictor/shared';
import { isWithinSeason, seasonWindow } from './season';

// bigballsdata accepts date_from/date_to and ignores them: asked for 2026/27 it returned
// 273 matches — every Champions League fixture it holds, last season's included. So the
// season has to be enforced on what comes back, and this is that rule.

describe('seasonWindow', () => {
  it('runs from June of the starting year to July of the next', () => {
    expect(seasonWindow('2026')).toEqual({ dateFrom: '2026-06-01', dateTo: '2027-07-31' });
  });

  it('is null for a season that is not a year', () => {
    expect(seasonWindow('2026/27')).toBeNull();
    expect(seasonWindow('')).toBeNull();
  });
});

describe('isWithinSeason', () => {
  it('keeps a fixture from the season asked for', () => {
    // A league-phase night, and a final the following June.
    expect(isWithinSeason('2026-09-08T16:45:00.000Z', '2026')).toBe(true);
    expect(isWithinSeason('2027-06-05T19:00:00.000Z', '2026')).toBe(true);
  });

  it('drops last season and next season', () => {
    expect(isWithinSeason('2026-05-30T19:00:00.000Z', '2026')).toBe(false);
    expect(isWithinSeason('2027-09-15T19:00:00.000Z', '2026')).toBe(false);
  });

  it('includes both ends of the window', () => {
    expect(isWithinSeason('2026-06-01T00:00:00.000Z', '2026')).toBe(true);
    expect(isWithinSeason('2027-07-31T23:00:00.000Z', '2026')).toBe(true);
  });

  // Nothing to place it by, and a table serving several seasons makes "assume the
  // current one" a way to import last season's fixtures.
  it('drops a fixture with no kickoff time', () => {
    expect(isWithinSeason(null, '2026')).toBe(false);
    expect(isWithinSeason('not-a-date', '2026')).toBe(false);
  });

  // Refusing to guess beats discarding a competition whose seasons are named differently.
  it('keeps everything when the season is not a year', () => {
    expect(isWithinSeason('2020-01-01T00:00:00.000Z', '2026/27')).toBe(true);
    expect(isWithinSeason(null, '2026/27')).toBe(true);
  });
});

// ── Per-competition bounds ────────────────────────────────────────────────────
//
// Competitions do not share a calendar, so one hardcoded span cannot serve them all: a
// Champions League league phase opens in September, a domestic league in August. Getting
// this wrong does not fail loudly — it silently drops the fixtures outside the span.

describe('bounds from a preset', () => {
  const UCL = { from: '09-01', to: '06-01' };
  const DOMESTIC = { from: '08-01', to: '06-30' };

  it('anchors `from` in the starting year and `to` in the next', () => {
    expect(seasonWindow('2026', UCL)).toEqual({ dateFrom: '2026-09-01', dateTo: '2027-06-01' });
  });

  it('holds a Champions League season and nothing either side of it', () => {
    // First league-phase night, and the final.
    expect(isWithinSeason('2026-09-15T19:00:00.000Z', '2026', UCL)).toBe(true);
    expect(isWithinSeason('2027-05-29T19:00:00.000Z', '2026', UCL)).toBe(true);
    // Last season's final, and next season's opening night.
    expect(isWithinSeason('2026-05-30T19:00:00.000Z', '2026', UCL)).toBe(false);
    expect(isWithinSeason('2027-09-15T19:00:00.000Z', '2026', UCL)).toBe(false);
  });

  // The reason these are per competition rather than one rule: a September cut-off would
  // throw away the first month of a domestic season.
  it('keeps an August domestic opening weekend that September bounds would drop', () => {
    expect(isWithinSeason('2026-08-21T19:00:00.000Z', '2026', DOMESTIC)).toBe(true);
    expect(isWithinSeason('2026-08-21T19:00:00.000Z', '2026', UCL)).toBe(false);
  });

  it('gives every preset bounds that hold its own season', () => {
    for (const preset of LIVE_TOURNAMENT_PRESETS) {
      const window = seasonWindow(preset.season, preset.seasonBounds);
      expect(window).not.toBeNull();
      // A season must start in its own year and end in the next, or it is not a season.
      expect(window!.dateFrom.slice(0, 4)).toBe(preset.season);
      expect(Number(window!.dateTo.slice(0, 4))).toBe(Number(preset.season) + 1);
    }
  });
});
