import { describe, expect, it } from 'vitest';
import { LIVE_FORMATS } from '@tournament-predictor/shared';
import {
  assignTieMetadata,
  buildTieKey,
  deriveQualificationStatuses,
  liveWindowDates,
  loserOf,
  type TieAssignable,
} from './sync';

// The sync engine's decision-making, isolated from the database. Everything here is a
// pure function by design, precisely so it can be pinned without a test DB — see the
// plan's note that server/src/db/client.ts connects at import time.

const UCL = LIVE_FORMATS.ucl_swiss;
const PL = LIVE_FORMATS.domestic_league;

function fixture(over: Partial<TieAssignable> = {}): TieAssignable {
  return {
    providerFixtureId: 'f1',
    stageKey: 'quarter_final',
    homeTeamId: 'teamA',
    awayTeamId: 'teamB',
    matchday: 1,
    kickoffAt: null,
    ...over,
  };
}

describe('buildTieKey', () => {
  it('is identical for both legs despite home and away swapping', () => {
    expect(buildTieKey('quarter_final', 'teamA', 'teamB')).toBe(
      buildTieKey('quarter_final', 'teamB', 'teamA'),
    );
  });

  it('separates the same pairing in different stages', () => {
    expect(buildTieKey('semi_final', 'a', 'b')).not.toBe(buildTieKey('final', 'a', 'b'));
  });

  it('returns null when the tie is not yet identifiable', () => {
    expect(buildTieKey('quarter_final', null, 'b')).toBeNull();
    expect(buildTieKey('quarter_final', 'a', null)).toBeNull();
    expect(buildTieKey(null, 'a', 'b')).toBeNull();
  });
});

describe('assignTieMetadata', () => {
  it('uses the provider matchday as the leg number', () => {
    const legs = [
      fixture({ providerFixtureId: 'leg1', matchday: 1 }),
      fixture({ providerFixtureId: 'leg2', matchday: 2, homeTeamId: 'teamB', awayTeamId: 'teamA' }),
    ];
    const out = assignTieMetadata(legs, UCL);

    expect(out.get('leg1')!.legNumber).toBe(1);
    expect(out.get('leg2')!.legNumber).toBe(2);
    expect(out.get('leg1')!.tieKey).toBe(out.get('leg2')!.tieKey);
  });

  // The reason matchday is preferred: two legs can share a kickoff date, which makes
  // ordering by time ambiguous.
  it('gets both legs right even when they share a kickoff time', () => {
    const same = new Date('2027-04-10T19:00:00Z');
    const out = assignTieMetadata(
      [
        fixture({ providerFixtureId: 'leg2', matchday: 2, kickoffAt: same }),
        fixture({ providerFixtureId: 'leg1', matchday: 1, kickoffAt: same }),
      ],
      UCL,
    );
    expect(out.get('leg1')!.legNumber).toBe(1);
    expect(out.get('leg2')!.legNumber).toBe(2);
  });

  it('falls back to kickoff order when matchday is unusable', () => {
    const out = assignTieMetadata(
      [
        fixture({ providerFixtureId: 'later', matchday: null, kickoffAt: new Date('2027-04-17T19:00:00Z') }),
        fixture({ providerFixtureId: 'earlier', matchday: null, kickoffAt: new Date('2027-04-10T19:00:00Z') }),
      ],
      UCL,
    );
    expect(out.get('earlier')!.legNumber).toBe(1);
    expect(out.get('later')!.legNumber).toBe(2);
  });

  it('leaves single-leg stages alone', () => {
    const out = assignTieMetadata([fixture({ stageKey: 'final' })], UCL);
    expect(out.get('f1')).toEqual({ tieKey: null, legNumber: null });
  });

  it('leaves table stages alone', () => {
    const out = assignTieMetadata([fixture({ stageKey: 'regular_season' })], PL);
    expect(out.get('f1')).toEqual({ tieKey: null, legNumber: null });
  });

  it('leaves an undrawn knockout fixture unassigned', () => {
    const out = assignTieMetadata([fixture({ homeTeamId: null, awayTeamId: null })], UCL);
    expect(out.get('f1')).toEqual({ tieKey: null, legNumber: null });
  });

  it('keeps separate ties apart within the same stage', () => {
    const out = assignTieMetadata(
      [
        fixture({ providerFixtureId: 'tie1', homeTeamId: 'a', awayTeamId: 'b' }),
        fixture({ providerFixtureId: 'tie2', homeTeamId: 'c', awayTeamId: 'd' }),
      ],
      UCL,
    );
    expect(out.get('tie1')!.tieKey).not.toBe(out.get('tie2')!.tieKey);
  });

  it('does not treat an unmapped stage as a tie', () => {
    const out = assignTieMetadata([fixture({ stageKey: null })], UCL);
    expect(out.get('f1')).toEqual({ tieKey: null, legNumber: null });
  });
});

describe('deriveQualificationStatuses', () => {
  const base = {
    teamIds: ['a', 'b', 'c'],
    teamIdsInStandings: new Set<string>(),
    teamIdsAtOrAboveStart: new Set<string>(),
    teamIdsEliminatedBelowStart: new Set<string>(),
  };

  it('marks a team in the standings as qualified', () => {
    const out = deriveQualificationStatuses({ ...base, teamIdsInStandings: new Set(['a']) });
    expect(out.get('a')).toBe('qualified');
  });

  it('marks a team appearing at or above the start stage as qualified', () => {
    const out = deriveQualificationStatuses({ ...base, teamIdsAtOrAboveStart: new Set(['b']) });
    expect(out.get('b')).toBe('qualified');
  });

  it('marks a team that lost a qualifying tie as eliminated', () => {
    const out = deriveQualificationStatuses({
      ...base,
      teamIdsEliminatedBelowStart: new Set(['c']),
    });
    expect(out.get('c')).toBe('eliminated');
  });

  it('leaves everything else pending', () => {
    const out = deriveQualificationStatuses(base);
    expect([...out.values()]).toEqual(['pending', 'pending', 'pending']);
  });

  // Qualifying beats elimination: a team can lose a qualifier and still enter through
  // another route, and the standings are the authoritative signal.
  it('prefers qualified over eliminated when both apply', () => {
    const out = deriveQualificationStatuses({
      ...base,
      teamIdsInStandings: new Set(['a']),
      teamIdsEliminatedBelowStart: new Set(['a']),
    });
    expect(out.get('a')).toBe('qualified');
  });

  // The pre-draw Champions League state: nothing published, so nothing is decided.
  it('reports every team as pending before any data arrives', () => {
    const out = deriveQualificationStatuses({ ...base, teamIds: ['x', 'y'] });
    expect(out.get('x')).toBe('pending');
    expect(out.get('y')).toBe('pending');
  });
});

describe('loserOf', () => {
  const decided = { status: 'finished', homeTeamId: 'home', awayTeamId: 'away' };

  it('reads the loser from the provider winner field', () => {
    expect(loserOf({ ...decided, winner: 'HOME_TEAM' })).toBe('away');
    expect(loserOf({ ...decided, winner: 'AWAY_TEAM' })).toBe('home');
  });

  it('has no loser for a draw', () => {
    expect(loserOf({ ...decided, winner: 'DRAW' })).toBeNull();
  });

  it('has no loser before the fixture finishes', () => {
    expect(loserOf({ ...decided, status: 'in_play', winner: 'HOME_TEAM' })).toBeNull();
  });
});

describe('liveWindowDates', () => {
  it('spans yesterday through tomorrow', () => {
    expect(liveWindowDates(new Date('2026-08-21T12:00:00Z'))).toEqual({
      dateFrom: '2026-08-20',
      dateTo: '2026-08-22',
    });
  });

  it('crosses a month boundary correctly', () => {
    expect(liveWindowDates(new Date('2026-09-01T02:00:00Z'))).toEqual({
      dateFrom: '2026-08-31',
      dateTo: '2026-09-02',
    });
  });
});
