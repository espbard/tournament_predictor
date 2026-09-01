import { describe, expect, it } from 'vitest';
import { canSeeLiveScorerRanking } from '@tournament-predictor/shared';
import { normaliseLivePlayerName } from './scorers';
import { mapScorer } from './providers/footballData';

describe('normaliseLivePlayerName', () => {
  it('folds case, accents and punctuation', () => {
    expect(normaliseLivePlayerName('Kylian Mbappé')).toBe('kylian mbappe');
    expect(normaliseLivePlayerName('  KYLIAN  MBAPPE ')).toBe('kylian mbappe');
    expect(normaliseLivePlayerName("N'Golo Kanté")).toBe('n golo kante');
  });

  it('folds letters that survive NFD whole', () => {
    expect(normaliseLivePlayerName('Martin Ødegaard')).toBe('martin odegaard');
    expect(normaliseLivePlayerName('Weiß')).toBe('weiss');
  });

  it('keeps the words of a name that a club normaliser would strip', () => {
    // normaliseTeamName treats "de" as noise. For a person it is part of the name, and
    // dropping it would collide De Bruyne with anyone else named Bruyne.
    expect(normaliseLivePlayerName('Kevin De Bruyne')).toBe('kevin de bruyne');
    expect(normaliseLivePlayerName('Bruyne')).not.toBe(normaliseLivePlayerName('Kevin De Bruyne'));
  });

  it('is empty for nothing at all', () => {
    expect(normaliseLivePlayerName(null)).toBe('');
    expect(normaliseLivePlayerName('   ')).toBe('');
  });
});

describe('mapScorer', () => {
  it('maps a full entry', () => {
    expect(
      mapScorer({
        player: { id: 44, name: 'Kylian Mbappé' },
        team: { id: 86, name: 'Real Madrid CF' },
        goals: 11,
        assists: 3,
      }),
    ).toEqual({
      providerPlayerId: '44',
      name: 'Kylian Mbappé',
      providerTeamId: '86',
      goals: 11,
      assists: 3,
    });
  });

  it('treats a missing assist count as none, so the tie-break falls through to the name', () => {
    const mapped = mapScorer({ player: { id: 7, name: 'Lamine Yamal' }, goals: 4 });
    expect(mapped).toMatchObject({ goals: 4, assists: 0, providerTeamId: null });
  });

  it('drops an entry with no id or no name — neither can be matched or shown', () => {
    expect(mapScorer({ player: { name: 'Nameless' }, goals: 2 })).toBeNull();
    expect(mapScorer({ player: { id: 9, name: '' }, goals: 2 })).toBeNull();
    expect(mapScorer({ goals: 2 })).toBeNull();
  });

  it('never returns a negative or fractional tally', () => {
    const mapped = mapScorer({ player: { id: 1, name: 'A' }, goals: -3, assists: 2.7 });
    expect(mapped).toMatchObject({ goals: 0, assists: 2 });
  });
});

describe('canSeeLiveScorerRanking', () => {
  it('lets test accounts and admins in', () => {
    expect(canSeeLiveScorerRanking({ isAdmin: false, isTestAccount: true })).toBe(true);
    // An admin has to be able to build the shortlist and see what a player will get.
    expect(canSeeLiveScorerRanking({ isAdmin: true, isTestAccount: false })).toBe(true);
  });

  it('keeps everyone else out, signed in or not', () => {
    expect(canSeeLiveScorerRanking({ isAdmin: false, isTestAccount: false })).toBe(false);
    expect(canSeeLiveScorerRanking(null)).toBe(false);
    expect(canSeeLiveScorerRanking(undefined)).toBe(false);
  });
});
