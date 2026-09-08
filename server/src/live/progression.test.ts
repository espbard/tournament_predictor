import { describe, expect, it } from 'vitest';
import {
  buildLiveProgression,
  liveFixtureLabel,
  type LiveProgressionFixture,
  type LiveProgressionInput,
  type LiveProgressionTeam,
} from './progression';

const ARS: LiveProgressionTeam = { id: 'ars', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' };
const CHE: LiveProgressionTeam = { id: 'che', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' };
const TEAMS = [ARS, CHE];

function fixture(overrides: Partial<LiveProgressionFixture> & { id: string }): LiveProgressionFixture {
  return {
    kickoffAt: '2026-08-15T14:00:00Z',
    status: 'finished',
    stageKey: 'regular_season',
    matchday: 1,
    homeTeamId: ARS.id,
    awayTeamId: CHE.id,
    isSelected: true,
    ...overrides,
  };
}

function input(overrides: Partial<LiveProgressionInput> = {}): LiveProgressionInput {
  return {
    members: [
      { userId: 'u1', username: 'Ada', imageUrl: null, iconColor: null },
      { userId: 'u2', username: 'Bo', imageUrl: null, iconColor: null },
    ],
    teams: TEAMS,
    fixtures: [],
    predictions: [],
    tablePoints: [],
    scorerPoints: [],
    bonusPoints: [],
    ...overrides,
  };
}

describe('liveFixtureLabel', () => {
  const teamsById = new Map(TEAMS.map(t => [t.id, t]));

  it('uses the three-letter codes of both teams', () => {
    expect(liveFixtureLabel(fixture({ id: 'f1' }), teamsById)).toBe('ARS vs CHE');
  });

  it('falls back to the short name, then the name, when there is no code', () => {
    const short = new Map([['a', { id: 'a', name: 'Aberdeen', shortName: 'Dons', tla: null }]]);
    expect(
      liveFixtureLabel(fixture({ id: 'f1', homeTeamId: 'a', awayTeamId: null }), short),
    ).toBe('DON vs ?');
    const long = new Map([['a', { id: 'a', name: 'Aberdeen', shortName: null, tla: null }]]);
    expect(
      liveFixtureLabel(fixture({ id: 'f1', homeTeamId: 'a', awayTeamId: null }), long),
    ).toBe('ABE vs ?');
  });

  it('falls back to the matchday when neither team is known', () => {
    expect(
      liveFixtureLabel(
        fixture({ id: 'f1', homeTeamId: null, awayTeamId: null, matchday: 7 }),
        teamsById,
      ),
    ).toBe('MD 7');
  });
});

describe('buildLiveProgression — fixtures', () => {
  it('has no milestones before anything has been played', () => {
    const result = buildLiveProgression(input());
    expect(result.matches).toEqual([]);
    expect(result.users.map(u => u.userId)).toEqual(['u1', 'u2']);
  });

  it('accumulates each member’s points in kickoff order', () => {
    const result = buildLiveProgression(
      input({
        fixtures: [
          fixture({ id: 'f2', kickoffAt: '2026-08-22T14:00:00Z' }),
          fixture({ id: 'f1', kickoffAt: '2026-08-15T14:00:00Z' }),
        ],
        predictions: [
          { userId: 'u1', liveFixtureId: 'f1', points: 4 },
          { userId: 'u2', liveFixtureId: 'f1', points: 1 },
          { userId: 'u1', liveFixtureId: 'f2', points: 2 },
        ],
      }),
    );

    expect(result.matches.map(m => m.matchId)).toEqual(['f1', 'f2']);
    expect(result.matches[0].cumulativePoints).toEqual({ u1: 4, u2: 1 });
    expect(result.matches[1].cumulativePoints).toEqual({ u1: 6, u2: 1 });
    expect(result.matches[0].label).toBe('ARS vs CHE');
    expect(result.matches[0].stage).toBe('regular_season');
  });

  it('puts an undated fixture last and breaks a kickoff tie by id', () => {
    const result = buildLiveProgression(
      input({
        fixtures: [
          fixture({ id: 'c', kickoffAt: null }),
          fixture({ id: 'b', kickoffAt: '2026-08-15T14:00:00Z' }),
          fixture({ id: 'a', kickoffAt: '2026-08-15T14:00:00Z' }),
        ],
      }),
    );
    expect(result.matches.map(m => m.matchId)).toEqual(['a', 'b', 'c']);
  });

  it('skips a fixture that has not finished', () => {
    const result = buildLiveProgression(
      input({
        fixtures: [
          fixture({ id: 'f1' }),
          fixture({ id: 'f2', status: 'in_play', kickoffAt: '2026-08-22T14:00:00Z' }),
          fixture({ id: 'f3', status: 'postponed', kickoffAt: '2026-08-29T14:00:00Z' }),
        ],
      }),
    );
    expect(result.matches.map(m => m.matchId)).toEqual(['f1']);
  });

  it('keeps a scored fixture the provider has moved back out of finished', () => {
    const result = buildLiveProgression(
      input({
        fixtures: [fixture({ id: 'f1', status: 'suspended' })],
        predictions: [{ userId: 'u1', liveFixtureId: 'f1', points: 4 }],
      }),
    );
    expect(result.matches.map(m => m.matchId)).toEqual(['f1']);
    expect(result.matches[0].cumulativePoints).toEqual({ u1: 4, u2: 0 });
  });

  it('skips a fixture the admin left out of its gameweek', () => {
    const result = buildLiveProgression(
      input({ fixtures: [fixture({ id: 'f1', isSelected: false })] }),
    );
    expect(result.matches).toEqual([]);
  });

  it('keeps a deselected fixture that was already scored, so the chart ends on the leaderboard total', () => {
    const result = buildLiveProgression(
      input({
        fixtures: [fixture({ id: 'f1', isSelected: false })],
        predictions: [{ userId: 'u1', liveFixtureId: 'f1', points: 4 }],
      }),
    );
    expect(result.matches.map(m => m.matchId)).toEqual(['f1']);
    expect(result.matches[0].cumulativePoints).toEqual({ u1: 4, u2: 0 });
  });

  it('ignores unscored predictions and predictions by non-members', () => {
    const result = buildLiveProgression(
      input({
        fixtures: [fixture({ id: 'f1' })],
        predictions: [
          { userId: 'u1', liveFixtureId: 'f1', points: null },
          { userId: 'gone', liveFixtureId: 'f1', points: 4 },
        ],
      }),
    );
    expect(result.matches[0].cumulativePoints).toEqual({ u1: 0, u2: 0 });
  });
});

describe('buildLiveProgression — season-long side bets', () => {
  const played = { fixtures: [fixture({ id: 'f1' })], predictions: [{ userId: 'u1', liveFixtureId: 'f1', points: 4 }] };

  it('adds one milestone per source, after the last fixture', () => {
    const result = buildLiveProgression(
      input({
        ...played,
        tablePoints: [{ userId: 'u1', points: 10 }, { userId: 'u2', points: 6 }],
        scorerPoints: [{ userId: 'u2', points: 3 }],
        bonusPoints: [
          { userId: 'u1', points: 2 },
          { userId: 'u1', points: 1 },
        ],
      }),
    );

    expect(result.matches.map(m => m.matchId)).toEqual(['f1', 'table', 'scorers', 'bonus']);
    expect(result.matches.map(m => m.label)).toEqual(['ARS vs CHE', 'Table', 'Top scorers', 'Bonus']);
    expect(result.matches[1].cumulativePoints).toEqual({ u1: 14, u2: 6 });
    expect(result.matches[2].cumulativePoints).toEqual({ u1: 14, u2: 9 });
    expect(result.matches[3].cumulativePoints).toEqual({ u1: 17, u2: 9 });
  });

  it('leaves out a side bet that has not been scored yet', () => {
    const result = buildLiveProgression(
      input({
        ...played,
        tablePoints: [{ userId: 'u1', points: null }],
        scorerPoints: [{ userId: 'u1', points: 0 }],
        bonusPoints: [],
      }),
    );
    expect(result.matches.map(m => m.matchId)).toEqual(['f1']);
  });

  it('words the side bets in the requested language', () => {
    const result = buildLiveProgression(
      input({ ...played, tablePoints: [{ userId: 'u1', points: 10 }] }),
      'no',
    );
    expect(result.matches.map(m => m.label)).toEqual(['ARS vs CHE', 'Tabell']);
  });
});
