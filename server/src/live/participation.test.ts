import { describe, expect, it } from 'vitest';
import { filterLiveParticipants, type LiveParticipation } from './participation';

const MEMBERS = [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }];

function participation(overrides: Partial<LiveParticipation> = {}): LiveParticipation {
  return { hasCompletedFixtures: true, participantIds: new Set(['u1']), ...overrides };
}

describe('filterLiveParticipants', () => {
  it('keeps everybody while nothing has been played', () => {
    expect(filterLiveParticipants(MEMBERS, participation({ hasCompletedFixtures: false }))).toEqual(
      MEMBERS,
    );
  });

  it('drops members who have never predicted a fixture once a match is behind', () => {
    expect(filterLiveParticipants(MEMBERS, participation())).toEqual([{ userId: 'u1' }]);
  });

  it('keeps every member who has predicted a fixture', () => {
    const kept = filterLiveParticipants(
      MEMBERS,
      participation({ participantIds: new Set(['u1', 'u3']) }),
    );
    expect(kept).toEqual([{ userId: 'u1' }, { userId: 'u3' }]);
  });

  it('preserves the order it was given', () => {
    const ordered = [{ userId: 'u3' }, { userId: 'u1' }];
    expect(
      filterLiveParticipants(ordered, participation({ participantIds: new Set(['u1', 'u3']) })),
    ).toEqual(ordered);
  });

  it('falls back to the full roster rather than showing nobody', () => {
    expect(filterLiveParticipants(MEMBERS, participation({ participantIds: new Set() }))).toEqual(
      MEMBERS,
    );
  });
});
