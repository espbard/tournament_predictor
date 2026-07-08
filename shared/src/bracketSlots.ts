// Resolves which team is predicted to occupy each first-round knockout bracket
// slot, including "lucky loser" (best-ranked third-place) slots that are
// assigned according to official cross-group eligibility combos.

export type GroupStandingTeam = {
  teamId: string;
  points: number;
  gd: number;
  gf: number;
};

export type DisciplinaryChoices = Record<string, string[]>;

// Official WC2026 cross-group eligibility for each lucky-loser bracket slot,
// in slot-fill order — a third-place team can only fill a slot if its group
// is listed for that slot.
const WC2026_LUCKY_LOSER_COMBOS: string[][] = [
  ['A', 'B', 'C', 'D', 'F'],
  ['C', 'D', 'F', 'G', 'H'],
  ['B', 'E', 'F', 'I', 'J'],
  ['A', 'E', 'H', 'I', 'J'],
  ['C', 'E', 'F', 'H', 'I'],
  ['E', 'H', 'I', 'J', 'K'],
  ['E', 'F', 'G', 'I', 'J'],
  ['D', 'E', 'I', 'J', 'L'],
];

export function parseQualifierLabel(label: string): { position: number; groups: string[] } {
  const m = label.match(/^(\d+)([A-Z]+)$/);
  if (!m) return { position: 1, groups: [] };
  return { position: parseInt(m[1], 10), groups: m[2].split('') };
}

export function computeLuckyLoserLabels(
  firstRoundMatchCount: number,
  bracketSlots: Record<string, string>,
  groupNames: string[],
  directQualifiers: number,
): Record<string, string> {
  const existingGroups = new Set(groupNames);
  const emptySlots: string[] = [];
  for (let i = 0; i < firstRoundMatchCount; i++) {
    for (const side of ['home', 'away'] as const) {
      const slotId = `m${i + 1}_${side}`;
      if (!bracketSlots[slotId]) emptySlots.push(slotId);
    }
  }
  const result: Record<string, string> = {};
  for (let si = 0; si < emptySlots.length; si++) {
    if (si >= WC2026_LUCKY_LOSER_COMBOS.length) break;
    const validGroups = WC2026_LUCKY_LOSER_COMBOS[si].filter(g => existingGroups.has(g));
    if (validGroups.length > 0) {
      result[emptySlots[si]] = `${directQualifiers + 1}${validGroups.join('')}`;
    }
  }
  return result;
}

function maxBipartiteMatching(
  slots: Array<Set<string>>,
  teams: Array<GroupStandingTeam & { group: string }>,
): number {
  const matchTeam = new Array<number>(teams.length).fill(-1);
  function augment(si: number, visited: boolean[]): boolean {
    for (let ti = 0; ti < teams.length; ti++) {
      if (visited[ti] || !slots[si].has(teams[ti].group)) continue;
      visited[ti] = true;
      if (matchTeam[ti] === -1 || augment(matchTeam[ti], visited)) {
        matchTeam[ti] = si;
        return true;
      }
    }
    return false;
  }
  let count = 0;
  for (let si = 0; si < slots.length; si++) {
    if (augment(si, new Array<boolean>(teams.length).fill(false))) count++;
  }
  return count;
}

function sortLuckyLoserCandidates(
  teams: Array<GroupStandingTeam & { group: string }>,
  choices: DisciplinaryChoices,
): Array<GroupStandingTeam & { group: string }> {
  const byCriteria = new Map<string, Array<GroupStandingTeam & { group: string }>>();
  for (const t of teams) {
    const key = `${t.points}|${t.gd}|${t.gf}`;
    if (!byCriteria.has(key)) byCriteria.set(key, []);
    byCriteria.get(key)!.push(t);
  }
  const sortedGroups = [...byCriteria.values()].sort((ga, gb) => {
    if (gb[0].points !== ga[0].points) return gb[0].points - ga[0].points;
    if (gb[0].gd !== ga[0].gd) return gb[0].gd - ga[0].gd;
    return gb[0].gf - ga[0].gf;
  });
  const result: Array<GroupStandingTeam & { group: string }> = [];
  for (const group of sortedGroups) {
    if (group.length === 1) { result.push(group[0]); continue; }
    const key = [...group.map(t => t.teamId)].sort().join('|');
    const ranked = choices[key] ?? [];
    result.push(
      ...[...group].sort((a, b) => {
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

// Resolves the predicted occupant team ID for every first-round bracket slot —
// both direct group-position qualifiers (e.g. "1A") and lucky-loser slots
// (left as blank labels in bracketSlots, filled via cross-group eligibility).
export function resolveFirstRoundSlots(
  bracketSlots: Record<string, string>,
  groupStandings: Map<string, GroupStandingTeam[]>,
  directQualifiers: number,
  firstRoundMatchCount: number,
  luckyLoserDisciplinaryChoices: DisciplinaryChoices = {},
): Record<string, string | null> {
  const resolved: Record<string, string | null> = {};

  for (const [slotId, label] of Object.entries(bracketSlots)) {
    const { position, groups } = parseQualifierLabel(label);
    if (position <= directQualifiers && groups.length === 1) {
      resolved[slotId] = groupStandings.get(groups[0])?.[position - 1]?.teamId ?? null;
    }
  }

  const groupNames = [...groupStandings.keys()];
  const luckyLoserLabels = computeLuckyLoserLabels(firstRoundMatchCount, bracketSlots, groupNames, directQualifiers);

  const llSlots: Array<{ slotId: string; groups: Set<string> }> = [];
  for (let i = 0; i < firstRoundMatchCount; i++) {
    for (const side of ['home', 'away'] as const) {
      const slotId = `m${i + 1}_${side}`;
      const label = luckyLoserLabels[slotId];
      if (!label) continue;
      const { groups } = parseQualifierLabel(label);
      llSlots.push({ slotId, groups: new Set(groups) });
    }
  }

  const allLL = sortLuckyLoserCandidates(
    [...groupStandings.entries()]
      .filter(([, t]) => t.length > directQualifiers)
      .map(([groupName, t]) => ({ ...t[directQualifiers], group: groupName })),
    luckyLoserDisciplinaryChoices,
  );

  // Only the top-N ranked third-place teams (N = number of lucky-loser slots) ever
  // qualify — that determination is purely rank-based per the real tournament rule.
  // The eligibility-matching below only decides *which* slot a qualified team fills,
  // never whether a lower-ranked team can bump a higher-ranked one into a slot.
  const qualifiedLL = allLL.slice(0, llSlots.length);

  function solve(slotIdx: number, available: Array<GroupStandingTeam & { group: string }>): void {
    if (slotIdx === llSlots.length) return;
    const { slotId, groups } = llSlots[slotIdx];
    const M = maxBipartiteMatching(llSlots.slice(slotIdx).map(s => s.groups), available);
    const candidates = available.filter(t => groups.has(t.group));
    for (const candidate of candidates) {
      const remaining = available.filter(t => t.teamId !== candidate.teamId);
      const Mrem = maxBipartiteMatching(llSlots.slice(slotIdx + 1).map(s => s.groups), remaining);
      if (Mrem >= M - 1) {
        resolved[slotId] = candidate.teamId;
        solve(slotIdx + 1, remaining);
        return;
      }
    }
    resolved[slotId] = null;
    solve(slotIdx + 1, available);
  }

  solve(0, qualifiedLL);
  return resolved;
}
