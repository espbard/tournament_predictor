import { describe, it, expect } from 'vitest';
import {
  LIVE_LOCK_MINUTES,
  fixtureLockAt,
  isFixtureLocked,
  minutesUntilLock,
  getLiveFormat,
  resolveStageKey,
  isStageAtOrAfter,
  predictableStages,
  getLiveTournamentPreset,
  LIVE_TOURNAMENT_PRESETS,
} from '@tournament-predictor/shared';
import type { LiveFixtureStatus } from '@tournament-predictor/shared';

// Fixed reference point so nothing depends on the wall clock.
const NOW = new Date('2026-09-16T18:00:00.000Z');

function at(minutesFromNow: number): string {
  return new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
}

function fixture(kickoffAt: string | null, status: LiveFixtureStatus = 'scheduled') {
  return { kickoffAt, status };
}

describe('fixtureLockAt', () => {
  it('is exactly LIVE_LOCK_MINUTES before kickoff', () => {
    const kickoff = '2026-09-16T19:00:00.000Z';
    expect(fixtureLockAt(kickoff)?.toISOString()).toBe('2026-09-16T18:00:00.000Z');
    expect(LIVE_LOCK_MINUTES).toBe(60);
  });

  it('returns null when the kickoff time is unknown', () => {
    expect(fixtureLockAt(null)).toBeNull();
  });

  it('returns null for an unparseable date rather than an Invalid Date', () => {
    expect(fixtureLockAt('not a date')).toBeNull();
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(fixtureLockAt(new Date('2026-09-16T19:00:00.000Z'))?.toISOString()).toBe(
      '2026-09-16T18:00:00.000Z',
    );
  });
});

describe('isFixtureLocked — the 60 minute boundary', () => {
  it('is open more than an hour before kickoff', () => {
    expect(isFixtureLocked(fixture(at(61)), NOW)).toBe(false);
  });

  it('is locked exactly at kickoff minus 60 minutes', () => {
    expect(isFixtureLocked(fixture(at(60)), NOW)).toBe(true);
  });

  it('is open one minute before the deadline', () => {
    expect(isFixtureLocked(fixture(at(61)), NOW)).toBe(false);
  });

  it('is locked inside the final hour', () => {
    expect(isFixtureLocked(fixture(at(30)), NOW)).toBe(true);
  });

  it('is locked after kickoff has passed', () => {
    expect(isFixtureLocked(fixture(at(-5)), NOW)).toBe(true);
  });

  it('is open far in advance', () => {
    expect(isFixtureLocked(fixture(at(60 * 24 * 30)), NOW)).toBe(false);
  });
});

describe('isFixtureLocked — kickoff still to be announced', () => {
  it('stays open when there is no kickoff time', () => {
    expect(isFixtureLocked(fixture(null), NOW)).toBe(false);
  });

  it('stays open for an unparseable kickoff time', () => {
    expect(isFixtureLocked(fixture('nonsense'), NOW)).toBe(false);
  });
});

describe('isFixtureLocked — status overrides the clock', () => {
  const statuses: LiveFixtureStatus[] = ['in_play', 'paused', 'finished', 'suspended', 'cancelled'];

  for (const status of statuses) {
    it(`locks a ${status} fixture even if kickoff is days away`, () => {
      expect(isFixtureLocked(fixture(at(60 * 48), status), NOW)).toBe(true);
    });
  }

  it('locks an in-play fixture with no kickoff time', () => {
    expect(isFixtureLocked(fixture(null, 'in_play'), NOW)).toBe(true);
  });
});

describe('isFixtureLocked — postponed fixtures', () => {
  it('reopens when the stored kickoff is stale and a reschedule is pending', () => {
    // Provider kept the old date after calling the match off; it must not lock people out.
    expect(isFixtureLocked(fixture(at(-120), 'postponed'), NOW)).toBe(false);
  });

  it('is open once rescheduled to a future date more than an hour away', () => {
    expect(isFixtureLocked(fixture(at(60 * 24 * 7), 'postponed'), NOW)).toBe(false);
  });

  it('locks again inside the final hour of the new kickoff', () => {
    expect(isFixtureLocked(fixture(at(30), 'postponed'), NOW)).toBe(true);
  });
});

describe('minutesUntilLock', () => {
  it('counts down whole minutes to the deadline', () => {
    expect(minutesUntilLock(fixture(at(150)), NOW)).toBe(90);
  });

  it('is zero once locked', () => {
    expect(minutesUntilLock(fixture(at(30)), NOW)).toBe(0);
    expect(minutesUntilLock(fixture(at(60 * 48), 'in_play'), NOW)).toBe(0);
  });

  it('is null when the kickoff time is unknown', () => {
    expect(minutesUntilLock(fixture(null), NOW)).toBeNull();
  });
});

describe('stage mapping', () => {
  const ucl = getLiveFormat('ucl_swiss');

  it('maps the league phase', () => {
    expect(resolveStageKey(ucl, 'football_data', 'LEAGUE_STAGE')).toBe('league_phase');
  });

  it('keeps the August qualifier and the February knockout play-off apart', () => {
    // Conflating these would make summer qualifiers predictable.
    expect(resolveStageKey(ucl, 'football_data', 'PLAY_OFF_ROUND')).toBe('qualifying_playoff');
    expect(resolveStageKey(ucl, 'football_data', 'PLAYOFFS')).toBe('knockout_playoff');
  });

  it('maps the knockout rounds', () => {
    expect(resolveStageKey(ucl, 'football_data', 'LAST_16')).toBe('round_of_16');
    expect(resolveStageKey(ucl, 'football_data', 'QUARTER_FINALS')).toBe('quarter_final');
    expect(resolveStageKey(ucl, 'football_data', 'SEMI_FINALS')).toBe('semi_final');
    expect(resolveStageKey(ucl, 'football_data', 'FINAL')).toBe('final');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(resolveStageKey(ucl, 'football_data', ' last_16 ')).toBe('round_of_16');
  });

  it('returns null for an unknown stage rather than guessing', () => {
    expect(resolveStageKey(ucl, 'football_data', 'GROUP_STAGE')).toBeNull();
    expect(resolveStageKey(ucl, 'football_data', null)).toBeNull();
  });

  it('maps the domestic league regular season', () => {
    const pl = getLiveFormat('domestic_league');
    expect(resolveStageKey(pl, 'football_data', 'REGULAR_SEASON')).toBe('regular_season');
  });

  it('throws on an unknown format key', () => {
    expect(() => getLiveFormat('nope')).toThrow();
  });
});

describe('startStageKey filtering', () => {
  const ucl = getLiveFormat('ucl_swiss');

  it('excludes the summer qualifiers', () => {
    expect(isStageAtOrAfter(ucl, 'qualifying_playoff', 'league_phase')).toBe(false);
    expect(isStageAtOrAfter(ucl, 'qualifying_round_3', 'league_phase')).toBe(false);
  });

  it('includes the league phase and everything after it', () => {
    expect(isStageAtOrAfter(ucl, 'league_phase', 'league_phase')).toBe(true);
    expect(isStageAtOrAfter(ucl, 'knockout_playoff', 'league_phase')).toBe(true);
    expect(isStageAtOrAfter(ucl, 'final', 'league_phase')).toBe(true);
  });

  it('treats an unmapped stage as not predictable', () => {
    expect(isStageAtOrAfter(ucl, null, 'league_phase')).toBe(false);
    expect(isStageAtOrAfter(ucl, 'made_up', 'league_phase')).toBe(false);
  });

  it('lists predictable stages in chronological order', () => {
    expect(predictableStages(ucl, 'league_phase').map(s => s.key)).toEqual([
      'league_phase',
      'knockout_playoff',
      'round_of_16',
      'quarter_final',
      'semi_final',
      'final',
    ]);
  });
});

describe('presets', () => {
  it('ships the two agreed competitions', () => {
    expect(LIVE_TOURNAMENT_PRESETS.map(p => p.key)).toEqual(['ucl_2026_27', 'pl_2026_27']);
  });

  it('points the Champions League preset at the league phase onwards', () => {
    const ucl = getLiveTournamentPreset('ucl_2026_27');
    expect(ucl).not.toBeNull();
    expect(ucl!.providerCompetitionId).toBe('CL');
    expect(ucl!.season).toBe('2026');
    expect(ucl!.startStageKey).toBe('league_phase');
    expect(ucl!.expectedTeamCount).toBe(36);
  });

  it('resolves every preset to a real format and a real start stage', () => {
    for (const preset of LIVE_TOURNAMENT_PRESETS) {
      const format = getLiveFormat(preset.format);
      expect(
        format.stages.some(s => s.key === preset.startStageKey),
        `${preset.key} startStageKey`,
      ).toBe(true);
    }
  });

  it('returns null for an unknown preset key', () => {
    expect(getLiveTournamentPreset('nope')).toBeNull();
  });
});
