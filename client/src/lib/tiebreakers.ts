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

// Sort group teams. Within each equal-points group, applies criteria in order:
//   1. H2H points  2. H2H GD  3. H2H GF  4. overall GD  5. overall GF
// Teams still equal on all five → disciplinary choices (manual, keyed by sub-group).
export function sortGroupTeams(
  teams: TeamTiebreakerStat[],
  groupMatches: MatchResult[],
  choices: DisciplinaryChoices = {},
): TeamTiebreakerStat[] {
  if (teams.length <= 1) return [...teams];

  // Group by overall points
  const byPoints = new Map<number, TeamTiebreakerStat[]>();
  for (const t of teams) {
    if (!byPoints.has(t.points)) byPoints.set(t.points, []);
    byPoints.get(t.points)!.push(t);
  }

  const result: TeamTiebreakerStat[] = [];
  for (const [, pointsGroup] of [...byPoints].sort(([a], [b]) => b - a)) {
    if (pointsGroup.length === 1) {
      result.push(pointsGroup[0]);
      continue;
    }

    // H2H stats computed among all teams in this equal-points group
    const h2h = computeH2HStats(pointsGroup.map(t => t.teamId), groupMatches);

    // Group by all 5 criteria to find truly tied sub-groups
    const criteriaGroups = new Map<string, TeamTiebreakerStat[]>();
    for (const t of pointsGroup) {
      const h = h2h.get(t.teamId)!;
      const key = `${h.points}|${h.gd}|${h.gf}|${t.gd}|${t.gf}`;
      if (!criteriaGroups.has(key)) criteriaGroups.set(key, []);
      criteriaGroups.get(key)!.push(t);
    }

    // Sort sub-groups by the same criteria order (all teams in a sub-group are identical)
    const sortedSubGroups = [...criteriaGroups.values()].sort((ga, gb) => {
      const ha = h2h.get(ga[0].teamId)!;
      const hb = h2h.get(gb[0].teamId)!;
      if (hb.points !== ha.points) return hb.points - ha.points;
      if (hb.gd !== ha.gd) return hb.gd - ha.gd;
      if (hb.gf !== ha.gf) return hb.gf - ha.gf;
      if (gb[0].gd !== ga[0].gd) return gb[0].gd - ga[0].gd;
      return gb[0].gf - ga[0].gf;
    });

    for (const subGroup of sortedSubGroups) {
      if (subGroup.length === 1) {
        result.push(subGroup[0]);
        continue;
      }
      // Disciplinary rank — key is the sub-group's teams, matching findGroupDisciplinaryTies
      const subKey = makeDisciplinaryKey(subGroup.map(t => t.teamId));
      const ranked = choices[subKey] ?? [];
      result.push(
        ...[...subGroup].sort((a, b) => {
          const ra = ranked.indexOf(a.teamId);
          const rb = ranked.indexOf(b.teamId);
          const da = ra === -1 ? Infinity : ra;
          const db = rb === -1 ? Infinity : rb;
          if (da !== db) return da - db;
          return a.teamId.localeCompare(b.teamId);
        }),
      );
    }
  }
  return result;
}

// Sort lucky loser candidates. Criteria in order:
//   1. overall points  2. overall GD  3. overall GF
// Teams still equal on all three → disciplinary choices (manual).
export function sortLuckyLosers(
  teams: TeamTiebreakerStat[],
  choices: DisciplinaryChoices = {},
): TeamTiebreakerStat[] {
  if (teams.length <= 1) return [...teams];

  // Group by all 3 criteria to find truly tied sub-groups
  const criteriaGroups = new Map<string, TeamTiebreakerStat[]>();
  for (const t of teams) {
    const key = `${t.points}|${t.gd}|${t.gf}`;
    if (!criteriaGroups.has(key)) criteriaGroups.set(key, []);
    criteriaGroups.get(key)!.push(t);
  }

  const sortedSubGroups = [...criteriaGroups.values()].sort((ga, gb) => {
    if (gb[0].points !== ga[0].points) return gb[0].points - ga[0].points;
    if (gb[0].gd !== ga[0].gd) return gb[0].gd - ga[0].gd;
    return gb[0].gf - ga[0].gf;
  });

  const result: TeamTiebreakerStat[] = [];
  for (const subGroup of sortedSubGroups) {
    if (subGroup.length === 1) {
      result.push(subGroup[0]);
      continue;
    }
    const subKey = makeDisciplinaryKey(subGroup.map(t => t.teamId));
    const ranked = choices[subKey] ?? [];
    result.push(
      ...[...subGroup].sort((a, b) => {
        const ra = ranked.indexOf(a.teamId);
        const rb = ranked.indexOf(b.teamId);
        const da = ra === -1 ? Infinity : ra;
        const db = rb === -1 ? Infinity : rb;
        if (da !== db) return da - db;
        return a.teamId.localeCompare(b.teamId);
      }),
    );
  }
  return result;
}

// Detect which teams in a group need disciplinary resolution (equal on all 5 criteria).
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

// Detect which lucky loser candidates need disciplinary resolution (equal on pts, GD, GF).
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
