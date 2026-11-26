import { getLiveTournamentPreset } from './presets';

// ── Knockout rounds: the calendar and who may see them ────────────────────────
//
// A round in the predictor is a gameweek: one (stageKey, matchday) pair. For a table stage
// the provider supplies both. For the knockout rounds of a competition two things are
// missing until the draw has been made and the provider has published the matches:
//
//   * the rounds themselves — with no fixtures there is no gameweek to show, select or
//     refresh, so the rounds are declared up front from UEFA's published dates;
//   * a way to place a fixture whose provider names no stage or leg (bigballsdata) — its
//     kickoff date says which round it belongs to.
//
// Each leg of a two-legged stage is its own round, numbered by leg (matchday 1 and 2),
// which is how football-data already numbers them. A single-legged stage is one round,
// matchday 1. That is not what football-data reports for a final (it sends matchday 0 in
// the captured payload), so the sync engine normalises it — see
// normaliseKnockoutMatchday.
//
// Visibility: a stage can be test-only — shown to test accounts and admins, invisible to
// everybody else — so the knockout rounds can be tried out before they are released.

/** One round of the calendar: a leg of a stage, played on the dates given. */
export interface LiveRoundCalendarEntry {
  stageKey: string;
  /** The leg number of a two-legged stage, 1 for a single-legged one. */
  matchday: number;
  /** ISO dates (YYYY-MM-DD) the round is scheduled on, ascending. */
  dates: string[];
}

/**
 * How far either side of its scheduled dates a round's window reaches.
 *
 * Two days lets a match moved by a day or two still land in its round, and is the most
 * the tightest calendar here allows: legs a week apart (Tue/Wed, then Tue/Wed again)
 * leave a five-day gap, and two days from each side keeps the windows apart.
 */
export const LIVE_ROUND_WINDOW_PAD_DAYS = 2;

const DAY = 24 * 60 * 60 * 1000;

function shiftDate(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** The round calendar of the preset a tournament was created from; empty when it has none. */
export function liveRoundCalendar(presetKey: string | null | undefined): LiveRoundCalendarEntry[] {
  return getLiveTournamentPreset(presetKey ?? '')?.roundCalendar ?? [];
}

/** The calendar entry for one gameweek, if the calendar has it. */
export function findLiveCalendarRound(
  calendar: LiveRoundCalendarEntry[],
  stageKey: string,
  matchday: number,
): LiveRoundCalendarEntry | null {
  return calendar.find(r => r.stageKey === stageKey && r.matchday === matchday) ?? null;
}

/**
 * The span of days a round's fixtures are fetched for and recognised by: its first
 * scheduled date minus the padding to its last plus the padding, inclusive.
 */
export function liveRoundWindow(
  round: LiveRoundCalendarEntry,
  padDays: number = LIVE_ROUND_WINDOW_PAD_DAYS,
): { dateFrom: string; dateTo: string } {
  const sorted = [...round.dates].sort();
  return {
    dateFrom: shiftDate(sorted[0], -padDays),
    dateTo: shiftDate(sorted[sorted.length - 1], padDays),
  };
}

/**
 * The round a kickoff falls in, or null when it is in none.
 *
 * Compared by UTC date. Every European club match kicks off in the evening, well clear of
 * midnight UTC, so the date is the date the match is played on.
 */
export function liveCalendarRoundForKickoff(
  calendar: LiveRoundCalendarEntry[],
  kickoff: Date | string | null,
): LiveRoundCalendarEntry | null {
  if (kickoff === null) return null;
  const at = typeof kickoff === 'string' ? new Date(kickoff) : kickoff;
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toISOString().slice(0, 10);
  return (
    calendar.find(round => {
      const { dateFrom, dateTo } = liveRoundWindow(round);
      return day >= dateFrom && day <= dateTo;
    }) ?? null
  );
}

// ── Visibility ────────────────────────────────────────────────────────────────

/**
 * The stages of a tournament that only test accounts and admins see.
 *
 * Null on the row means nobody has chosen yet, and the preset's default applies — which
 * is how a Champions League tournament created before this column existed starts with
 * its knockout rounds hidden, without a data migration that would have to run exactly
 * once. An array, even an empty one, is an admin's explicit choice and wins.
 */
export function liveTestOnlyStageKeys(tournament: {
  presetKey: string | null;
  testOnlyStageKeys: string[] | null;
}): string[] {
  if (tournament.testOnlyStageKeys) return tournament.testOnlyStageKeys;
  return getLiveTournamentPreset(tournament.presetKey ?? '')?.defaultTestOnlyStageKeys ?? [];
}

/** Whether this viewer sees everything, test-only stages included. */
export function canSeeTestOnlyLiveStages(user: { isAdmin: boolean; isTestAccount: boolean }): boolean {
  return user.isAdmin || user.isTestAccount;
}

/** Whether a viewer may see a fixture or round in `stageKey`. */
export function canSeeLiveStage(
  user: { isAdmin: boolean; isTestAccount: boolean },
  testOnlyStageKeys: string[],
  stageKey: string | null,
): boolean {
  if (canSeeTestOnlyLiveStages(user)) return true;
  return stageKey === null || !testOnlyStageKeys.includes(stageKey);
}
