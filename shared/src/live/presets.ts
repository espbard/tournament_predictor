import type { LiveFormatKey } from './formats';
import type { LiveRoundCalendarEntry } from './rounds';
import type { LiveProviderId } from './types';

// ── Ready-made competition connections ────────────────────────────────────────
//
// Admins create a live tournament by picking from this list rather than typing
// provider ids by hand. Adding a competition later is one entry here.

export interface LiveTournamentPreset {
  /** Stable key, persisted on live_tournaments.preset_key. */
  key: string;
  defaultName: string;
  labelKey: string;
  provider: LiveProviderId;
  /** Provider's competition identifier — football-data.org accepts its short code. */
  providerCompetitionId: string;
  /** football-data.org identifies a season by its starting year: 2026/27 is "2026". */
  season: string;
  format: LiveFormatKey;
  /** Everything before this stage is ingested but never predictable. */
  startStageKey: string;
  /**
   * When this competition's season starts and ends, as MM-DD.
   *
   * `from` falls in the season's starting year and `to` in the next. Used to decide what
   * belongs to a season when a provider will not: bigballsdata serves every season it
   * holds from one table and ignores the dates it is given, so the answer is filtered
   * against these. Competitions do not share a calendar — the Champions League league
   * phase begins in September while a domestic league is a month earlier — so this is
   * per competition rather than one rule for all of them.
   */
  seasonBounds: { from: string; to: string };
  /** Used to show "N of M teams confirmed" before a draw has been made. */
  expectedTeamCount: number | null;
  /**
   * How many fixtures the starting stage has when complete.
   *
   * The check that was missing: a provider returning *some* fixtures passes every other
   * test we have, and a Champions League league phase arriving as 50 of its 144 looks
   * exactly like a healthy sync. 36 teams playing 8 matches each is 144; a 20-team
   * double round-robin is 380.
   */
  expectedStartStageFixtures: number | null;
  defaultImageUrl?: string | null;
  /**
   * Rounds declared from the competition's published calendar rather than discovered from
   * fixtures — the knockout legs, which exist in the predictor before the draw has filled
   * them. See shared/src/live/rounds.ts.
   */
  roundCalendar?: LiveRoundCalendarEntry[];
  /**
   * Stages shown to test accounts and admins only, until an admin decides otherwise. Used
   * while `live_tournaments.test_only_stage_keys` is null. See liveTestOnlyStageKeys.
   */
  defaultTestOnlyStageKeys?: string[];
}

/** The UEFA Champions League 2026/27 knockout calendar, as UEFA published it. */
const UCL_2026_27_KNOCKOUT_CALENDAR: LiveRoundCalendarEntry[] = [
  { stageKey: 'knockout_playoff', matchday: 1, dates: ['2027-02-16', '2027-02-17'] },
  { stageKey: 'knockout_playoff', matchday: 2, dates: ['2027-02-23', '2027-02-24'] },
  { stageKey: 'round_of_16', matchday: 1, dates: ['2027-03-09', '2027-03-10'] },
  { stageKey: 'round_of_16', matchday: 2, dates: ['2027-03-16', '2027-03-17'] },
  { stageKey: 'quarter_final', matchday: 1, dates: ['2027-04-06', '2027-04-07'] },
  { stageKey: 'quarter_final', matchday: 2, dates: ['2027-04-13', '2027-04-14'] },
  { stageKey: 'semi_final', matchday: 1, dates: ['2027-04-27', '2027-04-28'] },
  { stageKey: 'semi_final', matchday: 2, dates: ['2027-05-04', '2027-05-05'] },
  { stageKey: 'final', matchday: 1, dates: ['2027-06-05'] },
];

export const LIVE_TOURNAMENT_PRESETS: LiveTournamentPreset[] = [
  {
    key: 'ucl_2026_27',
    defaultName: 'UEFA Champions League 2026/27',
    labelKey: 'live.presets.ucl_2026_27',
    provider: 'football_data',
    providerCompetitionId: 'CL',
    season: '2026',
    format: 'ucl_swiss',
    // The league phase draw is 27 August 2026; the summer qualifiers before it are
    // ingested only so qualification status can be derived.
    startStageKey: 'league_phase',
    // League phase from mid-September; the final is on 5 June 2027. The end was 1 June
    // until the knockout calendar was added, which would have filtered the final out of
    // every sync and deleted it from the database.
    seasonBounds: { from: '09-01', to: '06-30' },
    expectedTeamCount: 36,
    expectedStartStageFixtures: 144,
    roundCalendar: UCL_2026_27_KNOCKOUT_CALENDAR,
    // Released to everyone by an admin once they have been tried out.
    defaultTestOnlyStageKeys: [
      'knockout_playoff',
      'round_of_16',
      'quarter_final',
      'semi_final',
      'final',
    ],
  },
  {
    key: 'pl_2026_27',
    defaultName: 'Premier League 2026/27',
    labelKey: 'live.presets.pl_2026_27',
    provider: 'football_data',
    providerCompetitionId: 'PL',
    season: '2026',
    format: 'domestic_league',
    startStageKey: 'regular_season',
    // A domestic season opens in August and finishes in late May.
    seasonBounds: { from: '08-01', to: '06-30' },
    expectedTeamCount: 20,
    expectedStartStageFixtures: 380,
  },
];

export function getLiveTournamentPreset(key: string): LiveTournamentPreset | null {
  return LIVE_TOURNAMENT_PRESETS.find(p => p.key === key) ?? null;
}
