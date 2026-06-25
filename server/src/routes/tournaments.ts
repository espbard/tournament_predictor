import { Router } from 'express';
import { eq, inArray, and, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { tournaments, teams, matches, groups, bonusQuestions, competitions, players } from '../db/schema';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  CreateTournamentSchema,
  UpdateTournamentSchema,
  CreateTeamSchema,
  UpdateTeamSchema,
  CreateMatchSchema,
  UpdateMatchSchema,
  CreateGroupSchema,
  UpdateKnockoutConfigSchema,
  CreateBonusQuestionSchema,
  UpdateBonusQuestionSchema,
  CreatePlayerSchema,
  UpdatePlayerSchema,
} from '@tournament-predictor/shared';
import type { KnockoutConfig } from '@tournament-predictor/shared';
import { triggerScoringForMatch, triggerBonusScoring, recalculateAllScoresForTournament } from '../lib/scoringTrigger';
import { generateId } from 'lucia';

// ── Types ──────────────────────────────────────────────────────────────────────

type TeamStat = { teamId: string; points: number; gd: number; gf: number };
type H2HStat = { points: number; gd: number; gf: number };
type RawMatch = { homeTeamId: string | null; awayTeamId: string | null; homeScore: number | null; awayScore: number | null };

const KNOCKOUT_STAGES = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final'] as const;

const FIRST_ROUND_MATCH_COUNTS: Record<string, number> = {
  round_of_32: 16,
  round_of_16: 8,
  quarter_final: 4,
  semi_final: 2,
  final: 1,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeH2HStats(teamIds: string[], matches: RawMatch[]): Map<string, H2HStat> {
  const teamSet = new Set(teamIds);
  const stats = new Map<string, H2HStat>(teamIds.map(id => [id, { points: 0, gd: 0, gf: 0 }]));
  for (const m of matches) {
    if (!m.homeTeamId || !m.awayTeamId || m.homeScore === null || m.awayScore === null) continue;
    if (!teamSet.has(m.homeTeamId) || !teamSet.has(m.awayTeamId)) continue;
    const home = stats.get(m.homeTeamId)!;
    const away = stats.get(m.awayTeamId)!;
    home.gf += m.homeScore; home.gd += m.homeScore - m.awayScore;
    away.gf += m.awayScore; away.gd += m.awayScore - m.homeScore;
    if (m.homeScore > m.awayScore) { home.points += 3; }
    else if (m.homeScore === m.awayScore) { home.points += 1; away.points += 1; }
    else { away.points += 3; }
  }
  return stats;
}

function sortGroupTeamsWithH2H(
  teams: TeamStat[],
  groupMatches: RawMatch[],
  disciplinaryChoices: Record<string, string[]> = {},
): TeamStat[] {
  if (teams.length <= 1) return [...teams];

  const byPoints = new Map<number, TeamStat[]>();
  for (const t of teams) {
    if (!byPoints.has(t.points)) byPoints.set(t.points, []);
    byPoints.get(t.points)!.push(t);
  }

  const result: TeamStat[] = [];
  for (const [, group] of [...byPoints].sort(([a], [b]) => b - a)) {
    if (group.length === 1) { result.push(group[0]); continue; }
    const h2h = computeH2HStats(group.map(t => t.teamId), groupMatches);
    const key = [...group.map(t => t.teamId)].sort().join('|');
    const ranking = disciplinaryChoices[key];
    const sorted = [...group].sort((a, b) => {
      const ha = h2h.get(a.teamId)!; const hb = h2h.get(b.teamId)!;
      if (hb.points !== ha.points) return hb.points - ha.points;
      if (hb.gd !== ha.gd) return hb.gd - ha.gd;
      if (hb.gf !== ha.gf) return hb.gf - ha.gf;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      if (ranking) {
        const da = ranking.indexOf(a.teamId);
        const db = ranking.indexOf(b.teamId);
        if (da !== -1 && db !== -1 && da !== db) return da - db;
      }
      return a.teamId.localeCompare(b.teamId);
    });
    result.push(...sorted);
  }
  return result;
}

function computeGroupStandings(
  completedMatches: RawMatch[],
  teamGroupMap: Map<string, string>,
  disciplinaryChoices: Record<string, string[]> = {},
): Map<string, TeamStat[]> {
  const groupStats = new Map<string, Map<string, TeamStat>>();
  const groupMatchesMap = new Map<string, RawMatch[]>();

  for (const m of completedMatches) {
    if (!m.homeTeamId || !m.awayTeamId || m.homeScore === null || m.awayScore === null) continue;
    const homeGroup = teamGroupMap.get(m.homeTeamId);
    const awayGroup = teamGroupMap.get(m.awayTeamId);
    if (!homeGroup || !awayGroup || homeGroup !== awayGroup) continue;

    if (!groupStats.has(homeGroup)) {
      groupStats.set(homeGroup, new Map());
      groupMatchesMap.set(homeGroup, []);
    }
    const statsMap = groupStats.get(homeGroup)!;
    groupMatchesMap.get(homeGroup)!.push(m);

    if (!statsMap.has(m.homeTeamId)) statsMap.set(m.homeTeamId, { teamId: m.homeTeamId, points: 0, gd: 0, gf: 0 });
    if (!statsMap.has(m.awayTeamId)) statsMap.set(m.awayTeamId, { teamId: m.awayTeamId, points: 0, gd: 0, gf: 0 });

    const home = statsMap.get(m.homeTeamId)!;
    const away = statsMap.get(m.awayTeamId)!;
    home.gf += m.homeScore; home.gd += m.homeScore - m.awayScore;
    away.gf += m.awayScore; away.gd += m.awayScore - m.homeScore;
    if (m.homeScore > m.awayScore) { home.points += 3; }
    else if (m.homeScore === m.awayScore) { home.points += 1; away.points += 1; }
    else { away.points += 3; }
  }

  const result = new Map<string, TeamStat[]>();
  for (const [groupName, statsMap] of groupStats) {
    const groupMatches = groupMatchesMap.get(groupName) ?? [];
    result.set(groupName, sortGroupTeamsWithH2H([...statsMap.values()], groupMatches, disciplinaryChoices));
  }
  return result;
}

async function generateFirstRoundKnockout(tournamentId: string): Promise<void> {
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
  if (!tournament?.knockoutConfig) return;

  const cfg = tournament.knockoutConfig as KnockoutConfig;
  const { firstRound, bracketSlots, directQualifiers, luckyLosers, hasBronzeFinal } = cfg;
  const groupDisciplinaryChoices = cfg.groupDisciplinaryChoices ?? {};
  const luckyLoserDisciplinaryChoices = cfg.luckyLoserDisciplinaryChoices ?? {};
  const matchCount = FIRST_ROUND_MATCH_COUNTS[firstRound] ?? 0;
  if (matchCount === 0) return;

  // Build teamId → groupName map
  const teamRows = await db.select({ id: teams.id, groupId: teams.groupId }).from(teams).where(eq(teams.tournamentId, tournamentId));
  const groupRows = await db.select().from(groups).where(eq(groups.tournamentId, tournamentId));
  const groupNameMap = new Map(groupRows.map(g => [g.id, g.name]));
  const teamGroupMap = new Map<string, string>();
  for (const t of teamRows) {
    if (t.groupId) {
      const gName = groupNameMap.get(t.groupId);
      if (gName) teamGroupMap.set(t.id, gName);
    }
  }

  // Get all group stage matches
  const allGroupMatches = await db.select().from(matches).where(
    and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'))
  );

  // Use admin-confirmed standings when locked, otherwise compute from results
  let standings: Map<string, TeamStat[]>;
  if (cfg.groupStandingsLocked && cfg.confirmedGroupStandings) {
    standings = new Map(
      Object.entries(cfg.confirmedGroupStandings).map(([groupName, teamIds]) => [
        groupName,
        teamIds.map(id => ({ teamId: id, points: 0, gd: 0, gf: 0 })),
      ]),
    );
  } else {
    const completedGroupMatches = allGroupMatches.filter(m => m.status === 'completed');
    standings = computeGroupStandings(completedGroupMatches, teamGroupMap, groupDisciplinaryChoices);
  }

  // Resolve direct qualifier label (e.g. "1A") → teamId
  function qualifierToTeamId(label: string): string | null {
    const m = label.match(/^(\d+)([A-Z])$/);
    if (!m) return null;
    const pos = parseInt(m[1]) - 1;
    const groupStandings = standings.get(m[2]);
    return groupStandings && groupStandings.length > pos ? groupStandings[pos].teamId : null;
  }

  // Collect lucky losers — use confirmed list when locked, otherwise rank algorithmically
  let selectedLuckyLosers: string[];
  if (cfg.groupStandingsLocked && cfg.confirmedLuckyLosers) {
    selectedLuckyLosers = cfg.confirmedLuckyLosers.slice(0, luckyLosers);
  } else {
    const luckyLoserCandidates: TeamStat[] = [];
    for (const [, gs] of standings) {
      if (gs.length > directQualifiers) luckyLoserCandidates.push(gs[directQualifiers]);
    }
    luckyLoserCandidates.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      const tied = luckyLoserCandidates.filter(
        t => t.points === a.points && t.gd === a.gd && t.gf === a.gf,
      );
      const key = [...tied.map(t => t.teamId)].sort().join('|');
      const ranking = luckyLoserDisciplinaryChoices[key];
      if (ranking) {
        const da = ranking.indexOf(a.teamId);
        const db = ranking.indexOf(b.teamId);
        if (da !== -1 && db !== -1 && da !== db) return da - db;
      }
      return a.teamId.localeCompare(b.teamId);
    });
    selectedLuckyLosers = luckyLoserCandidates.slice(0, luckyLosers).map(t => t.teamId);
  }

  // Empty bracket slots (left-to-right) → lucky losers in order
  const emptySlots: string[] = [];
  for (let i = 1; i <= matchCount; i++) {
    if (!bracketSlots[`m${i}_home`]) emptySlots.push(`m${i}_home`);
    if (!bracketSlots[`m${i}_away`]) emptySlots.push(`m${i}_away`);
  }
  const luckyLoserSlotMap = new Map<string, string>();
  for (let i = 0; i < Math.min(emptySlots.length, selectedLuckyLosers.length); i++) {
    luckyLoserSlotMap.set(emptySlots[i], selectedLuckyLosers[i]);
  }

  // Base date = latest group match date (or today)
  const datedMatches = allGroupMatches.filter(m => m.scheduledAt).sort(
    (a, b) => new Date(b.scheduledAt!).getTime() - new Date(a.scheduledAt!).getTime()
  );
  const baseDate = datedMatches.length > 0 ? new Date(datedMatches[0].scheduledAt!) : new Date();
  baseDate.setHours(12, 0, 0, 0);

  // Delete all knockout matches before regenerating
  await db.delete(matches).where(
    and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES]))
  );

  // Track created IDs per stage so we can wire nextMatchId afterward
  const stageMatchIds = new Map<string, string[]>();

  // Create first-round matches with sequential dates and bracketIndex
  const firstRoundIds: string[] = [];
  for (let i = 1; i <= matchCount; i++) {
    const homeSlotId = `m${i}_home`;
    const awaySlotId = `m${i}_away`;
    const homeTeamId = bracketSlots[homeSlotId]
      ? qualifierToTeamId(bracketSlots[homeSlotId])
      : (luckyLoserSlotMap.get(homeSlotId) ?? null);
    const awayTeamId = bracketSlots[awaySlotId]
      ? qualifierToTeamId(bracketSlots[awaySlotId])
      : (luckyLoserSlotMap.get(awaySlotId) ?? null);

    const matchDate = new Date(baseDate);
    matchDate.setDate(baseDate.getDate() + i);

    const matchId = crypto.randomUUID();
    await db.insert(matches).values({
      id: matchId,
      tournamentId,
      homeTeamId: homeTeamId ?? null,
      awayTeamId: awayTeamId ?? null,
      stage: firstRound,
      scheduledAt: matchDate,
      bracketIndex: i - 1,
    });
    firstRoundIds.push(matchId);
  }
  stageMatchIds.set(firstRound, firstRoundIds);

  // Create empty shell matches for all subsequent rounds so winners can advance into them
  const BRACKET_STAGE_ORDER_LOCAL = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final'] as const;
  const firstRoundStageIdx = BRACKET_STAGE_ORDER_LOCAL.indexOf(firstRound as typeof BRACKET_STAGE_ORDER_LOCAL[number]);
  const subsequentStages = BRACKET_STAGE_ORDER_LOCAL.slice(firstRoundStageIdx + 1);

  let shellDate = new Date(baseDate);
  shellDate.setDate(baseDate.getDate() + matchCount + 7);

  for (const stage of subsequentStages) {
    const shellCount = FIRST_ROUND_MATCH_COUNTS[stage] ?? 0;
    const stageIds: string[] = [];
    for (let i = 0; i < shellCount; i++) {
      const matchDate = new Date(shellDate);
      matchDate.setDate(shellDate.getDate() + i);
      const matchId = crypto.randomUUID();
      await db.insert(matches).values({
        id: matchId,
        tournamentId,
        homeTeamId: null,
        awayTeamId: null,
        stage,
        scheduledAt: matchDate,
        bracketIndex: i,
      });
      stageIds.push(matchId);
    }
    stageMatchIds.set(stage, stageIds);
    shellDate.setDate(shellDate.getDate() + Math.max(shellCount, 1) + 7);
  }

  if (hasBronzeFinal) {
    await db.insert(matches).values({
      id: crypto.randomUUID(),
      tournamentId,
      homeTeamId: null,
      awayTeamId: null,
      stage: 'bronze_final',
      scheduledAt: null,
    });
  }

  // Wire nextMatchId: each match's winner advances into Math.floor(bracketIndex/2) of the next stage
  const allStagesInOrder = BRACKET_STAGE_ORDER_LOCAL.slice(firstRoundStageIdx);
  for (let si = 0; si < allStagesInOrder.length - 1; si++) {
    const currentStage = allStagesInOrder[si];
    const nextStage = allStagesInOrder[si + 1];
    const currentIds = stageMatchIds.get(currentStage) ?? [];
    const nextIds = stageMatchIds.get(nextStage) ?? [];
    for (let i = 0; i < currentIds.length; i++) {
      const nextId = nextIds[Math.floor(i / 2)];
      if (nextId) {
        await db.update(matches).set({ nextMatchId: nextId }).where(eq(matches.id, currentIds[i]));
      }
    }
  }
}

// ── Per-group knockout slot helpers ───────────────────────────────────────────

const DEFAULT_KNOCKOUT_CONFIG: KnockoutConfig = {
  firstRound: 'round_of_16',
  hasBronzeFinal: false,
  directQualifiers: 2,
  luckyLosers: 0,
  bracketSlots: {},
};

/**
 * Creates all knockout match shells (with null teams) if they don't exist yet.
 * Safe to call multiple times — does nothing if first-round matches already exist.
 */
async function ensureKnockoutShellExists(tournamentId: string): Promise<void> {
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
  if (!tournament?.knockoutConfig) return;
  const cfg = tournament.knockoutConfig as KnockoutConfig;
  const { firstRound, hasBronzeFinal } = cfg;
  const matchCount = FIRST_ROUND_MATCH_COUNTS[firstRound] ?? 0;
  if (matchCount === 0) return;

  const existing = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, firstRound)))
    .limit(1);
  if (existing.length > 0) return;

  // Base date from last group match
  const allGroupMatches = await db
    .select({ scheduledAt: matches.scheduledAt })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group')));
  const dated = allGroupMatches.filter(m => m.scheduledAt).sort(
    (a, b) => new Date(b.scheduledAt!).getTime() - new Date(a.scheduledAt!).getTime(),
  );
  const baseDate = dated.length > 0 ? new Date(dated[0].scheduledAt!) : new Date();
  baseDate.setHours(12, 0, 0, 0);

  // First-round shells
  const shellStageMatchIds = new Map<string, string[]>();
  const firstRoundIds: string[] = [];
  for (let i = 1; i <= matchCount; i++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + i);
    const id = crypto.randomUUID();
    await db.insert(matches).values({
      id,
      tournamentId,
      homeTeamId: null,
      awayTeamId: null,
      stage: firstRound,
      scheduledAt: d,
      bracketIndex: i - 1,
    });
    firstRoundIds.push(id);
  }
  shellStageMatchIds.set(firstRound, firstRoundIds);

  // Subsequent-round shells
  const BRACKET_STAGES = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final'] as const;
  const firstRoundIdx = BRACKET_STAGES.indexOf(firstRound as typeof BRACKET_STAGES[number]);
  let shellDate = new Date(baseDate);
  shellDate.setDate(baseDate.getDate() + matchCount + 7);
  for (const stage of BRACKET_STAGES.slice(firstRoundIdx + 1)) {
    const cnt = FIRST_ROUND_MATCH_COUNTS[stage] ?? 0;
    const stageIds: string[] = [];
    for (let i = 0; i < cnt; i++) {
      const d = new Date(shellDate);
      d.setDate(shellDate.getDate() + i);
      const id = crypto.randomUUID();
      await db.insert(matches).values({ id, tournamentId, homeTeamId: null, awayTeamId: null, stage, scheduledAt: d, bracketIndex: i });
      stageIds.push(id);
    }
    shellStageMatchIds.set(stage, stageIds);
    shellDate.setDate(shellDate.getDate() + Math.max(cnt, 1) + 7);
  }
  if (hasBronzeFinal) {
    await db.insert(matches).values({ id: crypto.randomUUID(), tournamentId, homeTeamId: null, awayTeamId: null, stage: 'bronze_final', scheduledAt: null });
  }

  // Wire nextMatchId for each stage
  const stagesInOrder = BRACKET_STAGES.slice(firstRoundIdx);
  for (let si = 0; si < stagesInOrder.length - 1; si++) {
    const currentStage = stagesInOrder[si];
    const nextStage = stagesInOrder[si + 1];
    const currentIds = shellStageMatchIds.get(currentStage) ?? [];
    const nextIds = shellStageMatchIds.get(nextStage) ?? [];
    for (let i = 0; i < currentIds.length; i++) {
      const nextId = nextIds[Math.floor(i / 2)];
      if (nextId) {
        await db.update(matches).set({ nextMatchId: nextId }).where(eq(matches.id, currentIds[i]));
      }
    }
  }
}

/**
 * Updates homeTeamId/awayTeamId in first-round matches for direct qualifier slots
 * belonging to the given group (e.g. "1A", "2A"). Pass null teamIds to clear.
 */
async function applyGroupSlotsToKnockout(
  tournamentId: string,
  groupName: string,
  teamIds: string[] | null,
  cfg: KnockoutConfig,
): Promise<void> {
  const { firstRound, bracketSlots } = cfg;
  const matchCount = FIRST_ROUND_MATCH_COUNTS[firstRound] ?? 0;
  if (matchCount === 0) return;

  const firstRoundMatchesRaw = await db
    .select({ id: matches.id, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId, bracketIndex: matches.bracketIndex, scheduledAt: matches.scheduledAt })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, firstRound)));

  const firstRoundMatches = firstRoundMatchesRaw.sort((a, b) => {
    if (a.bracketIndex !== null && b.bracketIndex !== null) return a.bracketIndex - b.bracketIndex;
    if (a.bracketIndex !== null) return -1;
    if (b.bracketIndex !== null) return 1;
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });

  for (let i = 1; i <= matchCount; i++) {
    const m = firstRoundMatches[i - 1];
    if (!m) continue;
    const homeSlot = bracketSlots[`m${i}_home`];
    const awaySlot = bracketSlots[`m${i}_away`];
    const slotBelongsToGroup = (slot: string | undefined) => {
      if (!slot) return false;
      const match = slot.match(/^(\d+)([A-Z]+)$/);
      return match ? match[2] === groupName : false;
    };
    let homeTeamId = m.homeTeamId;
    let awayTeamId = m.awayTeamId;
    let changed = false;
    if (slotBelongsToGroup(homeSlot)) {
      const pos = parseInt(homeSlot!.match(/^(\d+)/)![1], 10) - 1;
      const newId = teamIds ? (teamIds[pos] ?? null) : null;
      if (newId !== homeTeamId) { homeTeamId = newId; changed = true; }
    }
    if (slotBelongsToGroup(awaySlot)) {
      const pos = parseInt(awaySlot!.match(/^(\d+)/)![1], 10) - 1;
      const newId = teamIds ? (teamIds[pos] ?? null) : null;
      if (newId !== awayTeamId) { awayTeamId = newId; changed = true; }
    }
    if (changed) {
      await db.update(matches).set({ homeTeamId, awayTeamId }).where(eq(matches.id, m.id));
    }
  }
}

/**
 * Fills (or clears when luckyLoserIds is null) the lucky-loser slots in first-round
 * matches — slots that have no entry in bracketSlots.
 */
async function applyLuckyLoserSlotsToKnockout(
  tournamentId: string,
  luckyLoserIds: string[] | null,
  cfg: KnockoutConfig,
): Promise<void> {
  const { firstRound, bracketSlots } = cfg;
  const matchCount = FIRST_ROUND_MATCH_COUNTS[firstRound] ?? 0;
  if (matchCount === 0) return;

  const firstRoundMatchesRawLL = await db
    .select({ id: matches.id, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId, bracketIndex: matches.bracketIndex, scheduledAt: matches.scheduledAt })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, firstRound)));

  const firstRoundMatches = firstRoundMatchesRawLL.sort((a, b) => {
    if (a.bracketIndex !== null && b.bracketIndex !== null) return a.bracketIndex - b.bracketIndex;
    if (a.bracketIndex !== null) return -1;
    if (b.bracketIndex !== null) return 1;
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });

  const emptySlots: { matchIdx: number; side: 'home' | 'away' }[] = [];
  for (let i = 1; i <= matchCount; i++) {
    if (!bracketSlots[`m${i}_home`]) emptySlots.push({ matchIdx: i - 1, side: 'home' });
    if (!bracketSlots[`m${i}_away`]) emptySlots.push({ matchIdx: i - 1, side: 'away' });
  }

  const updates = new Map<string, { homeTeamId: string | null; awayTeamId: string | null }>();
  for (let si = 0; si < emptySlots.length; si++) {
    const { matchIdx, side } = emptySlots[si];
    const m = firstRoundMatches[matchIdx];
    if (!m) continue;
    const newId = luckyLoserIds ? (luckyLoserIds[si] ?? null) : null;
    if (!updates.has(m.id)) updates.set(m.id, { homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId });
    const upd = updates.get(m.id)!;
    if (side === 'home') upd.homeTeamId = newId;
    else upd.awayTeamId = newId;
  }

  for (const [matchId, upd] of updates) {
    await db.update(matches).set(upd).where(eq(matches.id, matchId));
  }
}



async function advanceSingleKnockoutMatch(match: {
  id: string;
  tournamentId: string;
  stage: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  progressingTeamId: string | null;
  bracketIndex: number | null;
  nextMatchId: string | null;
}): Promise<void> {
  const { id: matchId, tournamentId, stage, progressingTeamId, bracketIndex, nextMatchId } = match;
  if (!progressingTeamId) return;

  // effectiveIndex is used for home/away slot determination (bracketIndex % 2)
  let effectiveIndex: number | null = bracketIndex;

  if (nextMatchId !== null && bracketIndex !== null) {
    // New path: use explicit bracket IDs
    const slot = bracketIndex % 2 === 0 ? 'homeTeamId' : 'awayTeamId';
    await db.update(matches).set({ [slot]: progressingTeamId }).where(eq(matches.id, nextMatchId));
  } else {
    // Legacy fallback: derive position from date-sorted stage list
    const NEXT_STAGE: Record<string, string> = {
      round_of_32: 'round_of_16',
      round_of_16: 'quarter_final',
      quarter_final: 'semi_final',
      semi_final: 'final',
    };

    const stageMatches = await db
      .select({ id: matches.id })
      .from(matches)
      .where(and(
        eq(matches.tournamentId, tournamentId),
        eq(matches.stage, stage as typeof matches.stage._.data),
      ))
      .orderBy(matches.scheduledAt);

    const matchIndex = stageMatches.findIndex(m => m.id === matchId);
    if (matchIndex === -1) return;
    effectiveIndex = matchIndex;

    const nextStage = NEXT_STAGE[stage];
    if (nextStage) {
      let nextMatches = await db
        .select({ id: matches.id })
        .from(matches)
        .where(and(
          eq(matches.tournamentId, tournamentId),
          eq(matches.stage, nextStage as typeof matches.stage._.data),
        ))
        .orderBy(matches.scheduledAt);

      if (nextMatches.length === 0) {
        const shellCount = FIRST_ROUND_MATCH_COUNTS[nextStage] ?? 0;
        const baseDate = new Date();
        baseDate.setFullYear(baseDate.getFullYear() + 5);
        const created: { id: string }[] = [];
        for (let i = 0; i < shellCount; i++) {
          const shellDate = new Date(baseDate);
          shellDate.setDate(baseDate.getDate() + i);
          const [row] = await db.insert(matches).values({
            id: crypto.randomUUID(),
            tournamentId,
            homeTeamId: null,
            awayTeamId: null,
            stage: nextStage as typeof matches.stage._.data,
            scheduledAt: shellDate,
          }).returning({ id: matches.id });
          created.push(row);
        }
        nextMatches = created;
      }

      const target = nextMatches[Math.floor(matchIndex / 2)];
      if (target) {
        const slot = matchIndex % 2 === 0 ? 'homeTeamId' : 'awayTeamId';
        await db.update(matches).set({ [slot]: progressingTeamId }).where(eq(matches.id, target.id));
      }
    }
  }

  if (stage === 'semi_final') {
    const loserId = progressingTeamId === match.homeTeamId ? match.awayTeamId : match.homeTeamId;
    if (!loserId) return;
    const [t] = await db
      .select({ knockoutConfig: tournaments.knockoutConfig })
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId))
      .limit(1);
    if ((t?.knockoutConfig as KnockoutConfig | null)?.hasBronzeFinal) {
      let [bronze] = await db
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'bronze_final')));
      if (!bronze) {
        [bronze] = await db.insert(matches).values({
          id: crypto.randomUUID(),
          tournamentId,
          homeTeamId: null,
          awayTeamId: null,
          stage: 'bronze_final',
          scheduledAt: null,
        }).returning({ id: matches.id });
      }
      if (bronze) {
        const slot = (effectiveIndex ?? 0) % 2 === 0 ? 'homeTeamId' : 'awayTeamId';
        await db.update(matches).set({ [slot]: loserId }).where(eq(matches.id, bronze.id));
      }
    }
  }
}

export const tournamentsRouter = Router();
export const matchesRouter = Router();
export const teamsRouter = Router();

tournamentsRouter.get('/', requireAuth, async (_req, res) => {
  try {
    const all = await db.select().from(tournaments).orderBy(tournaments.createdAt);
    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, imageUrl } = CreateTournamentSchema.parse(req.body);
    const id = crypto.randomUUID();
    const [tournament] = await db
      .insert(tournaments)
      .values({ id, name, imageUrl: imageUrl ?? null })
      .returning();
    return res.status(201).json(tournament);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    return res.json(tournament);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const updates = UpdateTournamentSchema.parse(req.body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const [updated] = await db
      .update(tournaments)
      .set(updates)
      .where(eq(tournaments.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Tournament not found' });
    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id/teams', requireAuth, async (req, res) => {
  try {
    const all = await db
      .select()
      .from(teams)
      .where(eq(teams.tournamentId, req.params.id));
    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/teams', requireAdmin, async (req, res) => {
  try {
    const { name, groupId, imageUrl } = CreateTeamSchema.parse(req.body);
    const [exists] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const id = crypto.randomUUID();
    const [team] = await db
      .insert(teams)
      .values({ id, tournamentId: req.params.id, name, groupId: groupId ?? null, imageUrl: imageUrl ?? null })
      .returning();
    return res.status(201).json(team);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id/matches', requireAuth, async (req, res) => {
  try {
    const matchRows = await db
      .select()
      .from(matches)
      .where(eq(matches.tournamentId, req.params.id));

    const teamIds = [
      ...new Set(
        matchRows
          .flatMap(m => [m.homeTeamId, m.awayTeamId])
          .filter((tid): tid is string => tid !== null)
      ),
    ];

    const teamRows =
      teamIds.length > 0
        ? await db.select().from(teams).where(inArray(teams.id, teamIds))
        : [];

    const teamMap = new Map(teamRows.map(t => [t.id, { name: t.name, imageUrl: t.imageUrl, groupId: t.groupId }]));

    const groupIds = [...new Set(teamRows.map(t => t.groupId).filter((id): id is string => id !== null))];
    const groupRows = groupIds.length > 0
      ? await db.select().from(groups).where(inArray(groups.id, groupIds))
      : [];
    const groupMap = new Map(groupRows.map(g => [g.id, g.name]));

    return res.json(
      matchRows.map(m => {
        const homeGroupId = m.homeTeamId ? (teamMap.get(m.homeTeamId)?.groupId ?? null) : null;
        const groupName = homeGroupId ? (groupMap.get(homeGroupId) ?? null) : null;
        return {
          ...m,
          homeTeamName: m.homeTeamId ? (teamMap.get(m.homeTeamId)?.name ?? null) : null,
          awayTeamName: m.awayTeamId ? (teamMap.get(m.awayTeamId)?.name ?? null) : null,
          homeTeamImageUrl: m.homeTeamId ? (teamMap.get(m.homeTeamId)?.imageUrl ?? null) : null,
          awayTeamImageUrl: m.awayTeamId ? (teamMap.get(m.awayTeamId)?.imageUrl ?? null) : null,
          groupName,
        };
      })
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/matches', requireAdmin, async (req, res) => {
  try {
    const { homeTeamId, awayTeamId, stage, scheduledAt } = CreateMatchSchema.parse(req.body);
    const [exists] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const id = crypto.randomUUID();
    const [match] = await db
      .insert(matches)
      .values({
        id,
        tournamentId: req.params.id,
        homeTeamId: homeTeamId ?? null,
        awayTeamId: awayTeamId ?? null,
        stage,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      })
      .returning();
    return res.status(201).json(match);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id/groups', requireAuth, async (req, res) => {
  try {
    const all = await db
      .select()
      .from(groups)
      .where(eq(groups.tournamentId, req.params.id))
      .orderBy(groups.name);
    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/groups', requireAdmin, async (req, res) => {
  try {
    const { name } = CreateGroupSchema.parse(req.body);
    const [exists] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const id = crypto.randomUUID();
    const [group] = await db
      .insert(groups)
      .values({ id, tournamentId: req.params.id, name })
      .returning();
    return res.status(201).json(group);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.patch('/:id/knockout-config', requireAdmin, async (req, res) => {
  try {
    const body = UpdateKnockoutConfigSchema.parse(req.body);
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.status !== 'upcoming') {
      return res.status(403).json({ error: 'Bracket setup is locked once the tournament is underway' });
    }

    const tournamentCompetitions = await db
      .select({ predictionDeadline: competitions.predictionDeadline })
      .from(competitions)
      .where(eq(competitions.tournamentId, req.params.id));
    const now = new Date();
    const deadlinePassed = tournamentCompetitions.some(
      c => c.predictionDeadline && new Date(c.predictionDeadline) < now
    );
    if (deadlinePassed) {
      return res.status(403).json({ error: 'Bracket setup is locked once the prediction deadline has passed' });
    }

    const existing: KnockoutConfig = (tournament.knockoutConfig as KnockoutConfig | null) ?? {
      firstRound: 'round_of_16',
      hasBronzeFinal: false,
      directQualifiers: 2,
      luckyLosers: 0,
      bracketSlots: {},
    };

    const merged: KnockoutConfig = { ...existing, ...body };

    const [updated] = await db
      .update(tournaments)
      .set({ knockoutConfig: merged })
      .where(eq(tournaments.id, req.params.id))
      .returning();

    return res.json(updated.knockoutConfig);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/simulate-group-stage', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [exists] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const scheduledGroupMatches = await db.select({ id: matches.id }).from(matches).where(
      and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'scheduled'))
    );

    for (const match of scheduledGroupMatches) {
      await db.update(matches)
        .set({ homeScore: Math.floor(Math.random() * 5), awayScore: Math.floor(Math.random() * 5), status: 'completed' })
        .where(eq(matches.id, match.id));
    }

    await generateFirstRoundKnockout(tournamentId);
    return res.json({ ok: true, simulated: scheduledGroupMatches.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/recalculate-scores', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [exists] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    await recalculateAllScoresForTournament(tournamentId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Recalculate scores error:', err);
    return res.status(500).json({ error: 'Failed to recalculate scores' });
  }
});

// ── Per-group confirm / reopen ─────────────────────────────────────────────────

tournamentsRouter.post('/:id/confirm-group/:groupName', requireAdmin, async (req, res) => {
  try {
    const { id: tournamentId, groupName } = req.params;
    const { standings } = req.body as { standings: string[] };

    if (!Array.isArray(standings) || standings.length === 0) {
      return res.status(400).json({ error: 'standings must be a non-empty array of team IDs' });
    }

    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    // Validate the group exists
    const [groupRow] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.tournamentId, tournamentId), eq(groups.name, groupName)))
      .limit(1);
    if (!groupRow) return res.status(404).json({ error: `Group "${groupName}" not found` });

    // Validate all matches in this group are completed
    const groupTeams = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.tournamentId, tournamentId), eq(teams.groupId, groupRow.id)));
    const groupTeamIds = new Set(groupTeams.map(t => t.id));
    const allGroupMatches = await db
      .select({ homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId, status: matches.status })
      .from(matches)
      .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group')));
    const groupMatches = allGroupMatches.filter(
      m => m.homeTeamId && m.awayTeamId && groupTeamIds.has(m.homeTeamId) && groupTeamIds.has(m.awayTeamId),
    );
    if (groupMatches.length === 0 || !groupMatches.every(m => m.status === 'completed')) {
      return res.status(400).json({ error: `All matches in Group ${groupName} must be completed before confirming` });
    }

    const existing: KnockoutConfig = (tournament.knockoutConfig as KnockoutConfig | null) ?? { ...DEFAULT_KNOCKOUT_CONFIG };
    const updatedStandings = { ...(existing.confirmedGroupStandings ?? {}), [groupName]: standings };

    // If the overall lock was already set (lucky losers confirmed), re-open the LL lock
    // because the group change may affect which teams are LL candidates.
    const wasFinallyLocked = existing.groupStandingsLocked === true;

    const updated: KnockoutConfig = {
      ...existing,
      confirmedGroupStandings: updatedStandings,
      ...(wasFinallyLocked && { groupStandingsLocked: false, confirmedLuckyLosers: undefined }),
    };

    await db.update(tournaments).set({ knockoutConfig: updated }).where(eq(tournaments.id, tournamentId));

    // Ensure knockout match shells exist before filling slots
    await ensureKnockoutShellExists(tournamentId);

    // If LL lock was cleared, also wipe LL team slots
    if (wasFinallyLocked) {
      await applyLuckyLoserSlotsToKnockout(tournamentId, null, existing);
    }

    // Fill direct qualifier slots for this group
    await applyGroupSlotsToKnockout(tournamentId, groupName, standings, updated);

    await recalculateAllScoresForTournament(tournamentId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Confirm group error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/reopen-group/:groupName', requireAdmin, async (req, res) => {
  try {
    const { id: tournamentId, groupName } = req.params;

    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const existing: KnockoutConfig = (tournament.knockoutConfig as KnockoutConfig | null) ?? { ...DEFAULT_KNOCKOUT_CONFIG };
    const updatedStandings = { ...(existing.confirmedGroupStandings ?? {}) };
    delete updatedStandings[groupName];

    const wasFinallyLocked = existing.groupStandingsLocked === true;

    const updated: KnockoutConfig = {
      ...existing,
      confirmedGroupStandings: Object.keys(updatedStandings).length > 0 ? updatedStandings : undefined,
      ...(wasFinallyLocked && { groupStandingsLocked: false, confirmedLuckyLosers: undefined }),
    };

    await db.update(tournaments).set({ knockoutConfig: updated }).where(eq(tournaments.id, tournamentId));

    // Clear direct qualifier slots for this group in knockout matches
    await applyGroupSlotsToKnockout(tournamentId, groupName, null, existing);

    // If LL lock was cleared, also wipe LL team slots
    if (wasFinallyLocked) {
      await applyLuckyLoserSlotsToKnockout(tournamentId, null, existing);
    }

    await recalculateAllScoresForTournament(tournamentId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Reopen group error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Lucky loser confirmation (all groups must already be confirmed) ───────────

tournamentsRouter.post('/:id/confirm-group-standings', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { luckyLosers } = req.body as { luckyLosers: string[] };

    if (!Array.isArray(luckyLosers)) {
      return res.status(400).json({ error: 'luckyLosers must be an array' });
    }

    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const existing: KnockoutConfig = (tournament.knockoutConfig as KnockoutConfig | null) ?? { ...DEFAULT_KNOCKOUT_CONFIG };

    // All groups must be confirmed before finalising lucky losers
    const allGroups = await db.select({ name: groups.name }).from(groups).where(eq(groups.tournamentId, tournamentId));
    const confirmedGroupStandings = existing.confirmedGroupStandings ?? {};
    const unconfirmed = allGroups.filter(g => !confirmedGroupStandings[g.name]);
    if (unconfirmed.length > 0) {
      return res.status(400).json({
        error: `Groups must be confirmed before finalising lucky losers: ${unconfirmed.map(g => g.name).join(', ')}`,
      });
    }

    const updated: KnockoutConfig = {
      ...existing,
      groupStandingsLocked: true,
      confirmedLuckyLosers: luckyLosers,
    };

    await db.update(tournaments).set({ knockoutConfig: updated }).where(eq(tournaments.id, tournamentId));

    // Fill lucky loser slots
    await applyLuckyLoserSlotsToKnockout(tournamentId, luckyLosers, updated);

    await recalculateAllScoresForTournament(tournamentId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Confirm lucky losers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/reopen-group-standings', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const existing: KnockoutConfig = (tournament.knockoutConfig as KnockoutConfig | null) ?? { ...DEFAULT_KNOCKOUT_CONFIG };

    // Only clear the lucky loser lock — individual group confirmations remain intact
    const updated: KnockoutConfig = {
      ...existing,
      groupStandingsLocked: false,
      confirmedLuckyLosers: undefined,
    };

    await db.update(tournaments).set({ knockoutConfig: updated }).where(eq(tournaments.id, tournamentId));

    // Clear lucky loser team slots from knockout matches
    await applyLuckyLoserSlotsToKnockout(tournamentId, null, existing);

    await recalculateAllScoresForTournament(tournamentId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Reopen lucky losers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/clear-group-stage', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [exists] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    // Reset all group stage matches to scheduled
    await db.update(matches)
      .set({ homeScore: null, awayScore: null, status: 'scheduled' })
      .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group')));

    // Delete all knockout matches
    await db.delete(matches).where(
      and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES]))
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/regenerate-knockout', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.status !== 'upcoming') {
      return res.status(403).json({ error: 'Bracket setup is locked once the tournament is underway' });
    }

    const tournamentCompetitions = await db
      .select({ predictionDeadline: competitions.predictionDeadline })
      .from(competitions)
      .where(eq(competitions.tournamentId, tournamentId));
    const now = new Date();
    const deadlinePassed = tournamentCompetitions.some(
      c => c.predictionDeadline && new Date(c.predictionDeadline) < now
    );
    if (deadlinePassed) {
      return res.status(403).json({ error: 'Bracket setup is locked once the prediction deadline has passed' });
    }

    await generateFirstRoundKnockout(tournamentId);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/simulate-knockout', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const cfg = tournament.knockoutConfig as KnockoutConfig | null;
    const firstRound = cfg?.firstRound ?? 'round_of_16';
    const hasBronzeFinal = cfg?.hasBronzeFinal ?? false;

    const BRACKET_ORDER = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final'] as const;
    const startIdx = BRACKET_ORDER.indexOf(firstRound as typeof BRACKET_ORDER[number]);

    // Fetch all knockout matches and group by stage in bracket order
    const allKoMatches = await db.select().from(matches).where(
      and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES]))
    );
    const sortByBracketIndex = (arr: typeof allKoMatches) => [...arr].sort((a, b) => {
      if (a.bracketIndex !== null && b.bracketIndex !== null) return a.bracketIndex - b.bracketIndex;
      if (a.bracketIndex !== null) return -1;
      if (b.bracketIndex !== null) return 1;
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });
    const byStage = new Map<string, typeof allKoMatches>();
    for (const m of allKoMatches) {
      if (!byStage.has(m.stage)) byStage.set(m.stage, []);
      byStage.get(m.stage)!.push(m);
    }
    for (const [k, v] of byStage) byStage.set(k, sortByBracketIndex(v));

    let simulated = 0;

    for (let si = startIdx; si < BRACKET_ORDER.length; si++) {
      const stage = BRACKET_ORDER[si];
      const nextStage = si + 1 < BRACKET_ORDER.length ? BRACKET_ORDER[si + 1] : null;
      const stageMatches = byStage.get(stage) ?? [];

      for (let i = 0; i < stageMatches.length; i++) {
        const match = stageMatches[i];
        if (!match.homeTeamId || !match.awayTeamId) continue;

        // Simulate score if not already completed
        if (match.status !== 'completed') {
          let h = Math.floor(Math.random() * 4);
          let a = Math.floor(Math.random() * 4);
          while (h === a) a = Math.floor(Math.random() * 4);
          await db.update(matches).set({ homeScore: h, awayScore: a, status: 'completed' }).where(eq(matches.id, match.id));
          match.homeScore = h; match.awayScore = a; match.status = 'completed';
          simulated++;
        }

        const winnerId = (match.homeScore ?? 0) > (match.awayScore ?? 0) ? match.homeTeamId : match.awayTeamId;
        const loserId = winnerId === match.homeTeamId ? match.awayTeamId : match.homeTeamId;
        const slot = i % 2 === 0 ? 'homeTeamId' : 'awayTeamId';

        // Advance winner into the next round's match
        if (nextStage) {
          const nextMatches = byStage.get(nextStage) ?? [];
          const target = nextMatches[Math.floor(i / 2)];
          if (target) {
            await db.update(matches).set({ [slot]: winnerId }).where(eq(matches.id, target.id));
            (target as Record<string, unknown>)[slot] = winnerId;
          }
        }

        // Advance SF loser to bronze final
        if (stage === 'semi_final' && hasBronzeFinal && loserId) {
          const bronze = (byStage.get('bronze_final') ?? [])[0];
          if (bronze) {
            await db.update(matches).set({ [slot]: loserId }).where(eq(matches.id, bronze.id));
            (bronze as Record<string, unknown>)[slot] = loserId;
          }
        }
      }
    }

    // Simulate bronze final (teams now filled in from SF results)
    if (hasBronzeFinal) {
      const bronze = (byStage.get('bronze_final') ?? [])[0];
      if (bronze?.homeTeamId && bronze?.awayTeamId && bronze.status !== 'completed') {
        let h = Math.floor(Math.random() * 4);
        let a = Math.floor(Math.random() * 4);
        while (h === a) a = Math.floor(Math.random() * 4);
        await db.update(matches).set({ homeScore: h, awayScore: a, status: 'completed' }).where(eq(matches.id, bronze.id));
        simulated++;
      }
    }

    return res.json({ ok: true, simulated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/clear-knockout', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const cfg = tournament.knockoutConfig as KnockoutConfig | null;
    const firstRound = cfg?.firstRound ?? 'round_of_16';

    // Reset scores, status and progressingTeamId on all knockout matches
    await db.update(matches)
      .set({ homeScore: null, awayScore: null, status: 'scheduled', progressingTeamId: null })
      .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES])));

    // Clear team assignments from all stages except the first round (those come from bracket setup)
    const stagesToClearTeams = KNOCKOUT_STAGES.filter(s => s !== firstRound);
    if (stagesToClearTeams.length > 0) {
      await db.update(matches)
        .set({ homeTeamId: null, awayTeamId: null })
        .where(and(
          eq(matches.tournamentId, tournamentId),
          inArray(matches.stage, stagesToClearTeams),
        ));
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Re-populates first-round knockout match slots with the teams derived from current
 * group standings / lucky-loser config, WITHOUT deleting the match shells (so scheduled
 * dates, bracketIndex, nextMatchId and user bracketPredictions are untouched).
 * Teams in subsequent rounds are cleared so they can be re-filled as results come in.
 */
tournamentsRouter.post('/:id/reallocate-knockout', requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const cfg = tournament.knockoutConfig as KnockoutConfig | null;
    if (!cfg) return res.status(400).json({ error: 'No knockout config' });

    const { firstRound, bracketSlots, directQualifiers, luckyLosers } = cfg;
    const groupDisciplinaryChoices = cfg.groupDisciplinaryChoices ?? {};
    const luckyLoserDisciplinaryChoices = cfg.luckyLoserDisciplinaryChoices ?? {};
    const matchCount = FIRST_ROUND_MATCH_COUNTS[firstRound] ?? 0;
    if (matchCount === 0) return res.status(400).json({ error: 'No first-round matches configured' });

    // Build teamId → groupName map
    const teamRows = await db.select({ id: teams.id, groupId: teams.groupId }).from(teams).where(eq(teams.tournamentId, tournamentId));
    const groupRows = await db.select().from(groups).where(eq(groups.tournamentId, tournamentId));
    const groupNameMap = new Map(groupRows.map(g => [g.id, g.name]));
    const teamGroupMap = new Map<string, string>();
    for (const t of teamRows) {
      if (t.groupId) {
        const gName = groupNameMap.get(t.groupId);
        if (gName) teamGroupMap.set(t.id, gName);
      }
    }

    // Compute standings (use confirmed locked standings when available)
    const allGroupMatches = await db.select().from(matches).where(
      and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'))
    );
    let standings: Map<string, TeamStat[]>;
    if (cfg.groupStandingsLocked && cfg.confirmedGroupStandings) {
      standings = new Map(
        Object.entries(cfg.confirmedGroupStandings).map(([groupName, teamIds]) => [
          groupName,
          teamIds.map(id => ({ teamId: id, points: 0, gd: 0, gf: 0 })),
        ]),
      );
    } else {
      standings = computeGroupStandings(
        allGroupMatches.filter(m => m.status === 'completed'),
        teamGroupMap,
        groupDisciplinaryChoices,
      );
    }

    function qualifierToTeamId(label: string): string | null {
      const m = label.match(/^(\d+)([A-Z])$/);
      if (!m) return null;
      const pos = parseInt(m[1]) - 1;
      const gs = standings.get(m[2]);
      return gs && gs.length > pos ? gs[pos].teamId : null;
    }

    // Collect lucky losers
    let selectedLuckyLosers: string[];
    if (cfg.groupStandingsLocked && cfg.confirmedLuckyLosers) {
      selectedLuckyLosers = cfg.confirmedLuckyLosers.slice(0, luckyLosers);
    } else {
      const candidates: TeamStat[] = [];
      for (const [, gs] of standings) {
        if (gs.length > directQualifiers) candidates.push(gs[directQualifiers]);
      }
      candidates.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.gd !== a.gd) return b.gd - a.gd;
        if (b.gf !== a.gf) return b.gf - a.gf;
        const tied = candidates.filter(t => t.points === a.points && t.gd === a.gd && t.gf === a.gf);
        const key = [...tied.map(t => t.teamId)].sort().join('|');
        const ranking = luckyLoserDisciplinaryChoices[key];
        if (ranking) {
          const da = ranking.indexOf(a.teamId);
          const db = ranking.indexOf(b.teamId);
          if (da !== -1 && db !== -1 && da !== db) return da - db;
        }
        return a.teamId.localeCompare(b.teamId);
      });
      selectedLuckyLosers = candidates.slice(0, luckyLosers).map(t => t.teamId);
    }

    const emptySlots: string[] = [];
    for (let i = 1; i <= matchCount; i++) {
      if (!bracketSlots[`m${i}_home`]) emptySlots.push(`m${i}_home`);
      if (!bracketSlots[`m${i}_away`]) emptySlots.push(`m${i}_away`);
    }
    const luckyLoserSlotMap = new Map<string, string>();
    for (let i = 0; i < Math.min(emptySlots.length, selectedLuckyLosers.length); i++) {
      luckyLoserSlotMap.set(emptySlots[i], selectedLuckyLosers[i]);
    }

    // Fetch and sort first-round matches by bracketIndex
    const firstRoundMatchesRaw = await db
      .select({ id: matches.id, bracketIndex: matches.bracketIndex, scheduledAt: matches.scheduledAt })
      .from(matches)
      .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, firstRound)));

    const firstRoundMatches = firstRoundMatchesRaw.sort((a, b) => {
      if (a.bracketIndex !== null && b.bracketIndex !== null) return a.bracketIndex - b.bracketIndex;
      if (a.bracketIndex !== null) return -1;
      if (b.bracketIndex !== null) return 1;
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });

    // Update team assignments in first-round matches
    for (let i = 1; i <= matchCount; i++) {
      const m = firstRoundMatches[i - 1];
      if (!m) continue;
      const homeSlotId = `m${i}_home`;
      const awaySlotId = `m${i}_away`;
      const homeTeamId = bracketSlots[homeSlotId]
        ? qualifierToTeamId(bracketSlots[homeSlotId])
        : (luckyLoserSlotMap.get(homeSlotId) ?? null);
      const awayTeamId = bracketSlots[awaySlotId]
        ? qualifierToTeamId(bracketSlots[awaySlotId])
        : (luckyLoserSlotMap.get(awaySlotId) ?? null);
      await db.update(matches).set({ homeTeamId: homeTeamId ?? null, awayTeamId: awayTeamId ?? null }).where(eq(matches.id, m.id));
    }

    // Clear team assignments from all subsequent rounds (they'll be re-filled from results)
    const BRACKET_STAGE_ORDER_LOCAL = ['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final'] as const;
    const firstRoundStageIdx = BRACKET_STAGE_ORDER_LOCAL.indexOf(firstRound as typeof BRACKET_STAGE_ORDER_LOCAL[number]);
    const stagesToClear = [
      ...BRACKET_STAGE_ORDER_LOCAL.slice(firstRoundStageIdx + 1),
      ...(cfg.hasBronzeFinal ? ['bronze_final' as const] : []),
    ];
    if (stagesToClear.length > 0) {
      await db.update(matches)
        .set({ homeTeamId: null, awayTeamId: null })
        .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, stagesToClear)));
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.delete('/:id/groups/:groupId', requireAdmin, async (req, res) => {
  try {
    const [deleted] = await db
      .delete(groups)
      .where(eq(groups.id, req.params.groupId))
      .returning();
    if (!deleted) return res.status(404).json({ error: 'Group not found' });
    return res.json(deleted);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bonus questions ───────────────────────────────────────────────────────────

tournamentsRouter.get('/:id/bonus-questions', requireAuth, async (req, res) => {
  try {
    const questions = await db
      .select()
      .from(bonusQuestions)
      .where(eq(bonusQuestions.tournamentId, req.params.id));
    return res.json(questions);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/bonus-questions', requireAdmin, async (req, res) => {
  try {
    const [exists] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, req.params.id)).limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const result = CreateBonusQuestionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { question, answerType, points } = result.data;
    const qid = generateId(15);
    const [created] = await db
      .insert(bonusQuestions)
      .values({ id: qid, tournamentId: req.params.id, question, answerType, points })
      .returning();
    return res.status(201).json(created);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.patch('/:id/bonus-questions/:qid', requireAdmin, async (req, res) => {
  try {
    const { id, qid } = req.params;
    const [existing] = await db
      .select()
      .from(bonusQuestions)
      .where(and(eq(bonusQuestions.id, qid), eq(bonusQuestions.tournamentId, id)));
    if (!existing) return res.status(404).json({ error: 'Question not found' });

    const result = UpdateBonusQuestionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const updates: Record<string, unknown> = {};
    if (result.data.question !== undefined) updates.question = result.data.question;
    if (result.data.answerType !== undefined) updates.answerType = result.data.answerType;
    if (result.data.points !== undefined) updates.points = result.data.points;
    if (result.data.correctAnswer !== undefined) updates.correctAnswer = result.data.correctAnswer;

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });

    const [updated] = await db
      .update(bonusQuestions)
      .set(updates)
      .where(eq(bonusQuestions.id, qid))
      .returning();

    if (result.data.correctAnswer !== undefined) {
      await triggerBonusScoring(qid, id).catch(err =>
        console.error('Bonus scoring error:', err),
      );
    }

    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.delete('/:id/bonus-questions/:qid', requireAdmin, async (req, res) => {
  try {
    const { id, qid } = req.params;
    const [existing] = await db
      .select()
      .from(bonusQuestions)
      .where(and(eq(bonusQuestions.id, qid), eq(bonusQuestions.tournamentId, id)));
    if (!existing) return res.status(404).json({ error: 'Question not found' });

    await db.delete(bonusQuestions).where(eq(bonusQuestions.id, qid));
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

matchesRouter.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const [match] = await db
      .select({ id: matches.id, stage: matches.stage, tournamentId: matches.tournamentId })
      .from(matches)
      .where(eq(matches.id, req.params.id))
      .limit(1);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (match.stage !== 'group') {
      return res.status(403).json({ error: 'Only group stage matches can be deleted' });
    }

    const [tournament] = await db
      .select({ status: tournaments.status })
      .from(tournaments)
      .where(eq(tournaments.id, match.tournamentId))
      .limit(1);

    if (!tournament || tournament.status !== 'upcoming') {
      return res.status(403).json({ error: 'Matches can only be deleted when the tournament is upcoming' });
    }

    await db.delete(matches).where(eq(matches.id, req.params.id));
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

matchesRouter.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const updates = UpdateMatchSchema.parse(req.body);
    const setData: Record<string, unknown> = {};
    if (updates.homeTeamId !== undefined) setData.homeTeamId = updates.homeTeamId;
    if (updates.awayTeamId !== undefined) setData.awayTeamId = updates.awayTeamId;
    if (updates.stage !== undefined) setData.stage = updates.stage;
    if (updates.scheduledAt !== undefined) {
      setData.scheduledAt = updates.scheduledAt ? new Date(updates.scheduledAt) : null;
    }
    if (updates.progressingTeamId !== undefined) setData.progressingTeamId = updates.progressingTeamId;
    if (updates.homeScore !== undefined && updates.awayScore !== undefined) {
      setData.homeScore = updates.homeScore;
      setData.awayScore = updates.awayScore;
      setData.status = 'completed';
    }
    if (Object.keys(setData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const [updated] = await db
      .update(matches)
      .set(setData)
      .where(eq(matches.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Match not found' });

    // Auto-generate first-round knockout matches when all group stage matches complete
    if (updated.stage === 'group' && setData.status === 'completed') {
      const allGroupMatches = await db
        .select({ status: matches.status })
        .from(matches)
        .where(and(eq(matches.tournamentId, updated.tournamentId), eq(matches.stage, 'group')));

      const allComplete = allGroupMatches.length > 0 && allGroupMatches.every(m => m.status === 'completed');
      if (allComplete) {
        const [cfg] = await db
          .select({ knockoutConfig: tournaments.knockoutConfig })
          .from(tournaments)
          .where(eq(tournaments.id, updated.tournamentId))
          .limit(1);

        if (cfg?.knockoutConfig) {
          const firstRound = (cfg.knockoutConfig as KnockoutConfig).firstRound;
          const [existingKo] = await db
            .select({ id: matches.id })
            .from(matches)
            .where(and(eq(matches.tournamentId, updated.tournamentId), eq(matches.stage, firstRound)))
            .limit(1);

          if (!existingKo) {
            await generateFirstRoundKnockout(updated.tournamentId);
          }
        }
      }
    }

    // For decisive knockout results: auto-set progressingTeamId, then advance immediately
    const KNOCKOUT_STAGE_SET = new Set(KNOCKOUT_STAGES as readonly string[]);
    if (KNOCKOUT_STAGE_SET.has(updated.stage) && updated.status === 'completed') {
      if (!updated.progressingTeamId && updated.homeTeamId && updated.awayTeamId &&
          updated.homeScore !== null && updated.awayScore !== null && updated.homeScore !== updated.awayScore) {
        const winnerId = updated.homeScore > updated.awayScore ? updated.homeTeamId : updated.awayTeamId;
        await db.update(matches).set({ progressingTeamId: winnerId }).where(eq(matches.id, updated.id));
        updated.progressingTeamId = winnerId;
      }
      if (updated.progressingTeamId) {
        await advanceSingleKnockoutMatch(updated);
      }
    }

    // Trigger scoring after the match (and knockout advancement) is fully settled
    if (setData.status === 'completed') {
      try {
        await triggerScoringForMatch(updated.id, updated.tournamentId);
      } catch (err) {
        console.error('Scoring trigger error:', err);
      }
    }

    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

teamsRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const [team] = await db
      .select()
      .from(teams)
      .where(eq(teams.id, req.params.id))
      .limit(1);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    return res.json(team);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

teamsRouter.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const updates = UpdateTeamSchema.parse(req.body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const [updated] = await db
      .update(teams)
      .set(updates)
      .where(eq(teams.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Team not found' });
    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Players ───────────────────────────────────────────────────────────────────

tournamentsRouter.get('/:id/players', requireAuth, requireAdmin, async (req, res) => {
  const playerList = await db
    .select()
    .from(players)
    .where(eq(players.tournamentId, req.params.id));
  return res.json(playerList);
});

tournamentsRouter.post('/:id/players', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = CreatePlayerSchema.parse(req.body);
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    const [player] = await db.insert(players).values({
      id: generateId(15),
      tournamentId: req.params.id,
      name: data.name,
      gamesPlayed: data.gamesPlayed ?? 0,
      goalsScored: data.goalsScored ?? 0,
    }).returning();
    return res.status(201).json(player);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.patch('/:id/players/:playerId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = UpdatePlayerSchema.parse(req.body);
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No fields to update' });
    const [player] = await db
      .update(players)
      .set(data)
      .where(and(eq(players.id, req.params.playerId), eq(players.tournamentId, req.params.id)))
      .returning();
    if (!player) return res.status(404).json({ error: 'Player not found' });
    return res.json(player);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.delete('/:id/players/:playerId', requireAuth, requireAdmin, async (req, res) => {
  const [player] = await db
    .delete(players)
    .where(and(eq(players.id, req.params.playerId), eq(players.tournamentId, req.params.id)))
    .returning();
  if (!player) return res.status(404).json({ error: 'Player not found' });
  return res.status(204).end();
});
