import { describe, expect, it } from 'vitest';
import {
  LIVE_FORMATS,
  canSeeLiveStage,
  findLiveCalendarRound,
  getLiveTournamentPreset,
  liveCalendarRoundForKickoff,
  liveRoundCalendar,
  liveRoundWindow,
  liveTestOnlyStageKeys,
} from '@tournament-predictor/shared';
import { isWithinSeason } from './season';
import { placeFixtureInRound } from './sync';

// The knockout round calendar (shared/src/live/rounds.ts) and how the sync engine uses it
// to file fixtures. Pure functions only — see sync.test.ts on why.

const UCL = LIVE_FORMATS.ucl_swiss;
const calendar = liveRoundCalendar('ucl_2026_27');

describe('the UCL 2026/27 round calendar', () => {
  it('splits every knockout stage but the final into two legs', () => {
    const rounds = calendar.map(r => `${r.stageKey}#${r.matchday}`);
    expect(rounds).toEqual([
      'knockout_playoff#1',
      'knockout_playoff#2',
      'round_of_16#1',
      'round_of_16#2',
      'quarter_final#1',
      'quarter_final#2',
      'semi_final#1',
      'semi_final#2',
      'final#1',
    ]);
  });

  it('only names stages the format knows, with as many rounds as the stage has legs', () => {
    for (const stage of UCL.stages.filter(s => s.kind === 'knockout' && s.order >= 20)) {
      expect(calendar.filter(r => r.stageKey === stage.key)).toHaveLength(stage.legs);
    }
  });

  it('keeps every round window apart from the next', () => {
    const windows = calendar.map(r => liveRoundWindow(r));
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].dateFrom > windows[i - 1].dateTo).toBe(true);
    }
  });

  it('keeps the final inside the season, so a sync does not drop it', () => {
    const bounds = getLiveTournamentPreset('ucl_2026_27')!.seasonBounds;
    expect(isWithinSeason('2027-06-05T19:00:00Z', '2026', bounds)).toBe(true);
  });

  it('has no calendar for a preset that declares none', () => {
    expect(liveRoundCalendar('pl_2026_27')).toEqual([]);
    expect(liveRoundCalendar(null)).toEqual([]);
  });
});

describe('liveRoundWindow', () => {
  it('pads the scheduled dates by two days either side', () => {
    const round = findLiveCalendarRound(calendar, 'knockout_playoff', 1)!;
    expect(liveRoundWindow(round)).toEqual({ dateFrom: '2027-02-14', dateTo: '2027-02-19' });
  });

  it('crosses a month boundary', () => {
    const round = findLiveCalendarRound(calendar, 'semi_final', 2)!;
    expect(liveRoundWindow(round)).toEqual({ dateFrom: '2027-05-02', dateTo: '2027-05-07' });
  });
});

describe('liveCalendarRoundForKickoff', () => {
  it('finds the leg a kickoff is played in', () => {
    expect(liveCalendarRoundForKickoff(calendar, '2027-03-17T20:00:00Z')).toMatchObject({
      stageKey: 'round_of_16',
      matchday: 2,
    });
  });

  it('accepts a match moved a day out of its scheduled dates', () => {
    expect(liveCalendarRoundForKickoff(calendar, '2027-02-18T20:00:00Z')).toMatchObject({
      stageKey: 'knockout_playoff',
      matchday: 1,
    });
  });

  it('places nothing in the league phase or the gaps between rounds', () => {
    expect(liveCalendarRoundForKickoff(calendar, '2027-01-27T20:00:00Z')).toBeNull();
    expect(liveCalendarRoundForKickoff(calendar, '2027-02-20T20:00:00Z')).toBeNull();
    expect(liveCalendarRoundForKickoff(calendar, null)).toBeNull();
  });
});

describe('placeFixtureInRound', () => {
  const base = {
    format: UCL,
    calendar,
    mappedStageKey: null,
    providerStage: null,
    defaultStageKey: 'league_phase',
    providerMatchday: null,
    kickoffAt: null as Date | null,
  };

  it('keeps what football-data says about a two-legged stage', () => {
    expect(
      placeFixtureInRound({
        ...base,
        mappedStageKey: 'round_of_16',
        providerStage: 'LAST_16',
        providerMatchday: 2,
        kickoffAt: new Date('2027-03-17T20:00:00Z'),
      }),
    ).toEqual({ stageKey: 'round_of_16', matchday: 2 });
  });

  it('files a stage-less knockout match by its kickoff, leg included', () => {
    expect(
      placeFixtureInRound({ ...base, kickoffAt: new Date('2027-04-14T19:00:00Z') }),
    ).toEqual({ stageKey: 'quarter_final', matchday: 2 });
  });

  it('still files a stage-less league-phase match under the default stage', () => {
    expect(
      placeFixtureInRound({ ...base, kickoffAt: new Date('2026-11-04T20:00:00Z') }),
    ).toEqual({ stageKey: 'league_phase', matchday: null });
  });

  it('numbers a final round 1, whatever the provider reports', () => {
    for (const providerMatchday of [0, null, 3]) {
      expect(
        placeFixtureInRound({
          ...base,
          mappedStageKey: 'final',
          providerStage: 'FINAL',
          providerMatchday,
          kickoffAt: new Date('2027-06-05T19:00:00Z'),
        }),
      ).toEqual({ stageKey: 'final', matchday: 1 });
    }
  });

  it('takes a missing leg number from the calendar only for the same stage', () => {
    expect(
      placeFixtureInRound({
        ...base,
        mappedStageKey: 'semi_final',
        providerStage: 'SEMI_FINALS',
        kickoffAt: new Date('2027-05-05T19:00:00Z'),
      }),
    ).toEqual({ stageKey: 'semi_final', matchday: 2 });

    expect(
      placeFixtureInRound({
        ...base,
        mappedStageKey: 'quarter_final',
        providerStage: 'QUARTER_FINALS',
        kickoffAt: new Date('2027-05-05T19:00:00Z'),
      }),
    ).toEqual({ stageKey: 'quarter_final', matchday: null });
  });

  it('leaves an unrecognised stage string unmapped rather than guessing', () => {
    expect(
      placeFixtureInRound({
        ...base,
        providerStage: 'SOMETHING_NEW',
        providerMatchday: 1,
        kickoffAt: new Date('2027-03-10T20:00:00Z'),
      }),
    ).toEqual({ stageKey: null, matchday: 1 });
  });

  it('changes nothing for a tournament without a calendar', () => {
    expect(
      placeFixtureInRound({
        ...base,
        calendar: [],
        defaultStageKey: null,
        kickoffAt: new Date('2027-03-10T20:00:00Z'),
      }),
    ).toEqual({ stageKey: null, matchday: null });
  });
});

describe('test-only stages', () => {
  const regular = { isAdmin: false, isTestAccount: false };
  const tester = { isAdmin: false, isTestAccount: true };
  const admin = { isAdmin: true, isTestAccount: false };

  it('hides every UCL knockout stage by default', () => {
    const hidden = liveTestOnlyStageKeys({ presetKey: 'ucl_2026_27', testOnlyStageKeys: null });
    expect(hidden).toEqual(['knockout_playoff', 'round_of_16', 'quarter_final', 'semi_final', 'final']);
  });

  it('lets an admin choice, even an empty one, override the default', () => {
    expect(liveTestOnlyStageKeys({ presetKey: 'ucl_2026_27', testOnlyStageKeys: [] })).toEqual([]);
    expect(
      liveTestOnlyStageKeys({ presetKey: 'ucl_2026_27', testOnlyStageKeys: ['final'] }),
    ).toEqual(['final']);
  });

  it('hides nothing on a preset without a default', () => {
    expect(liveTestOnlyStageKeys({ presetKey: 'pl_2026_27', testOnlyStageKeys: null })).toEqual([]);
  });

  it('shows a test-only stage to test accounts and admins only', () => {
    const hidden = ['round_of_16'];
    expect(canSeeLiveStage(regular, hidden, 'round_of_16')).toBe(false);
    expect(canSeeLiveStage(tester, hidden, 'round_of_16')).toBe(true);
    expect(canSeeLiveStage(admin, hidden, 'round_of_16')).toBe(true);
    expect(canSeeLiveStage(regular, hidden, 'league_phase')).toBe(true);
  });
});
