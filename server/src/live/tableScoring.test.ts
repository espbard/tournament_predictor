import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_SCORING_CONFIG,
  LIVE_FORMATS,
  bandForPosition,
  tablePredictionStage,
  type LiveScoringConfig,
} from '@tournament-predictor/shared';
import { calculateTablePoints, isTableStageComplete, validateTableOrder } from './tableScoring';

const CONFIG = DEFAULT_LIVE_SCORING_CONFIG;
const UCL_STAGE = tablePredictionStage(LIVE_FORMATS.ucl_swiss, 'league_phase');
const PL_STAGE = tablePredictionStage(LIVE_FORMATS.domestic_league, 'regular_season');

/** Team ids "t1".."tN". */
const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

/** Actual positions from a finishing order, top first. */
const positions = (order: string[]) => new Map(order.map((id, i) => [id, i + 1]));

describe('bandForPosition — Champions League league phase', () => {
  it.each([
    [1, 'automatic'],
    [8, 'automatic'],
    [9, 'playoff'],
    [24, 'playoff'],
    [25, 'eliminated'],
    [36, 'eliminated'],
  ])('position %i is in the %s band', (position, band) => {
    expect(bandForPosition(UCL_STAGE, position)).toBe(band);
  });

  it('has no bands for a domestic league', () => {
    expect(bandForPosition(PL_STAGE, 1)).toBeNull();
    expect(bandForPosition(PL_STAGE, 20)).toBeNull();
  });

  it('returns null for a nonsensical position', () => {
    expect(bandForPosition(UCL_STAGE, 0)).toBeNull();
    expect(bandForPosition(UCL_STAGE, -1)).toBeNull();
  });

  // The eliminated band is open-ended, so an unexpectedly long table still resolves.
  it('handles a position past the bottom of the known table', () => {
    expect(bandForPosition(UCL_STAGE, 40)).toBe('eliminated');
  });
});

describe('calculateTablePoints — Champions League', () => {
  const order = teams(36);

  it('awards 2 per team for a perfect table', () => {
    const result = calculateTablePoints(order, positions(order), UCL_STAGE, CONFIG);
    expect(result.exactPositionPoints).toBe(36);
    expect(result.bandPoints).toBe(36);
    expect(result.points).toBe(72);
  });

  // The worked example from the feature request.
  it('awards 2 for an exact position, 1 for the right band only, 0 for the wrong band', () => {
    // Actual order is t1..t36. The prediction pulls t1 out of the top and slots it in at
    // 29th, shifting t2..t29 up one place; t30..t36 keep their real positions.
    const actual = positions(order);
    const predicted = [...order.slice(1, 29), 't1', ...order.slice(29)];

    const result = calculateTablePoints(predicted, actual, UCL_STAGE, CONFIG);
    const byTeam = new Map(result.teams.map(t => [t.teamId, t]));

    // t2 predicted 1st, actually 2nd — wrong place, still automatic qualification.
    expect(byTeam.get('t2')).toMatchObject({ exactPosition: false, correctBand: true, points: 1 });
    // t1 predicted 29th, actually 1st — wrong place, and eliminated vs automatic.
    expect(byTeam.get('t1')).toMatchObject({ exactPosition: false, correctBand: false, points: 0 });
    // t30 undisturbed at 30th — exact position and, necessarily, the right band.
    expect(byTeam.get('t30')).toMatchObject({ exactPosition: true, correctBand: true, points: 2 });
    // t25 shifted from 25th to 24th: eliminated band predicted as play-off.
    expect(byTeam.get('t25')).toMatchObject({ predictedBand: 'playoff', actualBand: 'eliminated', points: 0 });
  });

  it('awards the band point across a band boundary miss', () => {
    // t9 (actually 9th, playoff band) predicted 8th — automatic band. Wrong band.
    const actual = positions(teams(36));
    const predicted = [...teams(36)];
    [predicted[7], predicted[8]] = [predicted[8], predicted[7]];

    const result = calculateTablePoints(predicted, actual, UCL_STAGE, CONFIG);
    const byTeam = new Map(result.teams.map(t => [t.teamId, t]));

    expect(byTeam.get('t9')).toMatchObject({ predictedBand: 'automatic', actualBand: 'playoff', points: 0 });
    expect(byTeam.get('t8')).toMatchObject({ predictedBand: 'playoff', actualBand: 'automatic', points: 0 });
  });

  it('reports per-team detail in predicted order', () => {
    const result = calculateTablePoints(['t3', 't1', 't2'], positions(['t1', 't2', 't3']), UCL_STAGE, CONFIG);
    expect(result.teams.map(t => t.teamId)).toEqual(['t3', 't1', 't2']);
    expect(result.teams.map(t => t.predictedPosition)).toEqual([1, 2, 3]);
    expect(result.teams.map(t => t.actualPosition)).toEqual([3, 1, 2]);
  });

  it('scores nothing for a team missing from the final table', () => {
    const actual = positions(['t1', 't2']);
    const result = calculateTablePoints(['t1', 't2', 'withdrawn'], actual, UCL_STAGE, CONFIG);
    const last = result.teams[2];

    expect(last).toMatchObject({ actualPosition: null, exactPosition: false, correctBand: false, points: 0 });
    // The rest of the table still scores normally.
    expect(result.teams[0].points).toBe(2);
  });
});

describe('calculateTablePoints — domestic league (no bands)', () => {
  const order = teams(20);

  it('awards only exact positions', () => {
    const result = calculateTablePoints(order, positions(order), PL_STAGE, CONFIG);
    expect(result.exactPositionPoints).toBe(20);
    expect(result.bandPoints).toBe(0);
    expect(result.points).toBe(20);
  });

  it('never awards a band point', () => {
    const predicted = [order[1], order[0], ...order.slice(2)];
    const result = calculateTablePoints(predicted, positions(order), PL_STAGE, CONFIG);
    expect(result.bandPoints).toBe(0);
    expect(result.teams.every(t => t.correctBand === false)).toBe(true);
  });
});

describe('calculateTablePoints — configuration', () => {
  it('honours custom point values', () => {
    const custom: LiveScoringConfig = {
      ...CONFIG,
      table_exact_position: 5,
      table_correct_band: 3,
    };
    const order = teams(36);
    const result = calculateTablePoints(order, positions(order), UCL_STAGE, custom);
    expect(result.points).toBe(36 * 8);
  });

  it('can have the band bonus switched off', () => {
    const noBand: LiveScoringConfig = { ...CONFIG, table_correct_band: 0 };
    const order = teams(36);
    const result = calculateTablePoints(order, positions(order), UCL_STAGE, noBand);
    expect(result.bandPoints).toBe(0);
    expect(result.points).toBe(36);
  });

  it('returns zeros for an empty prediction', () => {
    expect(calculateTablePoints([], new Map(), UCL_STAGE, CONFIG)).toMatchObject({
      points: 0,
      teams: [],
    });
  });

  it('treats a null stage as having no bands', () => {
    const order = teams(3);
    const result = calculateTablePoints(order, positions(order), null, CONFIG);
    expect(result.exactPositionPoints).toBe(3);
    expect(result.bandPoints).toBe(0);
  });
});

describe('isTableStageComplete', () => {
  it('is true once every fixture has finished', () => {
    expect(isTableStageComplete([{ status: 'finished' }, { status: 'finished' }])).toBe(true);
  });

  // A cancelled fixture will never be played, so waiting for it would strand the table.
  it('treats a cancelled fixture as done', () => {
    expect(isTableStageComplete([{ status: 'finished' }, { status: 'cancelled' }])).toBe(true);
  });

  // A postponed one is still expected, and could still move the table.
  it('does not treat a postponed fixture as done', () => {
    expect(isTableStageComplete([{ status: 'finished' }, { status: 'postponed' }])).toBe(false);
  });

  it('is false while anything is unplayed or in play', () => {
    expect(isTableStageComplete([{ status: 'finished' }, { status: 'scheduled' }])).toBe(false);
    expect(isTableStageComplete([{ status: 'in_play' }])).toBe(false);
  });

  it('is false for a stage with no fixtures at all', () => {
    expect(isTableStageComplete([])).toBe(false);
  });
});

describe('validateTableOrder', () => {
  const valid = ['a', 'b', 'c'];

  it('accepts a complete permutation', () => {
    expect(validateTableOrder(['c', 'a', 'b'], valid)).toEqual({ ok: true });
  });

  it('rejects an unknown team', () => {
    expect(validateTableOrder(['a', 'b', 'z'], valid)).toEqual({ ok: false, reason: 'unknown-team' });
  });

  // Both of these would let a user quietly stack the table.
  it('rejects a duplicate', () => {
    expect(validateTableOrder(['a', 'a', 'b'], valid)).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('rejects a partial table', () => {
    expect(validateTableOrder(['a', 'b'], valid)).toEqual({ ok: false, reason: 'incomplete' });
  });
});
