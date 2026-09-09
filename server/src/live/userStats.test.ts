import { describe, expect, it } from 'vitest';
import {
  almostCard,
  bestPredictionCard,
  buildLiveUserStats,
  nationalityGoalsCard,
  goalDroughtCard,
  goldenBootCard,
  peoplesFavouriteCard,
  spotOnCard,
  woodenSpoonCard,
  worstPredictionCard,
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
 * One scored prediction: who made it, what they said, what happened, and — where a test
 * needs more than one match — which fixture it was on. `scored` is shorthand for
 * "predicted 2-1, actual 3-1" on fixture f1.
 */
/** Which teams each test fixture is between. A fixture id not listed here has none yet. */
const fixtureTeams: Record<string, [string, string]> = {
  f1: ['t2', 't1'], // Arsenal vs Bayern
  f2: ['t1', 't3'], // Bayern vs Barcelona
  f3: ['t3', 't2'], // Barcelona vs Arsenal
};

const scored = (
  userId: string,
  [predictedHome, predictedAway]: [number, number],
  [actualHome, actualAway]: [number, number],
  fixtureId = 'f1',
) => ({
  userId,
  username: userId === 'u1' ? 'Alice' : userId === 'u2' ? 'Bob' : 'Chris',
  imageUrl: userId === 'u1' ? '/api/images/alice.png' : null,
  iconColor: userId === 'u1' ? null : '#334155',
  fixtureId,
  homeTeamId: fixtureTeams[fixtureId]?.[0] ?? null,
  awayTeamId: fixtureTeams[fixtureId]?.[1] ?? null,
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

describe('spotOnCard', () => {
  it('names the member with the most exact scorelines, and counts what they made', () => {
    const card = spotOnCard(
      [
        scored('u1', [2, 1], [2, 1]),
        scored('u1', [1, 1], [1, 1]),
        scored('u1', [0, 2], [3, 0]),
        scored('u2', [1, 0], [1, 0]),
        scored('u2', [3, 1], [1, 0]),
      ],
      'en',
    );
    expect(card?.title).toBe('Spot on');
    expect(card?.statistic).toBe(
      '**Alice** has called **2** scorelines exactly, from **3** scored predictions.',
    );
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u1', name: 'Alice', imageUrl: '/api/images/alice.png', iconColor: null },
    ]);
    expect(card?.linkType).toBeNull();
  });

  it('uses the singular for one scoreline and one prediction', () => {
    expect(spotOnCard([scored('u1', [2, 1], [2, 1])], 'en')?.statistic).toBe(
      '**Alice** has called **1** scoreline exactly, from **1** scored prediction.',
    );
  });

  it('shows a tie in full, and drops a denominator that would belong to neither', () => {
    const card = spotOnCard(
      [
        scored('u1', [2, 1], [2, 1]),
        scored('u1', [0, 0], [1, 2]),
        scored('u2', [1, 0], [1, 0]),
      ],
      'en',
    );
    expect(card?.statistic).toBe('**Alice and Bob** have each called **1** scoreline exactly.');
    expect(card?.subjects.map(s => s.id)).toEqual(['u1', 'u2']);
  });

  it('carries the member colour so a member with no picture still has a tile', () => {
    const card = spotOnCard([scored('u2', [1, 1], [1, 1])], 'en');
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u2', name: 'Bob', imageUrl: null, iconColor: '#334155' },
    ]);
  });

  it('is null with no scored predictions, or none of them exact', () => {
    expect(spotOnCard([], 'en')).toBeNull();
    expect(spotOnCard([scored('u1', [2, 1], [3, 2]), scored('u2', [1, 1], [0, 3])], 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [scored('u1', [2, 1], [2, 1]), scored('u1', [1, 1], [1, 1]), scored('u1', [0, 2], [3, 0])];
    expect(spotOnCard(rows, 'no')).toMatchObject({
      title: 'Blink',
      statistic: '**Alice** har **2** eksakte resultater, av **3** tips med resultat.',
    });
    expect(spotOnCard(rows, 'de')).toMatchObject({
      title: 'Volltreffer',
      statistic: '**Alice** hat **2** exakte Ergebnisse getippt, aus **3** gewerteten Tipps.',
    });
  });

  it('has singulars and a tie in the other two locales too', () => {
    const one = [scored('u1', [2, 1], [2, 1])];
    expect(spotOnCard(one, 'no')?.statistic).toBe(
      '**Alice** har **1** eksakt resultat, av **1** tips med resultat.',
    );
    expect(spotOnCard(one, 'de')?.statistic).toBe(
      '**Alice** hat **1** exaktes Ergebnis getippt, aus **1** gewerteten Tipp.',
    );

    const tie = [scored('u1', [2, 1], [2, 1]), scored('u2', [1, 0], [1, 0])];
    expect(spotOnCard(tie, 'no')?.statistic).toBe('**Alice og Bob** har **1** eksakt resultat hver.');
    expect(spotOnCard(tie, 'de')?.statistic).toBe(
      '**Alice und Bob** haben je **1** exaktes Ergebnis getippt.',
    );
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

describe('bestPredictionCard', () => {
  it('picks the lone exact scoreline that fewest others came near', () => {
    const card = bestPredictionCard(
      [
        // f1 — Alice alone on the scoreline, and nobody else even on the margin.
        scored('u1', [2, 1], [2, 1], 'f1'),
        scored('u2', [2, 0], [2, 1], 'f1'),
        scored('u3', [0, 1], [2, 1], 'f1'),
        // f2 — Bob alone on the scoreline, but Chris had the margin as well.
        scored('u2', [1, 0], [1, 0], 'f2'),
        scored('u3', [2, 1], [1, 0], 'f2'),
      ],
      teams,
      'en',
    );
    expect(card?.title).toBe('Best prediction');
    expect(card?.statistic).toBe(
      '**Alice** was the only one to predict **Arsenal 2-1 Bayern**. Nobody else had the goal difference, and only **1** other picked the winner.',
    );
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u1', name: 'Alice', imageUrl: '/api/images/alice.png', iconColor: null },
    ]);
  });

  it('counts the others only, so a lone caller can reach nobody at all', () => {
    const card = bestPredictionCard(
      [scored('u1', [2, 1], [2, 1], 'f1'), scored('u2', [0, 2], [2, 1], 'f1')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice** was the only one to predict **Arsenal 2-1 Bayern**, and nobody else so much as picked the winner.',
    );
  });

  it('says how many others had the margin when somebody did', () => {
    const single = [
      scored('u1', [2, 1], [2, 1], 'f1'),
      scored('u2', [3, 2], [2, 1], 'f1'),
    ];
    expect(bestPredictionCard(single, teams, 'en')?.statistic).toBe(
      '**Alice** was the only one to predict **Arsenal 2-1 Bayern**, and only **1** other had the goal difference.',
    );
    expect(
      bestPredictionCard([...single, scored('u3', [1, 0], [2, 1], 'f1')], teams, 'en')?.statistic,
    ).toBe(
      '**Alice** was the only one to predict **Arsenal 2-1 Bayern**, and only **2** others had the goal difference.',
    );
  });

  it('falls to the fewest correct outcomes when no others had the margin either', () => {
    const card = bestPredictionCard(
      [
        // f1 — nobody else on the margin, but two of them picked the winner.
        scored('u1', [2, 1], [2, 1], 'f1'),
        scored('u2', [3, 0], [2, 1], 'f1'),
        scored('u3', [4, 0], [2, 1], 'f1'),
        // f2 — nobody else on the margin, and nobody else on the winner either.
        scored('u2', [1, 0], [1, 0], 'f2'),
        scored('u3', [0, 2], [1, 0], 'f2'),
      ],
      teams,
      'en',
    );
    expect(card?.statistic).toBe(
      '**Bob** was the only one to predict **Bayern 1-0 Barcelona**, and nobody else so much as picked the winner.',
    );
  });

  it('ignores a fixture two members both called exactly', () => {
    const card = bestPredictionCard(
      [
        scored('u1', [2, 1], [2, 1], 'f1'),
        scored('u2', [2, 1], [2, 1], 'f1'),
        scored('u3', [1, 0], [1, 0], 'f2'),
      ],
      teams,
      'en',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u3']);
  });

  it('names the scoreline alone when the fixture has no teams yet', () => {
    expect(
      bestPredictionCard([scored('u1', [2, 1], [2, 1], 'f9')], teams, 'en')?.statistic,
    ).toBe('**Alice** was the only one to predict **2-1**, and nobody else so much as picked the winner.');
  });

  it('names no fixture when two of them are level, and counts one member twice', () => {
    const tie = bestPredictionCard(
      [
        scored('u1', [2, 1], [2, 1], 'f1'),
        scored('u2', [0, 2], [2, 1], 'f1'),
        scored('u2', [1, 0], [1, 0], 'f2'),
        scored('u1', [0, 3], [1, 0], 'f2'),
      ],
      teams,
      'en',
    );
    expect(tie?.statistic).toBe(
      '**Alice and Bob** each predicted a scoreline nobody else got, and nobody else so much as picked the winner.',
    );
    expect(tie?.subjects.map(s => s.id)).toEqual(['u1', 'u2']);

    const sameMember = bestPredictionCard(
      [
        scored('u1', [2, 1], [2, 1], 'f1'),
        scored('u2', [0, 2], [2, 1], 'f1'),
        scored('u1', [1, 0], [1, 0], 'f2'),
        scored('u2', [0, 3], [1, 0], 'f2'),
      ],
      teams,
      'en',
    );
    expect(sameMember?.statistic).toBe(
      '**Alice** predicted **2** scorelines nobody else got, and nobody else so much as picked the winner.',
    );
    expect(sameMember?.subjects.map(s => s.id)).toEqual(['u1']);
  });

  it('is null without predictions, or without a scoreline exactly one member called', () => {
    expect(bestPredictionCard([], teams, 'en')).toBeNull();
    expect(bestPredictionCard([scored('u1', [2, 1], [3, 1], 'f1')], teams, 'en')).toBeNull();
    expect(
      bestPredictionCard(
        [scored('u1', [2, 1], [2, 1], 'f1'), scored('u2', [2, 1], [2, 1], 'f1')],
        teams,
        'en',
      ),
    ).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [
      scored('u1', [2, 1], [2, 1], 'f1'),
      scored('u2', [2, 0], [2, 1], 'f1'),
    ];
    expect(bestPredictionCard(rows, teams, 'no')).toMatchObject({
      title: 'Synsk',
      statistic:
        '**Alice** var den eneste som tippet **Arsenal 2-1 Bayern**. Ingen andre hadde riktig målforskjell, og bare **1** annen traff på vinneren.',
    });
    expect(bestPredictionCard(rows, teams, 'de')).toMatchObject({
      title: 'Wahrsager',
      statistic:
        '**Alice** hat als einzige Person **Arsenal 2-1 Bayern** getippt. Niemand sonst hatte die Tordifferenz, und nur **1** andere Person lag beim Sieger richtig.',
    });
  });
});

describe('worstPredictionCard', () => {
  it('names the prediction furthest from the real goal difference', () => {
    const card = worstPredictionCard(
      [
        scored('u1', [0, 4], [3, 0], 'f1'),
        scored('u2', [1, 2], [3, 0], 'f1'),
        scored('u3', [2, 0], [3, 0], 'f1'),
      ],
      teams,
      'en',
    );
    expect(card?.title).toBe('Worst prediction');
    expect(card?.statistic).toBe(
      '**Alice** predicted **0-4** in **Arsenal vs Bayern**, which finished **3-0** — **7** goals off on the goal difference.',
    );
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u1', name: 'Alice', imageUrl: '/api/images/alice.png', iconColor: null },
    ]);
  });

  it('measures the margin, not the scoreline: a wild 6-5 on a 1-0 is not out at all', () => {
    const card = worstPredictionCard(
      [scored('u2', [6, 5], [1, 0], 'f2'), scored('u1', [0, 2], [1, 0], 'f1')],
      teams,
      'en',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u1']);
    expect(card?.statistic).toContain('**3** goals off');
  });

  it('shows every member level on the same miss', () => {
    const card = worstPredictionCard(
      [scored('u1', [0, 4], [3, 0], 'f1'), scored('u2', [4, 0], [0, 3], 'f2')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe('**Alice and Bob** were each **7** goals off on the goal difference.');
    expect(card?.subjects.map(s => s.id)).toEqual(['u1', 'u2']);
  });

  it('counts them instead when one member holds the whole tie', () => {
    const card = worstPredictionCard(
      [scored('u1', [0, 4], [3, 0], 'f1'), scored('u1', [4, 0], [0, 3], 'f2')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice** has **2** predictions **7** goals off on the goal difference.',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u1']);
  });

  it('names the scoreline alone when the fixture has no teams yet', () => {
    expect(worstPredictionCard([scored('u1', [0, 4], [3, 0], 'f9')], teams, 'en')?.statistic).toBe(
      '**Alice** predicted **0-4** in a match that finished **3-0** — **7** goals off on the goal difference.',
    );
  });

  it('is null without predictions, or when every margin was right', () => {
    expect(worstPredictionCard([], teams, 'en')).toBeNull();
    expect(
      worstPredictionCard(
        [scored('u1', [2, 1], [3, 2], 'f1'), scored('u2', [1, 0], [3, 2], 'f1')],
        teams,
        'en',
      ),
    ).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [scored('u1', [0, 4], [3, 0], 'f1'), scored('u2', [2, 0], [3, 0], 'f1')];
    expect(worstPredictionCard(rows, teams, 'no')).toMatchObject({
      title: 'Skivebom',
      statistic:
        '**Alice** tippet **0-4** på **Arsenal mot Bayern**, som endte **3-0** — **7** mål feil på målforskjellen.',
    });
    expect(worstPredictionCard(rows, teams, 'de')).toMatchObject({
      title: 'Katastrophentipp',
      statistic:
        '**Alice** hat **0-4** bei **Arsenal gegen Bayern** getippt, das **3-0** endete — **7** Tore neben der Tordifferenz.',
    });
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

  it('puts the member pair, then the prediction pair, before the nationality card', () => {
    expect(
      buildLiveUserStats(
        {
          ...all,
          scoredPredictions: [
            scored('u1', [1, 0], [1, 0], 'f1'),
            scored('u1', [2, 0], [3, 1], 'f2'),
            scored('u2', [0, 3], [1, 0], 'f1'),
          ],
          scorerNationalities: snapshot({ Norway: { goals: 3, players: 2 } }),
        },
        'en',
      ).map(c => c.id),
    ).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
      'goldenBoot',
      'goalDrought',
      'spotOn',
      'almost',
      'bestPrediction',
      'worstPrediction',
      'norwegianGoals',
    ]);
  });

  it('shows the near-miss card alone when nobody has called a scoreline', () => {
    expect(
      buildLiveUserStats({ ...all, scoredPredictions: [scored('u1', [1, 0], [2, 1])] }, 'en').map(
        c => c.id,
      ),
    ).toEqual(['peoplesFavourite', 'woodenSpoon', 'goldenBoot', 'goalDrought', 'almost']);
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
