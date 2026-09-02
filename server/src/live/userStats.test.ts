import { describe, expect, it } from 'vitest';
import {
  buildLiveUserStats,
  goalDroughtCard,
  goldenBootCard,
  peoplesFavouriteCard,
  woodenSpoonCard,
} from './userStats';

const teams = [
  { id: 't1', name: 'Bayern', crestUrl: '/api/images/bayern.png' },
  { id: 't2', name: 'Arsenal', crestUrl: '/api/images/arsenal.png' },
  { id: 't3', name: 'Barcelona', crestUrl: null },
];

const pick = (userId: string, ...orderedTeamIds: string[]) => ({ userId, orderedTeamIds });

const players = [
  { id: 'p1', name: 'Haaland', imageUrl: '/api/images/haaland.png' },
  { id: 'p2', name: 'Kane', imageUrl: null },
  { id: 'p3', name: 'Mbappé', imageUrl: '/api/images/mbappe.png' },
];

const rank = (userId: string, ...orderedPlayerIds: string[]) => ({ userId, orderedPlayerIds });

describe('peoplesFavouriteCard', () => {
  it('counts only the team in first place', () => {
    const card = peoplesFavouriteCard(
      [pick('u1', 't1', 't2'), pick('u2', 't2', 't1'), pick('u3', 't1', 't3')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe('**Bayern** tops the table in **2** of **3** predictions.');
    expect(card?.subjects).toEqual([
      { type: 'team', id: 't1', name: 'Bayern', imageUrl: '/api/images/bayern.png' },
    ]);
  });

  it('shows every team of a tie, by name, and drops the icon', () => {
    const card = peoplesFavouriteCard([pick('u1', 't1'), pick('u2', 't2')], teams, 'en');
    expect(card?.statistic).toBe('**Arsenal and Bayern** each top the table in **1** of **2** predictions.');
    expect(card?.subjects.map(s => s.id)).toEqual(['t2', 't1']);
  });

  it('joins three tied names with commas', () => {
    const card = peoplesFavouriteCard(
      [pick('u1', 't1'), pick('u2', 't2'), pick('u3', 't3')],
      teams,
      'en',
    );
    expect(card?.statistic).toContain('**Arsenal, Barcelona and Bayern**');
  });

  it('leaves a prediction led by a dropped team out of both halves of the count', () => {
    const card = peoplesFavouriteCard(
      [pick('u1', 't1'), pick('u2', 'gone'), pick('u3', 't1')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe('**Bayern** tops the table in **2** of **2** predictions.');
  });

  it('is null with no predictions, an empty order, or only dropped teams', () => {
    expect(peoplesFavouriteCard([], teams, 'en')).toBeNull();
    expect(peoplesFavouriteCard([pick('u1')], teams, 'en')).toBeNull();
    expect(peoplesFavouriteCard([pick('u1', 'gone')], teams, 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [pick('u1', 't1'), pick('u2', 't1')];
    expect(peoplesFavouriteCard(rows, teams, 'no')).toMatchObject({
      title: 'Folkefavoritten',
      statistic: '**Bayern** er tippet øverst på tabellen i **2** av **2** tabelltips.',
    });
    expect(peoplesFavouriteCard(rows, teams, 'de')).toMatchObject({
      title: 'Der Publikumsliebling',
      statistic: '**Bayern** steht in **2** von **2** Tabellentipps ganz oben.',
    });
    expect(peoplesFavouriteCard(rows, teams, 'en')?.title).toBe("The people's favourite");
  });

  it('uses the locale conjunction for a tie', () => {
    const rows = [pick('u1', 't1'), pick('u2', 't2')];
    expect(peoplesFavouriteCard(rows, teams, 'no')?.statistic).toContain('Arsenal og Bayern');
    expect(peoplesFavouriteCard(rows, teams, 'de')?.statistic).toContain('Arsenal und Bayern');
  });
});

describe('woodenSpoonCard', () => {
  it('counts only the team in last place', () => {
    const card = woodenSpoonCard(
      [pick('u1', 't1', 't2', 't3'), pick('u2', 't2', 't1', 't3'), pick('u3', 't1', 't3', 't2')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe('**Barcelona** finishes bottom in **2** of **3** predictions.');
    expect(card?.subjects.map(s => s.id)).toEqual(['t3']);
  });

  it('shows every team of a tie', () => {
    const card = woodenSpoonCard([pick('u1', 't1', 't3'), pick('u2', 't3', 't2')], teams, 'en');
    expect(card?.statistic).toBe('**Arsenal and Barcelona** each finish bottom in **1** of **2** predictions.');
  });

  it('counts the same team at both ends of a one-team order', () => {
    expect(peoplesFavouriteCard([pick('u1', 't1')], teams, 'en')?.subjects[0].id).toBe('t1');
    expect(woodenSpoonCard([pick('u1', 't1')], teams, 'en')?.subjects[0].id).toBe('t1');
  });

  it('leaves a prediction ending on a dropped team out of both halves of the count', () => {
    const card = woodenSpoonCard(
      [pick('u1', 't1', 't3'), pick('u2', 't1', 'gone'), pick('u3', 't2', 't3')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe('**Barcelona** finishes bottom in **2** of **2** predictions.');
  });

  it('is null with no predictions or only dropped teams', () => {
    expect(woodenSpoonCard([], teams, 'en')).toBeNull();
    expect(woodenSpoonCard([pick('u1')], teams, 'en')).toBeNull();
    expect(woodenSpoonCard([pick('u1', 'gone')], teams, 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [pick('u1', 't1', 't3'), pick('u2', 't2', 't3')];
    expect(woodenSpoonCard(rows, teams, 'no')).toMatchObject({
      title: 'Bunnfavoritten',
      statistic: '**Barcelona** er tippet sist i **2** av **2** tabelltips.',
    });
    expect(woodenSpoonCard(rows, teams, 'de')).toMatchObject({
      title: 'Das Schlusslicht',
      statistic: '**Barcelona** steht in **2** von **2** Tabellentipps ganz unten.',
    });
    expect(woodenSpoonCard(rows, teams, 'en')?.title).toBe('The wooden spoon');
  });
});

describe('goldenBootCard', () => {
  it('counts only the player in first place', () => {
    const card = goldenBootCard(
      [rank('u1', 'p1', 'p2'), rank('u2', 'p2', 'p1'), rank('u3', 'p1', 'p3')],
      players,
      'en',
    );
    expect(card?.statistic).toBe('**Haaland** tops the scorer list in **2** of **3** rankings.');
    expect(card?.subjects).toEqual([
      { type: 'player', id: 'p1', name: 'Haaland', imageUrl: '/api/images/haaland.png' },
    ]);
  });

  it('carries a null image through rather than inventing one', () => {
    const card = goldenBootCard([rank('u1', 'p2', 'p1')], players, 'en');
    expect(card?.subjects[0]).toMatchObject({ id: 'p2', imageUrl: null });
  });

  it('shows every player of a tie, by name', () => {
    const card = goldenBootCard([rank('u1', 'p1'), rank('u2', 'p3')], players, 'en');
    expect(card?.statistic).toBe(
      '**Haaland and Mbappé** each top the scorer list in **1** of **2** rankings.',
    );
  });

  it('translates the title and the statistic', () => {
    const rows = [rank('u1', 'p1', 'p2'), rank('u2', 'p1', 'p3')];
    expect(goldenBootCard(rows, players, 'no')).toMatchObject({
      title: 'Gullstøvelen',
      statistic: '**Haaland** er tippet øverst på toppscorerlisten i **2** av **2** lister.',
    });
    expect(goldenBootCard(rows, players, 'de')).toMatchObject({
      title: 'Der Goldene Schuh',
      statistic: '**Haaland** steht in **2** von **2** Torjägerlisten ganz oben.',
    });
    expect(goldenBootCard(rows, players, 'en')?.title).toBe('The golden boot');
  });

  it('is null with no rankings or only dropped players', () => {
    expect(goldenBootCard([], players, 'en')).toBeNull();
    expect(goldenBootCard([rank('u1')], players, 'en')).toBeNull();
    expect(goldenBootCard([rank('u1', 'gone')], players, 'en')).toBeNull();
  });
});

describe('goalDroughtCard', () => {
  it('counts only the player in last place', () => {
    const card = goalDroughtCard(
      [rank('u1', 'p1', 'p2', 'p3'), rank('u2', 'p2', 'p1', 'p3'), rank('u3', 'p1', 'p3', 'p2')],
      players,
      'en',
    );
    expect(card?.statistic).toBe(
      '**Mbappé** finishes last on the scorer list in **2** of **3** rankings.',
    );
  });

  it('leaves a ranking ending on a dropped player out of both halves of the count', () => {
    const card = goalDroughtCard(
      [rank('u1', 'p1', 'p3'), rank('u2', 'p1', 'gone'), rank('u3', 'p2', 'p3')],
      players,
      'en',
    );
    expect(card?.statistic).toBe(
      '**Mbappé** finishes last on the scorer list in **2** of **2** rankings.',
    );
  });

  it('translates the title and the statistic', () => {
    const rows = [rank('u1', 'p1', 'p3'), rank('u2', 'p2', 'p3')];
    expect(goalDroughtCard(rows, players, 'no')).toMatchObject({
      title: 'Måltørken',
      statistic: '**Mbappé** er tippet sist på toppscorerlisten i **2** av **2** lister.',
    });
    expect(goalDroughtCard(rows, players, 'de')).toMatchObject({
      title: 'Die Torflaute',
      statistic: '**Mbappé** steht in **2** von **2** Torjägerlisten ganz unten.',
    });
    expect(goalDroughtCard(rows, players, 'en')?.title).toBe('The goal drought');
  });

  it('is null with no rankings', () => {
    expect(goalDroughtCard([], players, 'en')).toBeNull();
  });
});

describe('buildLiveUserStats', () => {
  const all = {
    tablePredictions: [pick('u1', 't1', 't3')],
    teams,
    scorerPredictions: [rank('u1', 'p1', 'p3')],
    players,
  };

  it('drops cards that have nothing to say', () => {
    expect(
      buildLiveUserStats({ tablePredictions: [], teams, scorerPredictions: [], players }, 'en'),
    ).toEqual([]);
  });

  it('returns the two pairs, table first, top before bottom in each', () => {
    expect(buildLiveUserStats(all, 'en').map(c => c.id)).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
      'goldenBoot',
      'goalDrought',
    ]);
  });

  it('shows the scorer pair on its own when nobody has predicted a table', () => {
    expect(
      buildLiveUserStats({ ...all, tablePredictions: [] }, 'en').map(c => c.id),
    ).toEqual(['goldenBoot', 'goalDrought']);
  });

  it('shows the table pair on its own when nobody has ranked the scorers', () => {
    expect(
      buildLiveUserStats({ ...all, scorerPredictions: [] }, 'en').map(c => c.id),
    ).toEqual(['peoplesFavourite', 'woodenSpoon']);
  });

  it('carries no emoji or icon field for the live card to key off', () => {
    for (const c of buildLiveUserStats(all, 'en')) {
      expect(c.iconImageUrl).toBeUndefined();
      expect(c.linkType).toBeNull();
    }
  });
});
