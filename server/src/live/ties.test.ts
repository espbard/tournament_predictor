import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_SCORING_CONFIG,
  LIVE_FORMATS,
  actualAdvancer,
  advancePickApplies,
  carriedScore,
  indexSecondLegs,
  predictedAdvancer,
  type TieLegFixture,
} from '@tournament-predictor/shared';
import { calculateLivePoints } from './scoring';

// The team-through point on second legs: shared/src/live/ties.ts decides who goes
// through, server/src/live/scoring.ts pays for it. Pure functions only.

const UCL = LIVE_FORMATS.ucl_swiss;
const A = 'teamA';
const B = 'teamB';

function leg(over: Partial<TieLegFixture>): TieLegFixture {
  return {
    id: 'x',
    stageKey: 'round_of_16',
    tieKey: 'round_of_16:teamA-teamB',
    legNumber: 1,
    homeTeamId: B,
    awayTeamId: A,
    status: 'finished',
    normalTimeHome: null,
    normalTimeAway: null,
    ...over,
  };
}

/**
 * Example A, as agreed: first leg Team B 2-1 Team A (B at home), second leg Team A 2-0
 * Team B (A at home). A goes through 3-2 on aggregate.
 */
const firstLeg = leg({ id: 'leg1', homeTeamId: B, awayTeamId: A, normalTimeHome: 2, normalTimeAway: 1 });
const secondLeg = leg({
  id: 'leg2',
  legNumber: 2,
  homeTeamId: A,
  awayTeamId: B,
  normalTimeHome: 2,
  normalTimeAway: 0,
});

function scoreSecondLeg(homeScore: number, awayScore: number, pickedTeamId: string | null = null, multiplier = 1) {
  const carried = carriedScore(firstLeg, secondLeg);
  return calculateLivePoints(
    { homeScore, awayScore },
    { status: 'finished', normalTimeHome: 2, normalTimeAway: 0, multiplier },
    DEFAULT_LIVE_SCORING_CONFIG,
    {
      predictedTeamId: predictedAdvancer({
        carried,
        homeScore,
        awayScore,
        homeTeamId: A,
        awayTeamId: B,
        pickedTeamId,
      }),
      actualTeamId: actualAdvancer(firstLeg, secondLeg),
    },
  );
}

describe('carriedScore', () => {
  it('shows the first leg from the second leg home team’s side', () => {
    expect(carriedScore(firstLeg, secondLeg)).toEqual({ home: 1, away: 2 });
  });

  it('shows a 2-0 first-leg home win as (0-2) when the teams swap ends', () => {
    const first = leg({ homeTeamId: A, awayTeamId: B, normalTimeHome: 2, normalTimeAway: 0 });
    const second = leg({ legNumber: 2, homeTeamId: B, awayTeamId: A, status: 'scheduled' });
    expect(carriedScore(first, second)).toEqual({ home: 0, away: 2 });
  });

  it('is unknown until the first leg has finished with a 90-minute score', () => {
    expect(carriedScore(null, secondLeg)).toBeNull();
    expect(carriedScore({ ...firstLeg, status: 'in_play' }, secondLeg)).toBeNull();
    expect(carriedScore({ ...firstLeg, normalTimeHome: null }, secondLeg)).toBeNull();
  });
});

describe('Example A', () => {
  it('sends A through', () => {
    expect(actualAdvancer(firstLeg, secondLeg)).toBe(A);
  });

  it('User A, 5-0: outcome and team through, 2 points', () => {
    const p = scoreSecondLeg(5, 0);
    expect(p).toMatchObject({ correctOutcomePoints: 1, advancingTeamPoints: 1, points: 2 });
  });

  it('User B, 1-0 picking B: level on aggregate, wrong pick, 1 point', () => {
    expect(advancePickApplies(carriedScore(firstLeg, secondLeg), 1, 0)).toBe(true);
    const p = scoreSecondLeg(1, 0, B);
    expect(p).toMatchObject({ correctOutcomePoints: 1, advancingTeamPoints: 0, points: 1 });
  });

  it('User C, 1-0 picking A: 2 points', () => {
    expect(scoreSecondLeg(1, 0, A)).toMatchObject({ advancingTeamPoints: 1, points: 2 });
  });

  it('User D, 2-0: every tier and the team through, 5 points', () => {
    expect(scoreSecondLeg(2, 0)).toEqual({
      points: 5,
      correctOutcomePoints: 1,
      correctGoalDifferencePoints: 1,
      exactScorePoints: 2,
      advancingTeamPoints: 1,
      multiplierBonusPoints: 0,
    });
  });

  it('a level prediction with no pick sends nobody through and earns no point for it', () => {
    expect(scoreSecondLeg(1, 0, null)).toMatchObject({ advancingTeamPoints: 0, points: 1 });
  });

  it('ignores a pick when the predicted total is not level', () => {
    // 0-3: B through 5-1 on the prediction, whatever was picked.
    expect(scoreSecondLeg(0, 3, A)).toMatchObject({ advancingTeamPoints: 0, points: 0 });
  });

  it('multiplies the team-through point with the rest', () => {
    expect(scoreSecondLeg(5, 0, null, 3)).toMatchObject({
      correctOutcomePoints: 1,
      advancingTeamPoints: 1,
      multiplierBonusPoints: 4,
      points: 6,
    });
  });

  it('pays nothing for the team through when it is not yet known', () => {
    const p = calculateLivePoints(
      { homeScore: 5, awayScore: 0 },
      { status: 'finished', normalTimeHome: 2, normalTimeAway: 0 },
      DEFAULT_LIVE_SCORING_CONFIG,
      { predictedTeamId: A, actualTeamId: null },
    );
    expect(p).toMatchObject({ advancingTeamPoints: 0, points: 1 });
  });
});

describe('advancePickApplies', () => {
  it('always offers the pick before the first leg is played', () => {
    expect(advancePickApplies(null, 3, 0)).toBe(true);
    expect(advancePickApplies(null, null, null)).toBe(true);
  });

  it('offers it only on a level total once the first leg is known', () => {
    expect(advancePickApplies({ home: 1, away: 2 }, 1, 0)).toBe(true);
    expect(advancePickApplies({ home: 1, away: 2 }, 2, 0)).toBe(false);
    expect(advancePickApplies({ home: 1, away: 2 }, null, 0)).toBe(false);
  });
});

describe('actualAdvancer — real second legs from the captured 2024/25 payloads', () => {
  it('counts extra-time goals: Inter 4-3 Barça aet after 3-3 in Barcelona', () => {
    const first = leg({ homeTeamId: 'barca', awayTeamId: 'inter', normalTimeHome: 3, normalTimeAway: 3 });
    const second = leg({
      legNumber: 2,
      homeTeamId: 'inter',
      awayTeamId: 'barca',
      normalTimeHome: 3,
      normalTimeAway: 3,
      extraTimeHome: 1,
      extraTimeAway: 0,
      winner: 'HOME_TEAM',
    });
    expect(actualAdvancer(first, second)).toBe('inter');
  });

  it('goes to penalties: Liverpool 0-1 PSG after PSG 0-1 Liverpool, PSG 4-1 on pens', () => {
    const first = leg({ homeTeamId: 'psg', awayTeamId: 'liv', normalTimeHome: 0, normalTimeAway: 1 });
    const second = leg({
      legNumber: 2,
      homeTeamId: 'liv',
      awayTeamId: 'psg',
      normalTimeHome: 0,
      normalTimeAway: 1,
      extraTimeHome: 0,
      extraTimeAway: 0,
      penaltiesHome: 1,
      penaltiesAway: 4,
      winner: 'AWAY_TEAM',
    });
    expect(actualAdvancer(first, second)).toBe('psg');
  });

  it('does not trust the match winner when the aggregate says otherwise', () => {
    // Won the second leg 1-0, out 1-2 on aggregate.
    const first = leg({ homeTeamId: B, awayTeamId: A, normalTimeHome: 0, normalTimeAway: 2 });
    const second = leg({ legNumber: 2, homeTeamId: A, awayTeamId: B, normalTimeHome: 1, normalTimeAway: 0, winner: 'HOME_TEAM' });
    expect(actualAdvancer(first, second)).toBe(A);
    const second2 = { ...second, homeTeamId: B, awayTeamId: A, normalTimeHome: 1, normalTimeAway: 0 };
    expect(actualAdvancer(first, second2)).toBe(A);
  });

  it('stays unknown when level with nothing to settle it, until an admin says', () => {
    const first = leg({ homeTeamId: B, awayTeamId: A, normalTimeHome: 1, normalTimeAway: 0 });
    const second = leg({ legNumber: 2, homeTeamId: A, awayTeamId: B, normalTimeHome: 1, normalTimeAway: 0 });
    expect(actualAdvancer(first, second)).toBeNull();
    expect(actualAdvancer(first, { ...second, advancingTeamOverride: B })).toBe(B);
  });

  it('is unknown before the second leg finishes', () => {
    expect(actualAdvancer(firstLeg, { ...secondLeg, status: 'in_play' })).toBeNull();
  });
});

describe('indexSecondLegs', () => {
  it('pairs a second leg with its first by tie key', () => {
    const index = indexSecondLegs(UCL, [firstLeg, secondLeg]);
    expect([...index.keys()]).toEqual(['leg2']);
    expect(index.get('leg2')).toEqual({ firstLegId: 'leg1', carried: { home: 1, away: 2 }, actualAdvancerId: A });
  });

  it('leaves out first legs, the final and table stages', () => {
    const final = leg({ id: 'f', stageKey: 'final', legNumber: 2 });
    const league = leg({ id: 'l', stageKey: 'league_phase', legNumber: 2 });
    expect(indexSecondLegs(UCL, [firstLeg, final, league]).size).toBe(0);
  });
});
