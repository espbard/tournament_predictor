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
    expectedTeamCount: 20,
    expectedStartStageFixtures: 380,
  },
];

export function getLiveTournamentPreset(key: string): LiveTournamentPreset | null {
  return LIVE_TOURNAMENT_PRESETS.find(p => p.key === key) ?? null;
}
