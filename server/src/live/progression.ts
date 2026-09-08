import type {
  LeaderboardProgressionMatch,
  LeaderboardProgressionResponse,
  LiveFixtureStatus,
} from '@tournament-predictor/shared';

// ── Points progression for live competitions ──────────────────────────────────
//
// The running total each member had after every fixture that has been played, in the
// shape the chart already speaks: LeaderboardProgressionResponse, the same payload
// server/src/routes/competitions.ts builds for the manual type, so both tournament types
// render through client/src/components/LeaderboardLineGraph.tsx untouched. The response
// type is the only thing shared — none of the manual builder's logic carries over, since
// there are no group positions, no bracket and no late additions here.
//
// Composing is pure and takes the rows as arguments, the same way userStats.ts does, so
// the ordering and the milestone rules can be pinned by unit tests without a database.
//
// Three things decide what becomes a milestone:
//
//   * A fixture counts once it is finished. Points come from the stored per-prediction
//     totals rather than being rescored here, so the last milestone always agrees with
//     the leaderboard's denormalised totals.
//   * A fixture the admin left out of its gameweek is not part of the game and is
//     skipped. So is one the provider has moved back out of `finished`. Either way,
//     scored predictions win: those points are on the leaderboard whatever has happened
//     to the fixture since, and a chart that dropped them would end below it.
//   * The season-long side bets — the league table, the top-scorer ranking and the bonus
//     questions — are one lump each, awarded at the end, so they become one milestone
//     each after the last fixture, and only once they are actually worth something.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §2 and §9.

export type LiveProgressionLang = 'en' | 'no' | 'de';

export interface LiveProgressionMember {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
}

export interface LiveProgressionTeam {
  id: string;
  name: string;
  shortName: string | null;
  tla: string | null;
}

export interface LiveProgressionFixture {
  id: string;
  kickoffAt: Date | string | null;
  status: LiveFixtureStatus;
  stageKey: string | null;
  matchday: number | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  /** Whether the admin picked this fixture for its gameweek — see the note above. */
  isSelected: boolean;
}

/** One member's points for one fixture, straight off live_predictions. */
export interface LiveProgressionPrediction {
  userId: string;
  liveFixtureId: string;
  points: number | null;
}

/** One member's points from a season-long side bet. Null until that bet is scored. */
export interface LiveProgressionUserPoints {
  userId: string;
  points: number | null;
}

export interface LiveProgressionInput {
  members: LiveProgressionMember[];
  teams: LiveProgressionTeam[];
  fixtures: LiveProgressionFixture[];
  predictions: LiveProgressionPrediction[];
  /** A format could have more than one table stage, so these are summed per member. */
  tablePoints: LiveProgressionUserPoints[];
  scorerPoints: LiveProgressionUserPoints[];
  /** One row per answered bonus question. */
  bonusPoints: LiveProgressionUserPoints[];
}

const SEASON_LABELS: Record<LiveProgressionLang, { table: string; scorers: string; bonus: string }> = {
  en: { table: 'Table', scorers: 'Top scorers', bonus: 'Bonus' },
  no: { table: 'Tabell', scorers: 'Toppscorere', bonus: 'Bonus' },
  de: { table: 'Tabelle', scorers: 'Torjäger', bonus: 'Bonus' },
};

/** "ARS", "BAY" — the provider's three-letter code where there is one, else a stub. */
function teamAbbr(team: LiveProgressionTeam): string {
  return (team.tla ?? team.shortName ?? team.name).slice(0, 3).toUpperCase();
}

/**
 * The x-axis label for one fixture.
 *
 * Both teams are known for anything that has actually been played, so the placeholders
 * are only ever reached by a knockout fixture whose teams were cleared after the fact —
 * a stub reads better there than an empty tick.
 */
export function liveFixtureLabel(
  fixture: LiveProgressionFixture,
  teamsById: Map<string, LiveProgressionTeam>,
): string {
  const home = fixture.homeTeamId ? teamsById.get(fixture.homeTeamId) : null;
  const away = fixture.awayTeamId ? teamsById.get(fixture.awayTeamId) : null;
  if (home || away) return `${home ? teamAbbr(home) : '?'} vs ${away ? teamAbbr(away) : '?'}`;
  return fixture.matchday != null ? `MD ${fixture.matchday}` : '?';
}

/** Kickoff order, with an undated fixture last and the id breaking ties. */
function byKickoff(a: LiveProgressionFixture, b: LiveProgressionFixture): number {
  const at = a.kickoffAt ? new Date(a.kickoffAt).getTime() : Infinity;
  const bt = b.kickoffAt ? new Date(b.kickoffAt).getTime() : Infinity;
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}

function sumByUser(rows: LiveProgressionUserPoints[], memberIds: Set<string>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.points == null || !memberIds.has(row.userId)) continue;
    totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.points);
  }
  return totals;
}

export function buildLiveProgression(
  input: LiveProgressionInput,
  lang: LiveProgressionLang = 'en',
): LeaderboardProgressionResponse {
  const { members, teams, fixtures, predictions } = input;
  const memberIds = new Set(members.map(m => m.userId));
  const teamsById = new Map(teams.map(t => [t.id, t]));

  // fixtureId -> userId -> points. Only scored predictions by current members: someone who
  // left the competition keeps their prediction rows, and they are not in this chart.
  const pointsByFixture = new Map<string, Map<string, number>>();
  for (const prediction of predictions) {
    if (prediction.points == null || !memberIds.has(prediction.userId)) continue;
    let forFixture = pointsByFixture.get(prediction.liveFixtureId);
    if (!forFixture) {
      forFixture = new Map();
      pointsByFixture.set(prediction.liveFixtureId, forFixture);
    }
    forFixture.set(prediction.userId, (forFixture.get(prediction.userId) ?? 0) + prediction.points);
  }

  const played = fixtures
    .filter(f => pointsByFixture.has(f.id) || (f.status === 'finished' && f.isSelected))
    .sort(byKickoff);

  const milestones: LeaderboardProgressionMatch[] = [];
  const cumulative: Record<string, number> = {};
  for (const member of members) cumulative[member.userId] = 0;

  for (const fixture of played) {
    const awarded = pointsByFixture.get(fixture.id);
    if (awarded) {
      for (const [userId, points] of awarded) cumulative[userId] += points;
    }
    milestones.push({
      matchId: fixture.id,
      label: liveFixtureLabel(fixture, teamsById),
      stage: fixture.stageKey ?? 'fixture',
      cumulativePoints: { ...cumulative },
    });
  }

  // The side bets, in the order they are settled: the table when its stage ends, the
  // ranking and the bonus questions when the tournament is marked completed. Each is
  // withheld from the chart until it has actually awarded something, so a season still
  // being played does not end on three flat steps.
  const labels = SEASON_LABELS[lang];
  const seasonSources = [
    { id: 'table', label: labels.table, totals: sumByUser(input.tablePoints, memberIds) },
    { id: 'scorers', label: labels.scorers, totals: sumByUser(input.scorerPoints, memberIds) },
    { id: 'bonus', label: labels.bonus, totals: sumByUser(input.bonusPoints, memberIds) },
  ] as const;

  for (const source of seasonSources) {
    let awardedAnything = false;
    for (const points of source.totals.values()) {
      if (points !== 0) { awardedAnything = true; break; }
    }
    if (!awardedAnything) continue;

    for (const [userId, points] of source.totals) cumulative[userId] += points;
    milestones.push({
      matchId: source.id,
      label: source.label,
      stage: source.id,
      cumulativePoints: { ...cumulative },
    });
  }

  return {
    matches: milestones,
    users: members.map(m => ({
      userId: m.userId,
      username: m.username,
      imageUrl: m.imageUrl,
      iconColor: m.iconColor,
    })),
  };
}
