import { describe, expect, it } from 'vitest';
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
