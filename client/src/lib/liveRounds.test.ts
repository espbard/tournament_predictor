import { describe, expect, it } from 'vitest';
import { layoutLiveRounds } from '@tournament-predictor/shared';
import { buildLiveRoundStrip, placeBonusRoundsOnStrip } from './liveRounds';

// The one progress bar: every stage's rounds in order, and where bonus rounds sit on it.

const stages = [{ key: 'league_phase' }, { key: 'knockout_playoff' }, { key: 'final' }];
const fixtures = [
  { stageKey: 'league_phase', matchday: 2 },
  { stageKey: 'league_phase', matchday: 1 },
  { stageKey: 'league_phase', matchday: 1 },
  { stageKey: 'knockout_playoff', matchday: 1 },
  { stageKey: null, matchday: 3 },
];
const calendar = [
  { stageKey: 'knockout_playoff', matchday: 1 },
  { stageKey: 'knockout_playoff', matchday: 2 },
  { stageKey: 'final', matchday: 1 },
];

describe('buildLiveRoundStrip', () => {
  it('runs through every stage in order, each stage’s rounds ascending', () => {
    expect(buildLiveRoundStrip(stages, fixtures, calendar).map(r => r.key)).toEqual([
      'league_phase#1',
      'league_phase#2',
      'knockout_playoff#1',
      'knockout_playoff#2',
      'final#1',
    ]);
  });

  it('leaves out a stage with no rounds at all', () => {
    expect(buildLiveRoundStrip(stages, fixtures).map(r => r.key)).toEqual([
      'league_phase#1',
      'league_phase#2',
      'knockout_playoff#1',
    ]);
  });
});

describe('placeBonusRoundsOnStrip', () => {
  const strip = buildLiveRoundStrip(stages, fixtures, calendar);
  const layoutStages = [
    { key: 'league_phase', kind: 'table' as const, matchdays: [1, 2] },
    { key: 'knockout_playoff', kind: 'knockout' as const, matchdays: [1, 2] },
    { key: 'final', kind: 'knockout' as const, matchdays: [1] },
  ];
  const round = (id: string, afterStageKey: string | null, afterMatchday: number | null) => ({
    id,
    afterStageKey,
    afterMatchday,
    firstKickoffAt: null,
  });

  it('puts each kind of anchor where it belongs on the one strip', () => {
    const placed = placeBonusRoundsOnStrip(
      layoutLiveRounds(layoutStages, [
        round('before-all', null, null),
        round('after-gw1', 'league_phase', 1),
        round('before-gw1', 'league_phase', 0),
        round('after-league', 'league_phase', null),
        round('after-playoffs', 'knockout_playoff', null),
        round('gone', 'round_of_16', null),
      ]),
      strip,
    );
    const at = Object.fromEntries(placed.map(p => [p.round.id, p.afterKey]));
    expect(at).toEqual({
      'before-all': null,
      'after-gw1': 'league_phase#1',
      'before-gw1': null,
      'after-league': 'league_phase#2',
      'after-playoffs': 'knockout_playoff#2',
      gone: 'final#1',
    });
  });
});
