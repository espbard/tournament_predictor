import { describe, expect, it } from 'vitest';
import { buildLiveUserStats, peoplesFavouriteCard, woodenSpoonCard } from './userStats';

const teams = [
  { id: 't1', name: 'Bayern', crestUrl: '/api/images/bayern.png' },
  { id: 't2', name: 'Arsenal', crestUrl: '/api/images/arsenal.png' },
  { id: 't3', name: 'Barcelona', crestUrl: null },
];

const pick = (userId: string, ...orderedTeamIds: string[]) => ({ userId, orderedTeamIds });

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

describe('buildLiveUserStats', () => {
  it('drops cards that have nothing to say', () => {
    expect(buildLiveUserStats([], teams, 'en')).toEqual([]);
  });

  it('returns the pair, favourite first', () => {
    expect(buildLiveUserStats([pick('u1', 't1', 't3')], teams, 'en').map(c => c.id)).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
    ]);
  });

  it('carries no emoji or icon field for the live card to key off', () => {
    for (const c of buildLiveUserStats([pick('u1', 't1', 't3')], teams, 'en')) {
      expect(c.iconImageUrl).toBeUndefined();
      expect(c.linkType).toBeNull();
    }
  });
});
