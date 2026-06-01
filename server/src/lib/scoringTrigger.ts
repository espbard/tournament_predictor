import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  matches,
  predictions,
  competitions,
  competitionMembers,
  bracketPredictions,
  teams,
  groups,
  tournaments,
} from '../db/schema.js';
import {
  calculateMatchPoints,
  computeGroupStandings,
  calculateGroupPositionPoints,
  calculateKnockoutPoints,
} from './scoring.js';
import type { KnockoutConfig, BracketPredictions, ScoringConfig } from '@tournament-predictor/shared';

const KNOCKOUT_STAGES = [
  'round_of_32',
  'round_of_16',
  'quarter_final',
  'semi_final',
  'bronze_final',
  'final',
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getMemberUserIds(competitionId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: competitionMembers.userId })
    .from(competitionMembers)
    .where(eq(competitionMembers.competitionId, competitionId));
  return rows.map(r => r.userId);
}

// ── Group stage match scoring ─────────────────────────────────────────────────

async function scoreGroupMatch(
  matchId: string,
  match: { homeScore: number; awayScore: number; stage: string; progressingTeamId: string | null },
  competitionId: string,
  config: ScoringConfig,
): Promise<void> {
  const preds = await db
    .select()
    .from(predictions)
    .where(and(eq(predictions.matchId, matchId), eq(predictions.competitionId, competitionId)));

  for (const pred of preds) {
    const result = calculateMatchPoints(
      { homeScore: pred.homeScore, awayScore: pred.awayScore, progressingTeamId: pred.progressingTeamId },
      { homeScore: match.homeScore, awayScore: match.awayScore, stage: match.stage, actualProgressingTeamId: match.progressingTeamId },
      config,
    );
    await db.update(predictions).set({ points: result.points }).where(eq(predictions.id, pred.id));
  }
}

// ── Group position scoring ────────────────────────────────────────────────────

async function scoreGroupPositions(tournamentId: string, competitionId: string, config: ScoringConfig): Promise<void> {
  const teamRows = await db
    .select({ id: teams.id, groupId: teams.groupId })
    .from(teams)
    .where(eq(teams.tournamentId, tournamentId));
  const groupRows = await db.select().from(groups).where(eq(groups.tournamentId, tournamentId));

  const groupNameMap = new Map(groupRows.map(g => [g.id, g.name]));
  const teamGroupMap = new Map<string, string>();
  for (const t of teamRows) {
    if (t.groupId) {
      const gName = groupNameMap.get(t.groupId);
      if (gName) teamGroupMap.set(t.id, gName);
    }
  }

  const completedGroupMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group'), eq(matches.status, 'completed')));

  const actualStandings = computeGroupStandings(completedGroupMatches, teamGroupMap);
  const memberIds = await getMemberUserIds(competitionId);
  const groupMatchIds = completedGroupMatches.map(m => m.id);

  for (const userId of memberIds) {
    const userPreds = groupMatchIds.length > 0
      ? await db
          .select()
          .from(predictions)
          .where(and(
            eq(predictions.competitionId, competitionId),
            eq(predictions.userId, userId),
            inArray(predictions.matchId, groupMatchIds),
          ))
      : [];

    const userPredMap = new Map(userPreds.map(p => [p.matchId, { homeScore: p.homeScore, awayScore: p.awayScore }]));

    const simulatedMatches = completedGroupMatches
      .filter(m => m.homeTeamId && m.awayTeamId)
      .flatMap(m => {
        const pred = userPredMap.get(m.id);
        if (!pred) return [];
        return [{ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, homeScore: pred.homeScore, awayScore: pred.awayScore }];
      });

    const predictedStandings = computeGroupStandings(simulatedMatches, teamGroupMap);
    const gpPoints = calculateGroupPositionPoints(actualStandings, predictedStandings, config);

    await db
      .update(competitionMembers)
      .set({ groupPositionPoints: gpPoints })
      .where(and(eq(competitionMembers.competitionId, competitionId), eq(competitionMembers.userId, userId)));
  }
}

// ── Knockout scoring ──────────────────────────────────────────────────────────

async function scoreKnockoutMatches(
  tournamentId: string,
  competitionId: string,
  config: ScoringConfig,
  firstRound: string,
): Promise<void> {
  const allKoMatches = await db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.stage, [...KNOCKOUT_STAGES])));

  // Stable ordering: sort by scheduledAt within each stage so bracket indices are consistent
  allKoMatches.sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });

  const memberIds = await getMemberUserIds(competitionId);

  for (const userId of memberIds) {
    const [bpRow] = await db
      .select()
      .from(bracketPredictions)
      .where(and(eq(bracketPredictions.competitionId, competitionId), eq(bracketPredictions.userId, userId)));

    const userBracketPreds: BracketPredictions = bpRow?.predictions ?? {};

    const koPoints = calculateKnockoutPoints(
      allKoMatches.map(m => ({
        id: m.id,
        stage: m.stage,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore ?? 0,
        awayScore: m.awayScore ?? 0,
        progressingTeamId: m.progressingTeamId,
        status: m.status,
      })),
      firstRound,
      userBracketPreds,
      config,
    );

    await db
      .update(competitionMembers)
      .set({ knockoutPoints: koPoints })
      .where(and(eq(competitionMembers.competitionId, competitionId), eq(competitionMembers.userId, userId)));
  }
}

// ── Main trigger ──────────────────────────────────────────────────────────────

export async function triggerScoringForMatch(matchId: string, tournamentId: string): Promise<void> {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!match || match.status !== 'completed' || match.homeScore === null || match.awayScore === null) return;

  const allComps = await db
    .select()
    .from(competitions)
    .where(eq(competitions.tournamentId, tournamentId));

  const isKnockout = (KNOCKOUT_STAGES as readonly string[]).includes(match.stage);

  for (const comp of allComps) {
    const config = comp.scoringConfig as ScoringConfig;

    if (!isKnockout) {
      await scoreGroupMatch(
        matchId,
        { homeScore: match.homeScore, awayScore: match.awayScore, stage: match.stage, progressingTeamId: match.progressingTeamId },
        comp.id,
        config,
      );

      const allGroupMatches = await db
        .select({ status: matches.status })
        .from(matches)
        .where(and(eq(matches.tournamentId, tournamentId), eq(matches.stage, 'group')));

      const allDone = allGroupMatches.length > 0 && allGroupMatches.every(m => m.status === 'completed');
      if (allDone) {
        await scoreGroupPositions(tournamentId, comp.id, config);
      }
    } else {
      const [tourRow] = await db
        .select({ knockoutConfig: tournaments.knockoutConfig })
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1);

      const firstRound = (tourRow?.knockoutConfig as KnockoutConfig | null)?.firstRound ?? 'round_of_16';
      await scoreKnockoutMatches(tournamentId, comp.id, config, firstRound);
    }
  }
}
