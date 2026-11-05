import type { LiveFormatKey } from './formats';
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
   * A tournament that exists only to lend its fixtures to bonus rounds in other
   * competitions. It gets no competitions of its own, no table, no scorers and no bonus
   * questions — see server/src/live/bonusRounds.ts. Persisted as
   * live_tournaments.is_bonus_source.
   */
  bonusSourceOnly?: boolean;
}

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
    // League phase from mid-September; the final is in late May.
    seasonBounds: { from: '09-01', to: '06-01' },
    expectedTeamCount: 36,
    expectedStartStageFixtures: 144,
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
  {
    key: 'unl_2026_27',
    defaultName: 'UEFA Nations League 2026/27',
    labelKey: 'live.presets.unl_2026_27',
    // bigballsdata serves everything here — fixtures *and*, by being the only provider,
    // the teams, which the sync builds from the names on the fixtures. football-data's
    // free tier does not cover the Nations League. See "fixtures-only" in sync.ts.
    provider: 'big_balls',
    // bigballsdata's league key. Unverified from a cloud session (the host is blocked
    // there): check it with the tournament's "Ask the provider" button, which lists the
    // keys the provider knows, and correct it on the tournament page if it differs.
    providerCompetitionId: 'uefa-nations-league',
    season: '2026',
    format: 'nations_league',
    startStageKey: 'league_phase',
    // League phase September–November 2026, knockouts March 2027, finals June 2027.
    seasonBounds: { from: '09-01', to: '06-30' },
    expectedTeamCount: null,
    expectedStartStageFixtures: null,
    bonusSourceOnly: true,
  },
];

export function getLiveTournamentPreset(key: string): LiveTournamentPreset | null {
  return LIVE_TOURNAMENT_PRESETS.find(p => p.key === key) ?? null;
}
