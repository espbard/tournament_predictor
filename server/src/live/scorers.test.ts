import { describe, expect, it } from 'vitest';
import { matchSquadPlayers, normaliseLivePlayerName } from './scorers';
import { mapScorer, mapSquads } from './providers/footballData';

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

describe('matchSquadPlayers', () => {
  const squad = (name: string, id = name) => ({
    providerPlayerId: id,
    name,
    providerTeamId: '1',
    position: null,
  });

  const squads = [
    squad('Kylian Mbappé'),
    squad('Erling Haaland'),
    squad('Jude Bellingham'),
    squad('Bellingham Jobe', 'jobe'),
    squad('Federico Valverde'),
  ];

  it('finds a player through accents and case', () => {
    // The whole point of folding: nobody types the accent.
    expect(matchSquadPlayers(squads, normaliseLivePlayerName('mbappe')).map(p => p.name)).toEqual([
      'Kylian Mbappé',
    ]);
    expect(matchSquadPlayers(squads, normaliseLivePlayerName('MBAPPÉ')).map(p => p.name)).toEqual([
      'Kylian Mbappé',
    ]);
  });

  it('matches a surname in the middle of a name', () => {
    expect(
      matchSquadPlayers(squads, normaliseLivePlayerName('haaland')).map(p => p.name),
    ).toEqual(['Erling Haaland']);
  });

  it('puts a name that starts with the query above one that merely contains it', () => {
    // Typing a surname should surface the player it starts with first.
    expect(
      matchSquadPlayers(squads, normaliseLivePlayerName('bellingham')).map(p => p.name),
    ).toEqual(['Bellingham Jobe', 'Jude Bellingham']);
  });

  it('returns nothing for an empty needle rather than the whole competition', () => {
    expect(matchSquadPlayers(squads, '')).toEqual([]);
  });

  it('caps the number of hits', () => {
    const many = Array.from({ length: 40 }, (_, i) => squad(`Player ${i}`, String(i)));
    expect(matchSquadPlayers(many, 'player', 25)).toHaveLength(25);
  });

  it('finds nobody when nobody matches', () => {
    expect(matchSquadPlayers(squads, normaliseLivePlayerName('zzz'))).toEqual([]);
  });
});

describe('mapSquads', () => {
  it('flattens every club\u2019s squad, tagging each player with their club', () => {
    expect(
      mapSquads({
        teams: [
          {
            id: 86,
            name: 'Real Madrid CF',
            squad: [
              { id: 44, name: 'Kylian Mbappé', position: 'Centre-Forward' },
              { id: 45, name: 'Thibaut Courtois', position: 'Goalkeeper' },
            ],
          },
          { id: 81, name: 'FC Barcelona', squad: [{ id: 7, name: 'Lamine Yamal', position: 'Right Winger' }] },
        ],
      }),
    ).toEqual([
      { providerPlayerId: '44', name: 'Kylian Mbappé', providerTeamId: '86', position: 'Centre-Forward' },
      { providerPlayerId: '45', name: 'Thibaut Courtois', providerTeamId: '86', position: 'Goalkeeper' },
      { providerPlayerId: '7', name: 'Lamine Yamal', providerTeamId: '81', position: 'Right Winger' },
    ]);
  });

  it('is the source that works before anybody has scored', () => {
    // The point of reading squads at all: every player is here from day one, where the
    // scorers list is empty until a goal goes in.
    const squads = mapSquads({ teams: [{ id: 1, squad: [{ id: 9, name: 'Striker' }] }] });
    expect(squads).toHaveLength(1);
    expect(squads[0]).toMatchObject({ providerPlayerId: '9', position: null });
  });

  it('skips a club with no squad, and entries with no id or name', () => {
    expect(
      mapSquads({
        teams: [
          { id: 1 },
          { id: 2, squad: [] },
          { id: 3, squad: [{ name: 'No id' }, { id: 5 }, { id: 6, name: '  ' }] },
          { squad: [{ id: 7, name: 'No club' }] },
        ],
      }),
    ).toEqual([]);
  });

  it('returns nothing for a payload with no teams at all', () => {
    expect(mapSquads({})).toEqual([]);
    expect(mapSquads(null)).toEqual([]);
  });
});
