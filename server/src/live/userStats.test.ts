import { describe, expect, it } from 'vitest';
import {
  almostCard,
  bestFormCard,
  bestPredictionCard,
  buildLiveUserStats,
  mostExpectedResultCard,
  mostUnexpectedResultCard,
  nationalityGoalsCard,
  goalDroughtCard,
  goldenBootCard,
  inHaalandWeTrustCard,
  peoplesFavouriteCard,
  lastBelieverCard,
  spotOnCard,
  theClimberCard,
  theFallerCard,
  theLeaderCard,
  woodenSpoonCard,
  worstFormCard,
  worstPredictionCard,
} from './userStats';

const teams = [
  { id: 't1', name: 'Bayern', crestUrl: '/api/images/bayern.png' },
  { id: 't2', name: 'Arsenal', crestUrl: '/api/images/arsenal.png' },
  { id: 't3', name: 'Barcelona', crestUrl: null },
];

/** The members every fixture below is made of, by the id they are referred to by. */
const USERNAMES: Record<string, string> = {
  u1: 'Alice',
  u2: 'Bob',
  u3: 'Chris',
  u4: 'Dana',
  u5: 'Erik',
};

const memberOf = (userId: string) => ({
  userId,
  username: USERNAMES[userId] ?? userId,
  imageUrl: userId === 'u1' ? '/api/images/alice.png' : null,
  iconColor: userId === 'u1' ? null : '#334155',
});

const pick = (userId: string, ...orderedTeamIds: string[]) => ({
  ...memberOf(userId),
  orderedTeamIds,
});

const players = [
  { id: 'p1', name: 'Haaland', imageUrl: '/api/images/haaland.png' },
  { id: 'p2', name: 'Kane', imageUrl: null },
  { id: 'p3', name: 'Mbappé', imageUrl: '/api/images/mbappe.png' },
];

const rank = (userId: string, ...orderedPlayerIds: string[]) => ({
  ...memberOf(userId),
  orderedPlayerIds,
});

/**
 * One scored prediction: who made it, what they said, what happened, and — where a test
 * needs more than one match — which fixture it was on. `scored` is shorthand for
 * "predicted 2-1, actual 3-1" on fixture f1.
 */
/** The default tiers, which `tierPoints` above also assumes. */
const scoringConfig = {
  correct_outcome: 1,
  correct_goal_difference: 1,
  exact_score: 2,
  table_exact_position: 3,
  table_correct_band: 1,
  scorer_exact_position: 3,
};

/** Which teams each test fixture is between. A fixture id not listed here has none yet. */
const fixtureTeams: Record<string, [string, string]> = {
  f1: ['t2', 't1'], // Arsenal vs Bayern
  f2: ['t1', 't3'], // Bayern vs Barcelona
  f3: ['t3', 't2'], // Barcelona vs Arsenal
};

/**
 * What a prediction earned, on the default 1 / 1 / 2 tiers: enough for the cards that
 * read `points` without every test having to state it.
 */
const tierPoints = (
  [predictedHome, predictedAway]: [number, number],
  [actualHome, actualAway]: [number, number],
): number => {
  const outcome = Math.sign(actualHome - actualAway) === Math.sign(predictedHome - predictedAway);
  const goalDifference = actualHome - actualAway === predictedHome - predictedAway;
  const exact = predictedHome === actualHome && predictedAway === actualAway;
  return (outcome ? 1 : 0) + (goalDifference ? 1 : 0) + (exact ? 2 : 0);
};

const scored = (
  userId: string,
  [predictedHome, predictedAway]: [number, number],
  [actualHome, actualAway]: [number, number],
  fixtureId = 'f1',
  points = tierPoints([predictedHome, predictedAway], [actualHome, actualAway]),
) => ({
  ...memberOf(userId),
  fixtureId,
  homeTeamId: fixtureTeams[fixtureId]?.[0] ?? null,
  awayTeamId: fixtureTeams[fixtureId]?.[1] ?? null,
  predictedHome,
  predictedAway,
  actualHome,
  actualAway,
  points,
});

/**
 * A points progression: one entry per milestone, each the running totals after it. The
 * member ids match the ones `scored` invents, and the milestones are named f1, f2, … for
 * the same reason — a card that walks the chart looks its predictions up by fixture.
 */
const progression = (
  milestones: Array<Record<string, number>>,
  ids: string[] = ['u1', 'u2', 'u3'],
) => ({
  matches: milestones.map((cumulativePoints, i) => ({
    matchId: `f${i + 1}`,
    label: `MD ${i + 1}`,
    stage: 'league',
    cumulativePoints,
  })),
  users: ids.map(memberOf),
});

/** The season-long lumps, which are milestones on the chart but not matches. */
const seasonMilestone = (matchId: string, cumulativePoints: Record<string, number>) => ({
  matchId,
  label: matchId,
  stage: matchId,
  cumulativePoints,
});

const snapshot = (
  byNationality: Record<string, { goals: number; players: number }>,
  truncated = false,
) => ({ fetchedAt: '2026-09-02T10:00:00.000Z', count: 400, truncated, byNationality });

describe('theLeaderCard', () => {
  it('names who is top, and how many matches they have been top for', () => {
    const card = theLeaderCard(
      progression([
        { u1: 4, u2: 1, u3: 0 },
        { u1: 4, u2: 8, u3: 3 },
        { u1: 6, u2: 11, u3: 5 },
        { u1: 9, u2: 13, u3: 7 },
      ]),
      'en',
    );
    expect(card?.title).toBe('The Leader');
    expect(card?.statistic).toBe('**Bob** has reigned supreme for the last 3 games!');
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u2', name: 'Bob', imageUrl: null, iconColor: '#334155' },
    ]);
    expect(card?.linkType).toBeNull();
  });

  it('uses the singular for a lead one match old', () => {
    expect(
      theLeaderCard(progression([{ u1: 5, u2: 2 }, { u1: 5, u2: 9 }]), 'en')?.statistic,
    ).toBe('**Bob** has reigned supreme for the last 1 game!');
  });

  it('gives the card to whoever of the current leaders has been there longest', () => {
    const card = theLeaderCard(
      progression([
        { u1: 3, u2: 0, u3: 0 },
        { u1: 6, u2: 2, u3: 0 },
        { u1: 8, u2: 8, u3: 1 },
      ]),
      'en',
    );
    expect(card?.statistic).toBe('**Alice** has reigned supreme for the last 3 games!');
    expect(card?.subjects.map(s => s.id)).toEqual(['u1']);
  });

  it('shows both when they have led together the whole way', () => {
    const card = theLeaderCard(
      progression([
        { u1: 3, u2: 3, u3: 1 },
        { u1: 7, u2: 7, u3: 4 },
      ]),
      'en',
    );
    expect(card?.statistic).toBe('**Alice** and **Bob** have reigned supreme for the last 2 games!');
    expect(card?.subjects.map(s => s.id)).toEqual(['u1', 'u2']);
  });

  it('joins three names the way the manual card does, with the comma', () => {
    const card = theLeaderCard(progression([{ u1: 5, u2: 5, u3: 5 }]), 'en');
    expect(card?.statistic).toBe(
      '**Alice**, **Bob**, and **Chris** have reigned supreme for the last 1 game!',
    );
  });

  it('walks past the season-long milestones, which are no part of a run of matches', () => {
    const chart = progression([
      { u1: 4, u2: 2 },
      { u1: 9, u2: 6 },
    ]);
    const card = theLeaderCard(
      { ...chart, matches: [...chart.matches, seasonMilestone('table', { u1: 12, u2: 20 })] },
      'en',
    );
    expect(card?.statistic).toBe('**Alice** has reigned supreme for the last 2 games!');
  });

  it('is null with no chart, no matches on it, or nobody on any points', () => {
    expect(theLeaderCard(null, 'en')).toBeNull();
    expect(theLeaderCard(progression([]), 'en')).toBeNull();
    expect(theLeaderCard(progression([{ u1: 0, u2: 0 }]), 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const chart = progression([{ u1: 3, u2: 1 }, { u1: 6, u2: 2 }]);
    expect(theLeaderCard(chart, 'no')).toMatchObject({
      title: 'Kongen på haugen',
      statistic: '**Alice** har regjert på toppen i 2 kamper!',
    });
    expect(theLeaderCard(chart, 'de')).toMatchObject({
      title: 'Der Platzhirsch',
      statistic:
        '**Alice** thront seit 2 Spielen an der Spitze wie eine sehr wackelige Krone!',
    });
    expect(theLeaderCard(progression([{ u1: 3, u2: 1 }]), 'no')?.statistic).toBe(
      '**Alice** har regjert på toppen i 1 kamp!',
    );
    expect(theLeaderCard(progression([{ u1: 3, u2: 1 }]), 'de')?.statistic).toContain(
      'seit 1 Spiel an der Spitze',
    );
  });
});

describe('bestFormCard', () => {
  /** Six played fixtures; only the totals' shape matters, not the numbers on them. */
  const sixPlayed = progression([{}, {}, {}, {}, {}, {}]);

  it('adds up the last five matches only', () => {
    const card = bestFormCard(
      [
        // Alice's haul is on the fixture that has just dropped out of the window.
        scored('u1', [1, 0], [1, 0], 'f1', 9),
        scored('u1', [1, 0], [2, 1], 'f6', 1),
        scored('u2', [1, 0], [1, 0], 'f5', 4),
        scored('u2', [2, 1], [2, 1], 'f6', 2),
      ],
      sixPlayed,
      'en',
    );
    expect(card?.title).toBe('Best form');
    expect(card?.statistic).toBe('**Bob** has gained 6 points in the last 5 matches!');
    expect(card?.subjects.map(s => s.id)).toEqual(['u2']);
  });

  it('shows everyone level on the same haul', () => {
    const card = bestFormCard(
      [scored('u1', [1, 0], [1, 0], 'f6', 4), scored('u2', [2, 1], [2, 1], 'f5', 4)],
      sixPlayed,
      'en',
    );
    expect(card?.statistic).toBe('**Alice** and **Bob** have gained 4 points in the last 5 matches!');
    expect(card?.subjects.map(s => s.id)).toEqual(['u1', 'u2']);
  });

  it('is null with no chart, nothing played, or nobody scoring in the window', () => {
    expect(bestFormCard([], null, 'en')).toBeNull();
    expect(bestFormCard([], progression([]), 'en')).toBeNull();
    expect(bestFormCard([], sixPlayed, 'en')).toBeNull();
    expect(bestFormCard([scored('u1', [0, 2], [3, 0], 'f6', 0)], sixPlayed, 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [scored('u1', [1, 0], [1, 0], 'f6', 4)];
    expect(bestFormCard(rows, sixPlayed, 'no')).toMatchObject({
      title: 'I fyr og flamme 🔥',
      statistic: '**Alice** har sanket 4 poeng de siste 5 kampene!',
    });
    expect(bestFormCard(rows, sixPlayed, 'de')).toMatchObject({
      title: 'Formrakete 🔥',
      statistic:
        '**Alice** hat in den letzten 5 Spielen 4 Punkte eingesammelt! Heiß wie eine Bratwurst auf dem Grill.',
    });
  });
});

describe('worstFormCard', () => {
  const threePlayed = progression([{}, {}, {}]);

  /** A prediction on every fixture, scoring only where `points` says so. */
  const everyFixture = (userId: string, points: [number, number, number]) =>
    points.map((p, i) => scored(userId, [1, 0], [2, 1], `f${i + 1}`, p));

  it('counts the run of pointless matches ending now', () => {
    const card = worstFormCard(
      [...everyFixture('u1', [2, 0, 0]), ...everyFixture('u2', [0, 0, 1])],
      threePlayed,
      'en',
    );
    expect(card?.title).toBe('Worst form');
    expect(card?.statistic).toBe('**Alice** has gone 2 matches without gaining a single point!');
    expect(card?.subjects.map(s => s.id)).toEqual(['u1']);
  });

  it('leaves out a member who did not predict every match', () => {
    const card = worstFormCard(
      [
        ...everyFixture('u1', [2, 0, 0]),
        // Chris has three pointless matches, but only predicted two of them.
        scored('u3', [1, 0], [2, 1], 'f2', 0),
        scored('u3', [1, 0], [2, 1], 'f3', 0),
      ],
      threePlayed,
      'en',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u1']);
  });

  it('is null on a drought of one, which is an afternoon rather than a run', () => {
    expect(worstFormCard(everyFixture('u1', [1, 1, 0]), threePlayed, 'en')).toBeNull();
    expect(worstFormCard([], null, 'en')).toBeNull();
    expect(worstFormCard([], progression([]), 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = everyFixture('u1', [1, 0, 0]);
    expect(worstFormCard(rows, threePlayed, 'no')).toMatchObject({
      title: 'Send Hjelp',
      statistic: '**Alice** har gått 2 kamper på rad uten å sanke et eneste poeng!',
    });
    expect(worstFormCard(rows, threePlayed, 'de')).toMatchObject({
      title: 'Hilfe senden',
      statistic:
        '**Alice** hat 2 Spiele in Folge keinen einzigen Punkt geholt! Bitte ruft professionelle Hilfe!',
    });
  });
});

describe('theClimberCard and theFallerCard', () => {
  /** Eleven milestones: Chris comes from bottom to top, Alice goes the other way. */
  const turnaround = progression([
    { u1: 10, u2: 5, u3: 1 },
    ...Array.from({ length: 9 }, () => ({ u1: 10, u2: 5, u3: 1 })),
    { u1: 5, u2: 15, u3: 20 },
  ]);

  it('names who has climbed the most places over the last ten', () => {
    const card = theClimberCard(turnaround, 'en');
    expect(card?.title).toBe('The Climber');
    expect(card?.statistic).toBe(
      '**Chris** has climbed 2 spots on the leaderboard over the last 10 games!',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u3']);
  });

  it('names who has dropped the most over the same ten', () => {
    const card = theFallerCard(turnaround, 'en');
    expect(card?.title).toBe("I'm falling!");
    expect(card?.statistic).toBe(
      '**Alice** has dropped 2 spots on the leaderboard over the last 10 games!',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u1']);
  });

  it('needs eleven milestones, and a move of at least two places', () => {
    const tooShort = progression(Array.from({ length: 10 }, () => ({ u1: 10, u2: 5, u3: 1 })));
    expect(theClimberCard(tooShort, 'en')).toBeNull();
    expect(theFallerCard(tooShort, 'en')).toBeNull();

    const oneSpot = progression([
      { u1: 10, u2: 5, u3: 1 },
      ...Array.from({ length: 9 }, () => ({ u1: 10, u2: 5, u3: 1 })),
      { u1: 10, u2: 12, u3: 1 },
    ]);
    expect(theClimberCard(oneSpot, 'en')).toBeNull();
    expect(theFallerCard(oneSpot, 'en')).toBeNull();

    expect(theClimberCard(null, 'en')).toBeNull();
    expect(theFallerCard(null, 'en')).toBeNull();
  });

  it('translates the titles and the statistics', () => {
    expect(theClimberCard(turnaround, 'no')).toMatchObject({
      title: 'Det klatres!',
      statistic: '**Chris** har klatret 2 plasser på tabellen de siste 10 kampene!',
    });
    expect(theClimberCard(turnaround, 'de')).toMatchObject({
      title: 'Der Aufsteiger',
      statistic: '**Chris** ist in den letzten 10 Spielen um 2 Plätze aufgestiegen!',
    });
    expect(theFallerCard(turnaround, 'no')).toMatchObject({
      title: 'Rett åt skogen',
      statistic: '**Alice** har falt 2 plasser på tabellen de siste 10 kampene!',
    });
    expect(theFallerCard(turnaround, 'de')).toMatchObject({
      title: 'Tabellenabsteiger',
      statistic: '**Alice** ist in den letzten 10 Spielen um 2 Plätze abgefallen!',
    });
  });
});

describe('mostUnexpectedResultCard', () => {
  const twoPlayed = progression([{}, {}]);

  it('names the result nobody had, and the worst of the predictions against it', () => {
    const card = mostUnexpectedResultCard(
      [
        // f1 — Arsenal beat Bayern 3-0 and both of them backed Bayern.
        scored('u1', [0, 4], [3, 0], 'f1'),
        scored('u2', [1, 2], [3, 0], 'f1'),
        // f2 — also unforeseen, but by less.
        scored('u1', [2, 0], [1, 1], 'f2'),
        scored('u2', [0, 3], [1, 1], 'f2'),
      ],
      teams,
      twoPlayed,
      'en',
    );
    expect(card?.title).toBe('Most unexpected result');
    expect(card?.statistic).toBe(
      'No one predicted Arsenal to beat Bayern! **Alice** even predicted Bayern to beat Arsenal (0 - 4)!',
    );
    expect(card?.subjects).toEqual([
      { type: 'team', id: 't2', name: 'Arsenal', imageUrl: '/api/images/arsenal.png' },
      { type: 'team', id: 't1', name: 'Bayern', imageUrl: '/api/images/bayern.png' },
    ]);
  });

  it('skips a fixture somebody called the winner of', () => {
    const card = mostUnexpectedResultCard(
      [
        scored('u1', [0, 4], [3, 0], 'f1'),
        scored('u2', [1, 0], [3, 0], 'f1'),
        scored('u1', [0, 3], [1, 1], 'f2'),
        scored('u2', [2, 0], [1, 1], 'f2'),
      ],
      teams,
      twoPlayed,
      'en',
    );
    expect(card?.statistic).toContain('Bayern');
    expect(card?.statistic).toContain('draw');
  });

  it('names the biggest group who made the same wrong call', () => {
    const card = mostUnexpectedResultCard(
      [
        scored('u1', [1, 5], [3, 0], 'f1'),
        scored('u2', [0, 4], [3, 0], 'f1'),
        scored('u3', [0, 4], [3, 0], 'f1'),
      ],
      teams,
      twoPlayed,
      'en',
    );
    expect(card?.statistic).toBe(
      'No one predicted Arsenal to beat Bayern! **Bob** and **Chris** even predicted Bayern to beat Arsenal (0 - 4)!',
    );
  });

  it('keeps the earlier fixture when two are level', () => {
    const card = mostUnexpectedResultCard(
      [scored('u1', [0, 4], [3, 0], 'f1'), scored('u2', [4, 0], [0, 3], 'f2')],
      teams,
      twoPlayed,
      'en',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['t2', 't1']);
  });

  it('is null without a chart, or while every result was foreseen', () => {
    expect(mostUnexpectedResultCard([], teams, null, 'en')).toBeNull();
    expect(
      mostUnexpectedResultCard([scored('u1', [1, 0], [3, 0], 'f1')], teams, twoPlayed, 'en'),
    ).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [scored('u1', [0, 4], [3, 0], 'f1')];
    expect(mostUnexpectedResultCard(rows, teams, twoPlayed, 'no')).toMatchObject({
      title: 'Sjokkresultat',
      statistic:
        'Ingen tippet at Arsenal slo Bayern! **Alice** tippet til og med at Bayern slo Arsenal (0-4)!',
    });
    expect(mostUnexpectedResultCard(rows, teams, twoPlayed, 'de')).toMatchObject({
      title: 'Schockresultat',
      statistic:
        'Niemand hat dass Arsenal gegen Bayern gewinnt vorhergesagt! **Alice** hat sogar dass Bayern gegen Arsenal gewinnt (0-4) getippt!',
    });
  });
});

describe('mostExpectedResultCard', () => {
  const twoPlayed = progression([{}, {}]);

  const obvious = [
    // f1 — Arsenal 2-1 Bayern, and all three of them had the winner.
    scored('u1', [2, 1], [2, 1], 'f1'),
    scored('u2', [1, 0], [2, 1], 'f1'),
    scored('u3', [3, 0], [2, 1], 'f1'),
    // f2 — a draw one of them saw.
    scored('u1', [0, 0], [1, 1], 'f2'),
    scored('u2', [2, 0], [1, 1], 'f2'),
  ];

  it('names the fixture the league saw coming, and what it paid', () => {
    const card = mostExpectedResultCard(obvious, teams, twoPlayed, scoringConfig, 'en');
    expect(card?.title).toBe('The most expected result');
    expect(card?.statistic).toBe(
      'Arsenal vs Bayern (2 - 1) was the most predictable outcome! A total of 3 users predicted the correct result, and 1 of those predicted the exact score! Each user scored on average 2.33 points.' +
        ' Still **Chris** earned only 1 point.',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['t2', 't1']);
  });

  it('points out whoever came away with nothing, ahead of whoever got one', () => {
    const card = mostExpectedResultCard(
      [...obvious, scored('u2', [0, 3], [2, 1], 'f1')],
      teams,
      twoPlayed,
      scoringConfig,
      'en',
    );
    expect(card?.statistic).toContain(' Still **Bob** earned 0 points.');
    expect(card?.statistic).not.toContain('only 1 point');
  });

  it('ranks on the tiers, so a multiplied fixture cannot buy the card', () => {
    const card = mostExpectedResultCard(
      [
        ...obvious,
        // One member, one correct outcome, but a x3 fixture paying nine points.
        scored('u1', [1, 0], [2, 0], 'f3', 9),
      ],
      teams,
      twoPlayed,
      scoringConfig,
      'en',
    );
    expect(card?.statistic).toContain('Arsenal vs Bayern (2 - 1)');
  });

  it('is null without a chart, or while nobody has called a winner', () => {
    expect(mostExpectedResultCard([], teams, null, scoringConfig, 'en')).toBeNull();
    expect(
      mostExpectedResultCard(
        [scored('u1', [0, 4], [3, 0], 'f1')],
        teams,
        twoPlayed,
        scoringConfig,
        'en',
      ),
    ).toBeNull();
  });

  it('translates the title and the statistic', () => {
    expect(mostExpectedResultCard(obvious, teams, twoPlayed, scoringConfig, 'no')).toMatchObject({
      title: 'Forventet resultat',
      statistic:
        'Arsenal mot Bayern (2-1) var det mest forutsigbare resultatet! Totalt tippet 3 spillere riktig resultat, og 1 av dem tippet eksakt resultat! Hver spiller sanket i snitt 2.33 poeng. Likevel sanket **Chris** bare 1 poeng.',
    });
    expect(mostExpectedResultCard(obvious, teams, twoPlayed, scoringConfig, 'de')).toMatchObject({
      title: 'Na klar!',
      statistic:
        'Arsenal gegen Bayern (2-1) — so offensichtlich, dass sogar ein Blindgänger es hätte tippen können! 3 Leute lagen richtig, 1 davon sogar mit exaktem Ergebnis. Im Schnitt 2.33 Punkte pro Person. Und trotzdem hat **Chris** nur 1 Punkt geholt. Traurig.',
    });
  });
});

describe('peoplesFavouriteCard', () => {
  it('counts only the team in first place', () => {
    const card = peoplesFavouriteCard(
      [pick('u1', 't1', 't2'), pick('u2', 't2', 't1'), pick('u3', 't1', 't3')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe(
      "**Bayern** are the people's favourite! **2** of **3** have them top of their table prediction.",
    );
    expect(card?.subjects).toEqual([
      { type: 'team', id: 't1', name: 'Bayern', imageUrl: '/api/images/bayern.png' },
    ]);
  });

  it('shows every team of a tie, by name, and drops the icon', () => {
    const card = peoplesFavouriteCard([pick('u1', 't1'), pick('u2', 't2')], teams, 'en');
    expect(card?.statistic).toBe(
      "**Arsenal and Bayern** are the people's favourites! **1** of **2** have each of them top of their table prediction.",
    );
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
    expect(card?.statistic).toBe(
      "**Bayern** are the people's favourite! **2** of **2** have them top of their table prediction.",
    );
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
      statistic:
        '**Bayern** er folkets favoritt! **2** av **2** har tippet dem øverst på tabelltipset.',
    });
    expect(peoplesFavouriteCard(rows, teams, 'de')).toMatchObject({
      title: 'Der Publikumsliebling',
      statistic:
        '**Bayern** ist der Publikumsliebling! **2** von **2** haben sie ganz oben im Tabellentipp.',
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
    expect(card?.statistic).toBe(
      'Nobody believes in **Barcelona**! **2** of **3** have them finishing dead last.',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['t3']);
  });

  it('shows every team of a tie', () => {
    const card = woodenSpoonCard([pick('u1', 't1', 't3'), pick('u2', 't3', 't2')], teams, 'en');
    expect(card?.statistic).toBe(
      'Nobody believes in **Arsenal and Barcelona**! **1** of **2** have each of them finishing dead last.',
    );
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
    expect(card?.statistic).toBe(
      'Nobody believes in **Barcelona**! **2** of **2** have them finishing dead last.',
    );
  });

  it('is null with no predictions or only dropped teams', () => {
    expect(woodenSpoonCard([], teams, 'en')).toBeNull();
    expect(woodenSpoonCard([pick('u1')], teams, 'en')).toBeNull();
    expect(woodenSpoonCard([pick('u1', 'gone')], teams, 'en')).toBeNull();
  });

  it('translates the title and the statistic', () => {
    const rows = [pick('u1', 't1', 't3'), pick('u2', 't2', 't3')];
    expect(woodenSpoonCard(rows, teams, 'no')).toMatchObject({
      title: 'Bunnslammet',
      statistic:
        'Ingen har trua på **Barcelona**! **2** av **2** har tippet at de ender helt sist på tabellen.',
    });
    expect(woodenSpoonCard(rows, teams, 'de')).toMatchObject({
      title: 'Der Bodensatz',
      statistic:
        'Niemand glaubt an **Barcelona**! **2** von **2** tippen sie auf den letzten Tabellenplatz.',
    });
    expect(woodenSpoonCard(rows, teams, 'en')?.title).toBe('The bottom of the barrel');
  });
});

describe('lastBelieverCard', () => {
  const six = [
    { id: 't1', name: 'Bayern', crestUrl: '/api/images/bayern.png' },
    { id: 't2', name: 'Arsenal', crestUrl: '/api/images/arsenal.png' },
    { id: 't3', name: 'Barcelona', crestUrl: null },
    { id: 't4', name: 'Dortmund', crestUrl: null },
    { id: 't5', name: 'Enschede', crestUrl: null },
    { id: 't6', name: 'Feyenoord', crestUrl: null },
  ];

  it('names the written-off team and the one member still backing it', () => {
    const card = lastBelieverCard(
      [
        // Feyenoord is bottom-two for Bob and Chris, but Alice has them surviving.
        pick('u1', 't1', 't2', 't3', 't6', 't4', 't5'),
        pick('u2', 't1', 't2', 't3', 't4', 't6', 't5'),
        pick('u3', 't1', 't2', 't3', 't4', 't5', 't6'),
      ],
      six,
      5,
      'en',
    );
    expect(card?.title).toBe('The last believer');
    expect(card?.statistic).toBe(
      '**2** of **3** have **Feyenoord** dropping straight out. **Alice** is the only one with them going through.',
    );
    expect(card?.subjects).toEqual([
      { type: 'team', id: 't6', name: 'Feyenoord', imageUrl: null },
    ]);
  });

  it('passes over a team nobody believes in at all', () => {
    const card = lastBelieverCard(
      [
        // Nobody has Feyenoord surviving, so the card belongs to Enschede instead.
        pick('u1', 't1', 't2', 't3', 't4', 't5', 't6'),
        pick('u2', 't1', 't2', 't3', 't5', 't4', 't6'),
        pick('u3', 't1', 't2', 't3', 't4', 't5', 't6'),
      ],
      six,
      5,
      'en',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['t5']);
    expect(card?.statistic).toBe(
      '**2** of **3** have **Enschede** dropping straight out. **Bob** is the only one with them going through.',
    );
  });

  it('passes over a team nobody has written off', () => {
    expect(
      lastBelieverCard(
        [pick('u1', 't1', 't2', 't3'), pick('u2', 't2', 't1', 't3')],
        six,
        4,
        'en',
      ),
    ).toBeNull();
  });

  it('names several believers when a team has more than one', () => {
    const card = lastBelieverCard(
      [
        pick('u1', 't1', 't2', 't3', 't4', 't5', 't6'),
        pick('u2', 't1', 't2', 't3', 't4', 't5', 't6'),
        pick('u3', 't1', 't2', 't3', 't4', 't5', 't6'),
        pick('u4', 't6', 't1', 't2', 't3', 't4', 't5'),
        pick('u5', 't6', 't1', 't2', 't3', 't4', 't5'),
      ],
      six,
      6,
      'en',
    );
    expect(card?.statistic).toBe(
      '**3** of **5** have **Feyenoord** dropping straight out. Only **Dana and Erik** have them going through.',
    );
  });

  it('shows two level teams together only when the same members believe in both', () => {
    const shared = lastBelieverCard(
      [
        // Alice alone has both Enschede and Feyenoord surviving.
        pick('u1', 't5', 't6', 't1', 't2', 't3', 't4'),
        pick('u2', 't1', 't2', 't3', 't4', 't5', 't6'),
        pick('u3', 't1', 't2', 't3', 't4', 't5', 't6'),
      ],
      six,
      5,
      'en',
    );
    expect(shared?.subjects.map(s => s.id)).toEqual(['t5', 't6']);
    expect(shared?.statistic).toContain('**Enschede and Feyenoord** dropping straight out');
    expect(shared?.statistic).toContain('**Alice** is the only one');

    const apart = lastBelieverCard(
      [
        pick('u1', 't5', 't1', 't2', 't3', 't6', 't4'),
        pick('u2', 't6', 't1', 't2', 't4', 't3', 't5'),
        pick('u3', 't1', 't2', 't3', 't4', 't5', 't6'),
      ],
      six,
      5,
      'en',
    );
    // Two stories, and only one fits in the sentence: the first by name keeps the card.
    expect(apart?.subjects.map(s => s.id)).toEqual(['t5']);
    expect(apart?.statistic).toContain('**Alice** is the only one');
  });

  it('is null without bands, without predictions, or where the band takes nobody', () => {
    const rows = [pick('u1', 't1', 't2', 't3'), pick('u2', 't2', 't3', 't1')];
    expect(lastBelieverCard(rows, six, null, 'en')).toBeNull();
    expect(lastBelieverCard(rows, six, 0, 'en')).toBeNull();
    expect(lastBelieverCard([], six, 3, 'en')).toBeNull();
    expect(lastBelieverCard(rows, six, 9, 'en')).toBeNull();
  });

  it('leaves a team that has left the tournament out of the count', () => {
    const card = lastBelieverCard(
      [pick('u1', 't1', 'gone', 't6'), pick('u2', 't1', 't6', 'gone')],
      six,
      3,
      'en',
    );
    expect(card?.statistic).toBe(
      '**1** of **2** have **Feyenoord** dropping straight out. **Bob** is the only one with them going through.',
    );
  });

  it('translates the title and the statistic', () => {
    const rows = [
      pick('u1', 't1', 't2', 't3', 't6', 't4', 't5'),
      pick('u2', 't1', 't2', 't3', 't4', 't5', 't6'),
      pick('u3', 't1', 't2', 't3', 't4', 't5', 't6'),
    ];
    expect(lastBelieverCard(rows, six, 5, 'no')).toMatchObject({
      title: 'Den siste troende',
      statistic:
        '**2** av **3** har tippet at **Feyenoord** ryker rett ut. **Alice** er den eneste som har tippet dem videre.',
    });
    expect(lastBelieverCard(rows, six, 5, 'de')).toMatchObject({
      title: 'Der letzte Gläubige',
      statistic:
        '**2** von **3** tippen **Feyenoord** auf den direkten Abgang. **Alice** ist die einzige Person, die sie weiterkommen sieht.',
    });
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
      'Expectations are low for **Mbappé**. **2** of **3** have him scoring the fewest goals on the top-scorer list.',
    );
  });

  it('leaves a ranking ending on a dropped player out of both halves of the count', () => {
    const card = goalDroughtCard(
      [rank('u1', 'p1', 'p3'), rank('u2', 'p1', 'gone'), rank('u3', 'p2', 'p3')],
      players,
      'en',
    );
    expect(card?.statistic).toBe(
      'Expectations are low for **Mbappé**. **2** of **2** have him scoring the fewest goals on the top-scorer list.',
    );
  });

  it('translates the title and the statistic', () => {
    const rows = [rank('u1', 'p1', 'p3'), rank('u2', 'p2', 'p3')];
    expect(goalDroughtCard(rows, players, 'no')).toMatchObject({
      title: 'Null tillit',
      statistic:
        'Forventningene er lave for **Mbappé**. **2** av **2** har tippet at han scorer færrest mål på toppscorerlista.',
    });
    expect(goalDroughtCard(rows, players, 'de')).toMatchObject({
      title: 'Kein Vertrauen',
      statistic:
        'Die Erwartungen an **Mbappé** sind gering. **2** von **2** tippen ihn auf die wenigsten Tore der Torjägerliste.',
    });
    expect(goalDroughtCard(rows, players, 'en')?.title).toBe('No confidence');
  });

  it('is null with no rankings', () => {
    expect(goalDroughtCard([], players, 'en')).toBeNull();
  });
});

describe('spotOnCard', () => {
  it('names the member with the most perfect scorelines, and the one with the fewest', () => {
    const card = spotOnCard(
      [
        scored('u1', [2, 1], [2, 1]),
        scored('u1', [1, 1], [1, 1]),
        scored('u1', [0, 2], [3, 0]),
        scored('u2', [1, 0], [1, 0]),
        scored('u2', [3, 1], [1, 0]),
        scored('u3', [2, 2], [0, 1]),
      ],
      'en',
    );
    expect(card?.title).toBe('Holding the answer key');
    expect(card?.statistic).toBe(
      '**Alice** has predicted a full **2** perfect scorelines! **Chris** has the fewest with **0** perfect scorelines.',
    );
    expect(card?.subjects).toEqual([
      { type: 'user', id: 'u1', name: 'Alice', imageUrl: '/api/images/alice.png', iconColor: null },
    ]);
  });

  it('uses the singular at the trailing end too', () => {
    expect(
      spotOnCard(
        [
          scored('u1', [2, 1], [2, 1]),
          scored('u1', [1, 1], [1, 1]),
          scored('u2', [1, 0], [1, 0]),
          scored('u2', [0, 2], [1, 0]),
        ],
        'en',
      )?.statistic,
    ).toBe(
      '**Alice** has predicted a full **2** perfect scorelines! **Bob** has the fewest with **1** perfect scoreline.',
    );
  });

  it('drops the second sentence when everybody is level', () => {
    expect(spotOnCard([scored('u1', [2, 1], [2, 1])], 'en')?.statistic).toBe(
      '**Alice** has predicted a full **1** perfect scoreline!',
    );
    expect(
      spotOnCard([scored('u1', [2, 1], [2, 1]), scored('u2', [1, 0], [1, 0])], 'en')?.statistic,
    ).toBe('**Alice and Bob** have each predicted a full **1** perfect scoreline!');
  });

  it('shows a tie at either end in full', () => {
    const card = spotOnCard(
      [
        scored('u1', [2, 1], [2, 1]),
        scored('u1', [0, 0], [1, 2]),
        scored('u2', [1, 0], [1, 0]),
        scored('u3', [2, 2], [0, 1]),
        scored('u3', [1, 1], [0, 1]),
      ],
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice and Bob** have each predicted a full **1** perfect scoreline! **Chris** has the fewest with **0** perfect scorelines.',
    );
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
    const rows = [
      scored('u1', [2, 1], [2, 1]),
      scored('u1', [1, 1], [1, 1]),
      scored('u2', [3, 1], [1, 0]),
    ];
    expect(spotOnCard(rows, 'no')).toMatchObject({
      title: 'Sitter med fasiten i hånden',
      statistic:
        '**Alice** har tippet hele **2** perfekte resultater! **Bob** har færrest med **0** fulltreffere.',
    });
    expect(spotOnCard(rows, 'de')).toMatchObject({
      title: 'Mit dem Lösungsblatt in der Hand',
      statistic:
        '**Alice** hat ganze **2** perfekte Ergebnisse getippt! **Bob** hat mit **0** perfekten Ergebnissen die wenigsten.',
    });
  });

  it('has singulars and a tie in the other two locales too', () => {
    const one = [scored('u1', [2, 1], [2, 1]), scored('u2', [3, 1], [1, 0])];
    expect(spotOnCard(one, 'no')?.statistic).toBe(
      '**Alice** har tippet hele **1** perfekt resultat! **Bob** har færrest med **0** fulltreffere.',
    );
    expect(spotOnCard(one, 'de')?.statistic).toBe(
      '**Alice** hat ganze **1** perfektes Ergebnis getippt! **Bob** hat mit **0** perfekten Ergebnissen die wenigsten.',
    );

    const tie = [scored('u1', [2, 1], [2, 1]), scored('u2', [1, 0], [1, 0])];
    expect(spotOnCard(tie, 'no')?.statistic).toBe(
      '**Alice og Bob** har tippet hele **1** perfekt resultat hver!',
    );
    expect(spotOnCard(tie, 'de')?.statistic).toBe(
      '**Alice und Bob** haben je ganze **1** perfektes Ergebnis getippt!',
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
    expect(card?.title).toBe('How did you know?');
    expect(card?.statistic).toBe(
      '**Alice** was the only one to predict the perfect score for **Arsenal 2-1 Bayern**! Only **1** other even had the right outcome!',
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
      '**Alice** was the only one to predict the perfect score for **Arsenal 2-1 Bayern**! Nobody else even got the outcome of the match right!',
    );
  });

  it('says how many others had the margin when somebody did', () => {
    const single = [
      scored('u1', [2, 1], [2, 1], 'f1'),
      scored('u2', [3, 2], [2, 1], 'f1'),
    ];
    expect(bestPredictionCard(single, teams, 'en')?.statistic).toBe(
      '**Alice** was the only one to predict the perfect score for **Arsenal 2-1 Bayern**! Only **1** other even had the goal difference!',
    );
    expect(
      bestPredictionCard([...single, scored('u3', [1, 0], [2, 1], 'f1')], teams, 'en')?.statistic,
    ).toBe(
      '**Alice** was the only one to predict the perfect score for **Arsenal 2-1 Bayern**! Only **2** others even had the goal difference!',
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
      '**Bob** was the only one to predict the perfect score for **Bayern 1-0 Barcelona**! Nobody else even got the outcome of the match right!',
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
    ).toBe(
      '**Alice** was the only one to predict the perfect score for **2-1**! Nobody else even got the outcome of the match right!',
    );
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
      '**Alice and Bob** each predicted a perfect score nobody else got! Nobody else even got the outcome of the match right!',
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
      '**Alice** predicted the perfect score in **2** matches nobody else got! Nobody else even got the outcome of the match right!',
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
      title: 'Hvordan visste du det?',
      statistic:
        '**Alice** var den eneste som tippet perfekt resultat for **Arsenal 2-1 Bayern**! Bare **1** annen tippet i det hele tatt riktig utfall!',
    });
    expect(bestPredictionCard(rows, teams, 'de')).toMatchObject({
      title: 'Woher wusstest du das?',
      statistic:
        '**Alice** hat als einzige Person das perfekte Ergebnis für **Arsenal 2-1 Bayern** getippt! Nur **1** andere Person lag überhaupt beim Ausgang richtig!',
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
    expect(card?.title).toBe('Close enough!');
    expect(card?.statistic).toBe(
      '**Alice** predicted **0-4** in **Arsenal vs Bayern**, which finished **3-0**. Nobody else has missed a match by that much!',
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
    expect(card?.statistic).toContain('predicted **0-2**');
  });

  it('shows every member level on the same miss', () => {
    const card = worstPredictionCard(
      [scored('u1', [0, 4], [3, 0], 'f1'), scored('u2', [4, 0], [0, 3], 'f2')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice and Bob** have each missed a match by just as much. Nobody else has missed one by more!',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u1', 'u2']);
  });

  it('counts them instead when one member holds the whole tie', () => {
    const card = worstPredictionCard(
      [scored('u1', [0, 4], [3, 0], 'f1'), scored('u1', [4, 0], [0, 3], 'f2')],
      teams,
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice** has **2** predictions that missed by just as much. Nobody else has missed a match by that much!',
    );
    expect(card?.subjects.map(s => s.id)).toEqual(['u1']);
  });

  it('names the scoreline alone when the fixture has no teams yet', () => {
    expect(worstPredictionCard([scored('u1', [0, 4], [3, 0], 'f9')], teams, 'en')?.statistic).toBe(
      '**Alice** predicted **0-4** in a match that finished **3-0**. Nobody else has missed a match by that much!',
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
      title: 'Det var nesten da!',
      statistic:
        '**Alice** tippet **0-4** på **Arsenal mot Bayern**, som endte **3-0**. Ingen andre har bommet så stort på en kamp!',
    });
    expect(worstPredictionCard(rows, teams, 'de')).toMatchObject({
      title: 'Knapp daneben!',
      statistic:
        '**Alice** hat **0-4** bei **Arsenal gegen Bayern** getippt, das **3-0** endete. Niemand sonst hat bei einem Spiel so danebengelegen!',
    });
  });
});

describe('inHaalandWeTrustCard', () => {
  it('counts the believers, and names whoever has him lowest', () => {
    const card = inHaalandWeTrustCard(
      [
        rank('u1', 'p1', 'p2', 'p3'),
        rank('u2', 'p1', 'p3', 'p2'),
        rank('u3', 'p2', 'p3', 'p1'),
      ],
      players,
      'en',
    );
    expect(card?.title).toBe('In Haaland we trust');
    expect(card?.statistic).toBe(
      '**2** of **3** have Haaland finishing as top scorer! The one with the least faith in him: **Chris**, who put him **3rd** on the top-scorer list.',
    );
    expect(card?.subjects).toEqual([
      { type: 'player', id: 'p1', name: 'Haaland', imageUrl: '/api/images/haaland.png' },
    ]);
  });

  it('is the same title in every language', () => {
    const rows = [rank('u1', 'p1', 'p2'), rank('u2', 'p2', 'p1')];
    for (const lang of ['en', 'no', 'de'] as const) {
      expect(inHaalandWeTrustCard(rows, players, lang)?.title).toBe('In Haaland we trust');
    }
  });

  it('names every member level at the bottom of the faith', () => {
    const card = inHaalandWeTrustCard(
      [rank('u1', 'p1', 'p2', 'p3'), rank('u2', 'p2', 'p3', 'p1'), rank('u3', 'p3', 'p2', 'p1')],
      players,
      'en',
    );
    expect(card?.statistic).toContain('**Bob and Chris**');
    expect(card?.statistic).toContain('**3rd**');
  });

  it('counts only the rankings that place him at all', () => {
    const card = inHaalandWeTrustCard(
      [rank('u1', 'p1', 'p2'), rank('u2', 'p2', 'p3'), rank('u3', 'p2', 'p1')],
      players,
      'en',
    );
    expect(card?.statistic).toBe(
      '**1** of **2** have Haaland finishing as top scorer! The one with the least faith in him: **Chris**, who put him **2nd** on the top-scorer list.',
    );
  });

  it('drops the second sentence when the whole league has him top', () => {
    expect(
      inHaalandWeTrustCard([rank('u1', 'p1', 'p2'), rank('u2', 'p1', 'p3')], players, 'en')
        ?.statistic,
    ).toBe('**2** of **2** have Haaland finishing as top scorer!');
  });

  it('still runs when nobody backs him, which is the joke', () => {
    expect(
      inHaalandWeTrustCard([rank('u1', 'p2', 'p1'), rank('u2', 'p3', 'p2', 'p1')], players, 'en')
        ?.statistic,
    ).toBe(
      '**0** of **2** have Haaland finishing as top scorer! The one with the least faith in him: **Bob**, who put him **3rd** on the top-scorer list.',
    );
  });

  it('finds him however the provider spells him', () => {
    const brautHaaland = [
      { id: 'p1', name: 'Erling Braut Haaland', imageUrl: '/api/images/haaland.png' },
      { id: 'p2', name: 'Kane', imageUrl: null },
    ];
    expect(
      inHaalandWeTrustCard([rank('u1', 'p1', 'p2')], brautHaaland, 'en')?.subjects[0].name,
    ).toBe('Erling Braut Haaland');
  });

  it('is null where he is not playing, or where nobody has ranked him', () => {
    const withoutHim = players.filter(p => p.name !== 'Haaland');
    expect(inHaalandWeTrustCard([rank('u1', 'p2', 'p3')], withoutHim, 'en')).toBeNull();
    expect(inHaalandWeTrustCard([], players, 'en')).toBeNull();
    expect(inHaalandWeTrustCard([rank('u1', 'p2', 'p3')], players, 'en')).toBeNull();
  });

  it('translates the statistic, title aside', () => {
    const rows = [rank('u1', 'p1', 'p2', 'p3'), rank('u2', 'p2', 'p3', 'p1')];
    expect(inHaalandWeTrustCard(rows, players, 'no')?.statistic).toBe(
      '**1** av **2** har tippet at Haaland blir toppscorer! Brukeren som har minst tro på Brauten er **Bob**, som tippet at Haaland ender på **3. plass** på toppscorerlisten.',
    );
    expect(inHaalandWeTrustCard(rows, players, 'de')?.statistic).toBe(
      '**1** von **2** tippen Haaland als Torschützenkönig! Am wenigsten glaubt **Bob** an ihn — auf **Platz 3** der Torjägerliste.',
    );
  });

  it('says "Brukerne" and "glauben" when several share the bottom', () => {
    const rows = [rank('u1', 'p1', 'p2', 'p3'), rank('u2', 'p2', 'p3', 'p1'), rank('u3', 'p3', 'p2', 'p1')];
    expect(inHaalandWeTrustCard(rows, players, 'no')?.statistic).toContain(
      'Brukerne som har minst tro på Brauten er **Bob og Chris**',
    );
    expect(inHaalandWeTrustCard(rows, players, 'de')?.statistic).toContain(
      'Am wenigsten glauben **Bob und Chris** an ihn',
    );
  });
});

describe('buildLiveUserStats', () => {
  const all = {
    tablePredictions: [pick('u1', 't1', 't3')],
    teams,
    eliminationFrom: null,
    scorerPredictions: [rank('u1', 'p1', 'p3')],
    players,
    scoredPredictions: [],
    progression: null,
    scoringConfig,
    scorerNationalities: null,
    bonusAnswers: [],
  };

  it('drops cards that have nothing to say', () => {
    expect(
      buildLiveUserStats(
        {
          tablePredictions: [],
          teams,
          eliminationFrom: null,
          scorerPredictions: [],
          players,
          scoredPredictions: [],
          progression: null,
          scoringConfig,
          scorerNationalities: null,
          bonusAnswers: [],
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
      'inHaalandWeTrust',
    ]);
  });

  it('shows the scorer pair on its own when nobody has predicted a table', () => {
    expect(
      buildLiveUserStats({ ...all, tablePredictions: [] }, 'en').map(c => c.id),
    ).toEqual(['goldenBoot', 'goalDrought', 'inHaalandWeTrust']);
  });

  it('shows the table pair on its own when nobody has ranked the scorers', () => {
    expect(
      buildLiveUserStats({ ...all, scorerPredictions: [] }, 'en').map(c => c.id),
    ).toEqual(['peoplesFavourite', 'woodenSpoon']);
  });

  it('runs leaderboard cards first, then the rankings, then the predictions', () => {
    expect(
      buildLiveUserStats(
        {
          ...all,
          // Two rankings that disagree about which of the two teams goes out, so a band
          // starting at second place leaves each of them written off once and backed once.
          tablePredictions: [pick('u1', 't1', 't3'), pick('u2', 't3', 't1')],
          eliminationFrom: 2,
          scoredPredictions: [
            scored('u1', [1, 0], [1, 0], 'f1'),
            scored('u1', [2, 0], [3, 1], 'f2'),
            scored('u2', [0, 3], [1, 0], 'f1'),
          ],
          progression: progression([{ u1: 3, u2: 1 }]),
          scorerNationalities: snapshot({ Norway: { goals: 3, players: 2 } }),
        },
        'en',
      ).map(c => c.id),
    ).toEqual([
      'theLeader',
      'bestForm',
      'peoplesFavourite',
      'woodenSpoon',
      'lastBeliever',
      'goldenBoot',
      'goalDrought',
      'inHaalandWeTrust',
      'spotOn',
      'almost',
      'bestPrediction',
      'worstPrediction',
      'mostPredictableResult',
      'norwegianGoals',
    ]);
  });

  it('shows the near-miss card alone when nobody has called a scoreline', () => {
    expect(
      buildLiveUserStats({ ...all, scoredPredictions: [scored('u1', [1, 0], [2, 1])] }, 'en').map(
        c => c.id,
      ),
    ).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
      'goldenBoot',
      'goalDrought',
      'inHaalandWeTrust',
      'almost',
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
  /** An answer to the Norwegian-goals bonus question, from one member. */
  const guess = (userId: string, answer: string, question = 'Hvor mange mål blir scoret av norske spillere?') => ({
    ...memberOf(userId),
    question,
    answer,
  });

  const guesses = [guess('u1', '12'), guess('u2', '3'), guess('u3', '6')];

  it('reads the bonus question and the goals actually scored', () => {
    const card = nationalityGoalsCard(
      snapshot({ Norway: { goals: 5, players: 3 }, Spain: { goals: 40, players: 12 } }),
      guesses,
      'en',
    );
    expect(card?.title).toBe('Go Norway!');
    expect(card?.statistic).toBe(
      '**Alice** has the most faith in the Norwegian players! They have them scoring **12** goals in total this tournament!' +
        ' More than anybody else! **Bob**, meanwhile, has them managing only **3** Norwegian goals.' +
        ' The average guess is **7.0** goals between them.' +
        '\n\nSo far Norwegians have scored **5** goals between them! Spread across **3** different Norwegian scorers.',
    );
    // The flag is the tile's own background rather than a subject on it.
    expect(card?.subjects).toEqual([]);
    expect(card?.backgroundImageUrl).toBe('/stat-flag-no.webp');
  });

  it('stands on the predictions alone before anybody has scored', () => {
    expect(nationalityGoalsCard(null, guesses, 'en')?.statistic).toBe(
      '**Alice** has the most faith in the Norwegian players! They have them scoring **12** goals in total this tournament!' +
        ' More than anybody else! **Bob**, meanwhile, has them managing only **3** Norwegian goals.' +
        ' The average guess is **7.0** goals between them.',
    );
    expect(nationalityGoalsCard(snapshot({ Norway: { goals: 0, players: 0 } }), guesses, 'en')?.statistic).not.toContain(
      'So far',
    );
  });

  it('stands on the goals alone when nobody answered the question', () => {
    expect(
      nationalityGoalsCard(snapshot({ Norway: { goals: 9, players: 1 } }), [], 'en')?.statistic,
    ).toBe('So far Norwegians have scored **9** goals between them! All of them by **1** Norwegian scorer.');
  });

  it('names everyone level at either end, and drops the contrast when all guessed alike', () => {
    const tie = nationalityGoalsCard(null, [guess('u1', '9'), guess('u3', '9'), guess('u2', '2')], 'en');
    expect(tie?.statistic).toContain('**Alice and Chris** have the most faith');
    expect(tie?.statistic).toContain('**Bob**, meanwhile, has');

    const level = nationalityGoalsCard(null, [guess('u1', '7'), guess('u2', '7')], 'en');
    expect(level?.statistic).toBe(
      '**Alice and Bob** have the most faith in the Norwegian players! They have them scoring **7** goals in total this tournament! The average guess is **7.0** goals between them.',
    );
  });

  it('ignores answers to other questions, and answers that are not numbers', () => {
    const card = nationalityGoalsCard(
      null,
      [
        guess('u1', '12'),
        guess('u2', '40', 'Hvor mange mål blir scoret totalt?'),
        guess('u3', 'mange'),
      ],
      'en',
    );
    expect(card?.statistic).toBe(
      '**Alice** has the most faith in the Norwegian players! They have them scoring **12** goals in total this tournament! The average guess is **12.0** goals between them.',
    );
  });

  it('matches the country key whatever case the provider sends', () => {
    expect(nationalityGoalsCard(snapshot({ NORWAY: { goals: 5, players: 2 } }), [], 'en')).not.toBeNull();
    expect(nationalityGoalsCard(snapshot({ norway: { goals: 5, players: 2 } }), [], 'en')).not.toBeNull();
  });

  it('says "at least" when the feed was truncated, because the total is a floor', () => {
    const rows = { Norway: { goals: 23, players: 7 } };
    expect(nationalityGoalsCard(snapshot(rows, true), [], 'en')?.statistic).toBe(
      'So far Norwegians have scored **at least 23** goals between them! Spread across **7** different Norwegian scorers.',
    );
    expect(nationalityGoalsCard(snapshot(rows, true), [], 'no')?.statistic).toContain('**minst 23**');
    expect(nationalityGoalsCard(snapshot(rows, true), [], 'de')?.statistic).toContain('**mindestens 23**');
  });

  it('is null only when neither half has anything to say', () => {
    expect(nationalityGoalsCard(null, [], 'en')).toBeNull();
    expect(nationalityGoalsCard(snapshot({}), [], 'en')).toBeNull();
    expect(nationalityGoalsCard(snapshot({ Spain: { goals: 40, players: 12 } }), [], 'en')).toBeNull();
    expect(nationalityGoalsCard(snapshot({ Norway: { goals: 0, players: 3 } }), [], 'en')).toBeNull();
  });

  it('translates both halves', () => {
    const card = nationalityGoalsCard(snapshot({ Norway: { goals: 5, players: 3 } }), guesses, 'no');
    expect(card).toMatchObject({
      title: 'Heia Norge!',
      statistic:
        '**Alice** har mest trua på de norske spillerne! De har tippet at de scorer totalt **12** mål i turneringen!' +
        ' Det er flest av samtlige! **Bob**, imidlertid, har tippet at det kun blir **3** norske mål i turneringen.' +
        ' I gjennomsnitt er det tippet at norske spillere scorer til sammen **7.0** mål.' +
        '\n\nSå langt har norske spillere scoret **5** mål seg imellom! Fordelt på **3** forskjellige norske målscorere.',
    });
    expect(nationalityGoalsCard(snapshot({ Norway: { goals: 5, players: 3 } }), guesses, 'de')).toMatchObject({
      title: 'Los, Norwegen!',
      statistic:
        '**Alice** glaubt am meisten an die norwegischen Spieler! Getippt sind insgesamt **12** Tore in diesem Wettbewerb!' +
        ' Mehr als alle anderen! **Bob** hingegen tippt nur **3** norwegische Tore.' +
        ' Im Schnitt werden **7.0** norwegische Tore getippt.' +
        '\n\nBisher haben Norweger **5** Tore untereinander erzielt! Verteilt auf **3** verschiedene norwegische Torschützen.',
    });
  });

  it('joins the deck last, and only when it has something to say', () => {
    const base = {
      tablePredictions: [pick('u1', 't1', 't3')],
      teams,
      eliminationFrom: null,
      scorerPredictions: [rank('u1', 'p1', 'p3')],
      players,
      scoredPredictions: [],
      progression: null,
      scoringConfig,
      bonusAnswers: [],
    };
    expect(buildLiveUserStats({ ...base, scorerNationalities: null }, 'en').map(c => c.id)).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
      'goldenBoot',
      'goalDrought',
      'inHaalandWeTrust',
    ]);
    expect(
      buildLiveUserStats(
        { ...base, scorerNationalities: snapshot({ Norway: { goals: 3, players: 2 } }) },
        'en',
      ).map(c => c.id),
    ).toEqual([
      'peoplesFavourite',
      'woodenSpoon',
      'goldenBoot',
      'goalDrought',
      'inHaalandWeTrust',
      'norwegianGoals',
    ]);
  });

  it('shows on its own when nobody has predicted anything yet', () => {
    expect(
      buildLiveUserStats(
        {
          tablePredictions: [],
          teams,
          eliminationFrom: null,
          scorerPredictions: [],
          players,
          scoredPredictions: [],
          progression: null,
          scoringConfig,
          scorerNationalities: snapshot({ Norway: { goals: 3, players: 2 } }),
          bonusAnswers: [],
        },
        'en',
      ).map(c => c.id),
    ).toEqual(['norwegianGoals']);
  });
});
