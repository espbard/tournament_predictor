// ── What belongs to a season ──────────────────────────────────────────────────
//
// A provider that names seasons by their starting year (both of ours do) still has to be
// asked for them somehow, and not every provider takes a season parameter — bigballsdata
// is keyed by date instead. So a season is also a span of dates, and this is that span.
//
// It exists because asking is not the same as being answered. bigballsdata accepts
// `date_from`/`date_to` and ignores them: asked for 2026/27 it returned 273 matches,
// every Champions League fixture it holds, last season's included. A request filter you
// cannot verify is not a filter, so the same window is applied to what comes back.

/** A European season starting in year N runs to the summer of N+1. */
export interface SeasonWindow {
  dateFrom: string;
  dateTo: string;
}

/**
 * The calendar span of a season the provider names by its starting year.
 *
 * June of that year through July of the next: wide enough for qualifiers in July and a
 * final in June, and narrow enough that it cannot reach into a neighbouring season.
 * Null when the season is not a year we can read, in which case nothing is filtered —
 * refusing to guess beats discarding a competition whose seasons are named differently.
 */
export function seasonWindow(season: string): SeasonWindow | null {
  // A whole four-digit year and nothing else. parseInt would read "2026/27" as 2026 and
  // build a window for a season that is not the one being named.
  if (!/^\d{4}$/.test(season.trim())) return null;
  const start = Number.parseInt(season.trim(), 10);
  return { dateFrom: `${start}-06-01`, dateTo: `${start + 1}-07-31` };
}

/**
 * Whether a kickoff falls inside a season.
 *
 * A match with no kickoff time is not in the season: with no date and no season field
 * there is nothing to place it by, and a provider serving several seasons from one table
 * makes "assume it is the current one" a way to import last season's fixtures.
 */
export function isWithinSeason(kickoff: string | Date | null, season: string): boolean {
  const window = seasonWindow(season);
  if (!window) return true;
  if (kickoff === null) return false;

  const at = typeof kickoff === 'string' ? new Date(kickoff) : kickoff;
  if (Number.isNaN(at.getTime())) return false;

  const day = at.toISOString().slice(0, 10);
  return day >= window.dateFrom && day <= window.dateTo;
}
