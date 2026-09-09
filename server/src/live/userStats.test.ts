import { describe, expect, it } from 'vitest';
import {
  almostCard,
  buildLiveUserStats,
  nationalityGoalsCard,
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

/**
 * One scored prediction: who made it, what they said and what happened. `scored` is
 * shorthand for "predicted 2-1, actual 3-1" — the two pairs a tally is made from.
 */
const scored = (
  userId: string,
  [predictedHome, predictedAway]: [number, number],
  [actualHome, actualAway]: [number, number],
) => ({
  userId,
  username: userId === 'u1' ? 'Alice' : userId === 'u2' ? 'Bob' : 'Chris',
  imageUrl: userId === 'u1' ? '/api/images/alice.png' : null,
  iconColor: userId === 'u1' ? null : '#334155',
  predictedHome,
  predictedAway,
  actualHome,
  actualAway,
});

const snapshot = (
  byNationality: Record<string, { goals: number; players: number }>,
  truncated = false,
) => ({ fetchedAt: '2026-09-02T10:00:00.000Z', count: 400, truncated, byNationality });

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

describe('almostCard', () => {
  it('names the member with the most right margins and the fewest right scorelines', () => {
    const card = almostCard(
      [
        // Alice: three right margins, one of them the scoreline itself.
        scored('u1', [2, 1], [3, 2]),
        scored('u1', [1, 1], [2, 2]),
        scored('u1', [0, 2], [0, 2]),
        // Bob: two right margins, and the rest of his predictions nowhere near.
        scored('u2', [1, 0], [2, 1]),
        scored('u2', [3, 1], [1, 0]),
        scored('u2', [0, 0], [4, 1]),
      ],
      'en',
    );
    expect(card?.title).toBe('Almost');
    expect(card?.statistic).toBe(
      '**Alice** has the goal difference right in **3** matches, with only **1** exact scoreline.',
    );
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u1', name: 'Alice', imageUrl: '/api/images/alice.png', iconColor: null },
    ]);
    expect(card?.linkType).toBeNull();
  });

  it('separates members level on margins by who hit the fewest scorelines', () => {
    const card = almostCard(
      [
        scored('u1', [2, 1], [2, 1]),
        scored('u1', [1, 0], [3, 2]),
        scored('u2', [1, 1], [2, 2]),
        scored('u2', [0, 1], [1, 2]),
      ],
      'en',
    );
    expect(card?.statistic).toBe(
      '**Bob** has the goal difference right in **2** matches, without a single exact scoreline.',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u2']);
  });

  it('never lets a smaller pile of margins win on scorelines alone', () => {
    const card = almostCard(
      [
        // Chris has one more right margin than Bob, though he also hit two scorelines.
        scored('u3', [1, 0], [1, 0]),
        scored('u3', [2, 1], [2, 1]),
        scored('u3', [0, 1], [1, 2]),
        scored('u2', [1, 1], [3, 3]),
        scored('u2', [2, 0], [3, 1]),
      ],
      'en',
    );
    expect(card?.statistic).toBe(
      '**Chris** has the goal difference right in **3** matches, with only **2** exact scorelines.',
    );
  });

  it('shows every member of a tie, by name, and pictures them all', () => {
    const card = almostCard(
      [scored('u2', [1, 1], [2, 2]), scored('u1', [1, 0], [2, 1])],
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice and Bob** each have the goal difference right in **1** match, without a single exact scoreline.',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u1', 'u2']);
  });

  it('says "each" on both counts when a tie has hit scorelines too', () => {
    const card = almostCard(
      [
        scored('u1', [1, 0], [1, 0]),
        scored('u1', [2, 0], [3, 1]),
        scored('u2', [1, 1], [1, 1]),
        scored('u2', [0, 2], [1, 3]),
      ],
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice and Bob** each have the goal difference right in **2** matches, with only **1** exact scoreline each.',
    );
  });

  it('carries the member colour so a member with no picture still has a tile', () => {
    const card = almostCard([scored('u2', [1, 1], [2, 2])], 'en');
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u2', name: 'Bob', imageUrl: null, iconColor: '#334155' },
    ]);
  });

  it('is null with no scored predictions, or none with the margin right', () => {
    expect(almostCard([], 'en')).toBeNull();
    expect(almostCard([scored('u1', [2, 0], [0, 1]), scored('u2', [1, 1], [0, 3])], 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [scored('u1', [2, 1], [3, 2]), scored('u1', [1, 1], [1, 1])];
    expect(almostCard(rows, 'no')).toMatchObject({
      title: 'Nesten',
      statistic:
        '**Alice** har rett målforskjell i **2** kamper, men bare **1** eksakt resultat.',
    });
    expect(almostCard(rows, 'de')).toMatchObject({
      title: 'Fast',
      statistic:
        '**Alice** hat in **2** Spielen die Tordifferenz getroffen, aber nur **1** exaktes Ergebnis.',
    });
  });

  it('has plurals and a tie in the other two locales too', () => {
    const tie = [
      scored('u1', [1, 0], [2, 1]),
      scored('u1', [0, 1], [1, 2]),
      scored('u2', [1, 1], [2, 2]),
      scored('u2', [0, 2], [1, 3]),
    ];
    expect(almostCard(tie, 'no')?.statistic).toBe(
      '**Alice og Bob** har rett målforskjell i **2** kamper hver, uten et eneste eksakt resultat.',
    );
    expect(almostCard(tie, 'de')?.statistic).toBe(
      '**Alice und Bob** haben in je **2** Spielen die Tordifferenz getroffen, aber kein einziges exaktes Ergebnis.',
    );

    const many = [
      scored('u1', [1, 0], [1, 0]),
      scored('u1', [2, 2], [2, 2]),
      scored('u1', [0, 1], [1, 2]),
    ];
    expect(almostCard(many, 'no')?.statistic).toBe(
      '**Alice** har rett målforskjell i **3** kamper, men bare **2** eksakte resultater.',
    );
    expect(almostCard(many, 'de')?.statistic).toBe(
      '**Alice** hat in **3** Spielen die Tordifferenz getroffen, aber nur **2** exakte Ergebnisse.',
    );
  });
});

describe('buildLiveUserStats', () => {
  const all = {
    tablePredictions: [pick('u1', 't1', 't3')],
    teams,
    scorerPredictions: [rank('u1', 'p1', 'p3')],
    players,
    scoredPredictions: [],
    scorerNationalities: null,
  };

  it('drops cards that have nothing to say', () => {
    expect(
      buildLiveUserStats(
        {
          tablePredictions: [],
          teams,
          scorerPredictions: [],
          players,
          scoredPredictions: [],
          scorerNationalities: null,
        },
        'en',
      ),
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

  it('puts the member card after the two pairs and before the nationality one', () => {
    expect(
      buildLiveUserStats(
        {
          ...all,
          scoredPredictions: [scored('u1', [1, 0], [2, 1])],
          scorerNationalities: snapshot({ Norway: { goals: 3, players: 2 } }),
        },
        'en',
      ).map(c => c.id),
    ).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
      'goldenBoot',
      'goalDrought',
      'almost',
      'norwegianGoals',
    ]);
  });

  it('carries no emoji or icon field for the live card to key off', () => {
    for (const c of buildLiveUserStats(all, 'en')) {
      expect(c.iconImageUrl).toBeUndefined();
      expect(c.linkType).toBeNull();
    }
  });
});

describe('nationalityGoalsCard', () => {
  it('counts the goals and the players behind them', () => {
    const card = nationalityGoalsCard(
      snapshot({ Norway: { goals: 23, players: 7 }, Spain: { goals: 40, players: 12 } }),
      'en',
    );
    expect(card?.title).toBe('Norwegian goals');
    expect(card?.statistic).toBe(
      '**23** goals in this tournament have been scored by Norwegians — **7** different players.',
    );
    expect(card?.subjects).toEqual([
      { type: 'team', id: 'Norway', name: 'Norway', imageUrl: '/stat-flag-no.webp' },
    ]);
  });

  it('matches the country key whatever case the provider sends', () => {
    expect(nationalityGoalsCard(snapshot({ NORWAY: { goals: 5, players: 2 } }), 'en')).not.toBeNull();
    expect(nationalityGoalsCard(snapshot({ norway: { goals: 5, players: 2 } }), 'en')).not.toBeNull();
  });

  it('says "at least" when the feed was truncated, because the total is a floor', () => {
    const rows = { Norway: { goals: 23, players: 7 } };
    expect(nationalityGoalsCard(snapshot(rows, true), 'en')?.statistic).toBe(
      'Norwegians have scored **at least 23** goals in this tournament — **7** different players.',
    );
    expect(nationalityGoalsCard(snapshot(rows, true), 'no')?.statistic).toBe(
      'Nordmenn har scoret **minst 23** mål i turneringen, fordelt på **7** spillere.',
    );
    expect(nationalityGoalsCard(snapshot(rows, true), 'de')?.statistic).toContain('**mindestens 23**');
  });

  it('uses the singular for one player', () => {
    const one = snapshot({ Norway: { goals: 9, players: 1 } });
    expect(nationalityGoalsCard(one, 'en')?.statistic).toBe(
      '**9** goals in this tournament have been scored by Norwegians — **1** player.',
    );
    expect(nationalityGoalsCard(one, 'no')?.statistic).toBe(
      '**9** mål i turneringen er scoret av nordmenn, av **1** spiller.',
    );
  });

  it('translates the title and the statistic', () => {
    const rows = snapshot({ Norway: { goals: 23, players: 7 } });
    expect(nationalityGoalsCard(rows, 'no')).toMatchObject({
      title: 'Norske mål',
      statistic: '**23** mål i turneringen er scoret av nordmenn, fordelt på **7** spillere.',
    });
    expect(nationalityGoalsCard(rows, 'de')).toMatchObject({
      title: 'Norwegische Tore',
      statistic:
        '**23** Tore in diesem Wettbewerb gehen auf das Konto von Norwegern — **7** verschiedene Spieler.',
    });
  });

  it('is null without a snapshot, without Norway, or on nothing scored', () => {
    expect(nationalityGoalsCard(null, 'en')).toBeNull();
    expect(nationalityGoalsCard(snapshot({}), 'en')).toBeNull();
    expect(nationalityGoalsCard(snapshot({ Spain: { goals: 40, players: 12 } }), 'en')).toBeNull();
    expect(nationalityGoalsCard(snapshot({ Norway: { goals: 0, players: 3 } }), 'en')).toBeNull();
  });

  it('joins the deck last, and only when it has something to say', () => {
    const base = {
      tablePredictions: [pick('u1', 't1', 't3')],
      teams,
      scorerPredictions: [rank('u1', 'p1', 'p3')],
      players,
      scoredPredictions: [],
    };
    expect(buildLiveUserStats({ ...base, scorerNationalities: null }, 'en').map(c => c.id)).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
      'goldenBoot',
      'goalDrought',
    ]);
    expect(
      buildLiveUserStats(
        { ...base, scorerNationalities: snapshot({ Norway: { goals: 3, players: 2 } }) },
        'en',
      ).map(c => c.id),
    ).toEqual(['peoplesFavourite', 'woodenSpoon', 'goldenBoot', 'goalDrought', 'norwegianGoals']);
  });

  it('shows on its own when nobody has predicted anything yet', () => {
    expect(
      buildLiveUserStats(
        {
          tablePredictions: [],
          teams,
          scorerPredictions: [],
          players,
          scoredPredictions: [],
          scorerNationalities: snapshot({ Norway: { goals: 3, players: 2 } }),
        },
        'en',
      ).map(c => c.id),
    ).toEqual(['norwegianGoals']);
  });
});
