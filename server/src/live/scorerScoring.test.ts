import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SCORING_CONFIG, type LiveScoringConfig } from '@tournament-predictor/shared';
import {
  calculateScorerPoints,
  liveScorerPositions,
  rankLiveScorers,
  type RankableLivePlayer,
} from './scorerScoring';

const CONFIG = DEFAULT_LIVE_SCORING_CONFIG;

const player = (
  id: string,
  name: string,
  goals: number,
  assists = 0,
): RankableLivePlayer => ({ id, name, goals, assists });

describe('rankLiveScorers', () => {
  it('ranks by goals, most first', () => {
    const ranked = rankLiveScorers([
      player('a', 'Alvarez', 4),
      player('b', 'Bellingham', 9),
      player('c', 'Camavinga', 6),
    ]);
    expect(ranked.map(p => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a tie on goals with assists', () => {
    const ranked = rankLiveScorers([
      player('a', 'Alvarez', 9, 2),
      player('b', 'Bellingham', 9, 5),
    ]);
    expect(ranked.map(p => p.id)).toEqual(['b', 'a']);
  });

  it('breaks a tie on goals and assists with the name', () => {
    const ranked = rankLiveScorers([
      player('z', 'Zirkzee', 9, 3),
      player('a', 'Alvarez', 9, 3),
    ]);
    expect(ranked.map(p => p.id)).toEqual(['a', 'z']);
  });

  it('orders names the same way whatever the locale', () => {
    // localeCompare would order these by the host's collation. The comparison here is
    // plain and case-folded, so the ranking is identical everywhere it runs.
    const ranked = rankLiveScorers([
      player('b', 'ödegaard', 7),
      player('a', 'Alvarez', 7),
    ]);
    expect(ranked.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('is total even for two identically named players on identical numbers', () => {
    const ranked = rankLiveScorers([player('b', 'Silva', 5, 1), player('a', 'Silva', 5, 1)]);
    expect(ranked.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the list it is given', () => {
    const players = [player('a', 'Alvarez', 4), player('b', 'Bellingham', 9)];
    rankLiveScorers(players);
    expect(players.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('gives every position to exactly one player, ties included', () => {
    const positions = liveScorerPositions([
      player('a', 'Alvarez', 9, 1),
      player('b', 'Bellingham', 9, 1),
      player('c', 'Camavinga', 9, 1),
    ]);
    expect([...positions.values()].sort()).toEqual([1, 2, 3]);
  });
});

describe('calculateScorerPoints', () => {
  const actual = liveScorerPositions([
    player('a', 'Alvarez', 12),
    player('b', 'Bellingham', 9),
    player('c', 'Camavinga', 6),
  ]);

  it('awards the configured points per exactly right position', () => {
    const result = calculateScorerPoints(['a', 'b', 'c'], actual, CONFIG);
    expect(result.points).toBe(6);
    expect(result.exactPositionPoints).toBe(6);
    expect(result.players.every(p => p.exactPosition)).toBe(true);
  });

  it('awards nothing for a player in the wrong place', () => {
    const result = calculateScorerPoints(['c', 'b', 'a'], actual, CONFIG);
    // Only the middle player lands where they finished.
    expect(result.points).toBe(2);
    expect(result.players.map(p => p.exactPosition)).toEqual([false, true, false]);
  });

  it('reports where each player actually finished', () => {
    const result = calculateScorerPoints(['b', 'a', 'c'], actual, CONFIG);
    expect(result.players).toEqual([
      { playerId: 'b', predictedPosition: 1, actualPosition: 2, exactPosition: false, points: 0 },
      { playerId: 'a', predictedPosition: 2, actualPosition: 1, exactPosition: false, points: 0 },
      { playerId: 'c', predictedPosition: 3, actualPosition: 3, exactPosition: true, points: 2 },
    ]);
  });

  it('scores nothing for a player who left the shortlist, without disturbing the rest', () => {
    const result = calculateScorerPoints(['gone', 'b', 'c'], actual, CONFIG);
    expect(result.players[0]).toEqual({
      playerId: 'gone',
      predictedPosition: 1,
      actualPosition: null,
      exactPosition: false,
      points: 0,
    });
    expect(result.points).toBe(4);
  });

  it('honours a custom points value', () => {
    const custom: LiveScoringConfig = { ...CONFIG, scorer_exact_position: 5 };
    expect(calculateScorerPoints(['a', 'b', 'c'], actual, custom).points).toBe(15);
  });

  it('returns nothing for an empty ranking', () => {
    expect(calculateScorerPoints([], actual, CONFIG)).toEqual({
      points: 0,
      exactPositionPoints: 0,
      players: [],
    });
  });
});
