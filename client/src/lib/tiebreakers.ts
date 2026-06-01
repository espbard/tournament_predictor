// Tiebreaker logic for group stage standings

export type MatchResult = {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
};

export type TeamTiebreakerStat = {
  teamId: string;
  points: number; // W*3 + D
  gd: number;     // GF - GA
  gf: number;     // goals for
};

// key = sorted teamIds joined by "|", value = teamIds ordered best→worst disciplinary
export type DisciplinaryChoices = Record<string, string[]>;

export function makeDisciplinaryKey(teamIds: string[]): string {
  return [...teamIds].sort().join('|');
}

function computeH2HStats(
  teamIds: string[],
  matches: MatchResult[],
): Map<string, { points: number; gd: number; gf: number }> {
  const teamSet = new Set(teamIds);
  const stats = new Map<string, { points: number; gd: number; gf: number }>(
    teamIds.map(id => [id, { points: 0, gd: 0, gf: 0 }]),
  );
  for (const m of matches) {
    if (!teamSet.has(m.homeTeamId) || !teamSet.has(m.awayTeamId)) continue;
    const home = stats.get(m.homeTeamId)!;
    const away = stats.get(m.awayTeamId)!;
    home.gf += m.homeScore;
    home.gd += m.homeScore - m.awayScore;
    away.gf += m.awayScore;
    away.gd += m.awayScore - m.homeScore;
    if (m.homeScore > m.awayScore) {
      home.points += 3;
    } else if (m.homeScore === m.awayScore) {
      home.points += 1;
      away.points += 1;
    } else {
      away.points += 3;
    }
  }
  return stats;
}

function disciplinaryRank(
  teamId: string,
  tiedGroup: TeamTiebreakerStat[],
  choices: DisciplinaryChoices,
): number {
  const key = makeDisciplinaryKey(tiedGroup.map(t => t.teamId));
  const ranking = choices[key];
  if (!ranking) return Infinity;
  const pos = ranking.indexOf(teamId);
  return pos === -1 ? Infinity : pos;
}

// Sort group teams using H2H tiebreakers (rules 1–5), then disciplinary
// groupMatches: all effective scored matches in the group
export function sortGroupTeams(
  teams: TeamTiebreakerStat[],
  groupMatches: MatchResult[],
  choices: DisciplinaryChoices = {},
): TeamTiebreakerStat[] {
  if (teams.length <= 1) return [...teams];

  const byPoints = new Map<number, TeamTiebreakerStat[]>();
  for (const t of teams) {
    if (!byPoints.has(t.points)) byPoints.set(t.points, []);
    byPoints.get(t.points)!.push(t);
  }

  const result: TeamTiebreakerStat[] = [];
  for (const [, group] of [...byPoints].sort(([a], [b]) => b - a)) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    const h2h = computeH2HStats(group.map(t => t.teamId), groupMatches);
    const sorted = [...group].sort((a, b) => {
      const ha = h2h.get(a.teamId)!;
      const hb = h2h.get(b.teamId)!;
      // H2H points → H2H GD → H2H GF
      if (hb.points !== ha.points) return hb.points - ha.points;
      if (hb.gd !== ha.gd) return hb.gd - ha.gd;
      if (hb.gf !== ha.gf) return hb.gf - ha.gf;
      // Overall GD → overall GF
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      // Disciplinary
      const da = disciplinaryRank(a.teamId, group, choices);
      const db = disciplinaryRank(b.teamId, group, choices);
      if (da !== db) return da - db;
      return a.teamId.localeCompare(b.teamId); // stable fallback
    });
    result.push(...sorted);
  }
  return result;
}

// Sort lucky loser candidates using overall stats only (they're from different groups)
// Tiebreaker order: points → overall GD → overall GF → disciplinary
export function sortLuckyLosers(
  teams: TeamTiebreakerStat[],
  choices: DisciplinaryChoices = {},
): TeamTiebreakerStat[] {
  return [...teams].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    if (b.gf !== a.gf) return b.gf - a.gf;
    // Find tied group: same points, gd, gf
    const tiedGroup = teams.filter(t => t.points === a.points && t.gd === a.gd && t.gf === a.gf);
    const da = disciplinaryRank(a.teamId, tiedGroup, choices);
    const db = disciplinaryRank(b.teamId, tiedGroup, choices);
    if (da !== db) return da - db;
    return a.teamId.localeCompare(b.teamId);
  });
}

// Detect which teams in a group need disciplinary resolution (equal on all 5 criteria)
export function findGroupDisciplinaryTies(
  teams: TeamTiebreakerStat[],
  groupMatches: MatchResult[],
): TeamTiebreakerStat[][] {
  const tiedGroups: TeamTiebreakerStat[][] = [];

  const byPoints = new Map<number, TeamTiebreakerStat[]>();
  for (const t of teams) {
    if (!byPoints.has(t.points)) byPoints.set(t.points, []);
    byPoints.get(t.points)!.push(t);
  }

  for (const [, group] of byPoints) {
    if (group.length <= 1) continue;
    const h2h = computeH2HStats(group.map(t => t.teamId), groupMatches);
    const byCriteria = new Map<string, TeamTiebreakerStat[]>();
    for (const t of group) {
      const h = h2h.get(t.teamId)!;
      const key = `${h.points}|${h.gd}|${h.gf}|${t.gd}|${t.gf}`;
      if (!byCriteria.has(key)) byCriteria.set(key, []);
      byCriteria.get(key)!.push(t);
    }
    for (const [, tied] of byCriteria) {
      if (tied.length >= 2) tiedGroups.push(tied);
    }
  }
  return tiedGroups;
}

// Detect which lucky loser candidates need disciplinary resolution (equal on GD and GF)
export function findLuckyLoserDisciplinaryTies(
  teams: TeamTiebreakerStat[],
): TeamTiebreakerStat[][] {
  const byCriteria = new Map<string, TeamTiebreakerStat[]>();
  for (const t of teams) {
    const key = `${t.points}|${t.gd}|${t.gf}`;
    if (!byCriteria.has(key)) byCriteria.set(key, []);
    byCriteria.get(key)!.push(t);
  }
  return [...byCriteria.values()].filter(g => g.length >= 2);
}
