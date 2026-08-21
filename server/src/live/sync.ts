import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  getLiveFormat,
  isStageAtOrAfter,
  resolveStageKey,
  type LiveFormatDef,
  type LiveQualificationStatus,
} from '@tournament-predictor/shared';
import { db } from '../db/client';
import { liveFixtures, liveStandings, liveTeams, liveTournaments } from '../db/liveSchema';
import { mirrorTeamCrests } from './crests';
import { getProvider } from './providers';
import {
  ProviderError,
  type ProviderFixture,
  type ProviderStandingRow,
  type ProviderTeam,
} from './providers/types';

// ── Sync engine ───────────────────────────────────────────────────────────────
//
// Pulls teams, fixtures and standings from a provider and upserts them onto the live_*
// tables. Everything is keyed by provider id, so re-running is harmless and partial data
// is a normal state rather than an error — which matters a great deal for the Champions
// League, whose season does not exist at the provider until the draw.
//
// Two entry points:
//   syncTournamentStructure  teams + all fixtures + standings, ~3 provider requests
//   syncLiveWindow           fixtures around today only, 1 request — carries live scores
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §7.

/** Rows written per insert. Keeps a 380-fixture league well inside parameter limits. */
const CHUNK_SIZE = 200;

export interface SyncResult {
  teams: number;
  fixtures: number;
  standings: number;
  /**
   * Fixtures that moved *into* `finished` during this sync. Phase 4 hands these to
   * scoreFixtures(); until then they are reported and otherwise unused.
   */
  newlyFinishedFixtureIds: string[];
  /** Fixtures whose score changed while in play — the SSE trigger in Phase 4. */
  changedFixtureIds: string[];
  /** Provider stage strings the format does not map, surfaced as an admin warning. */
  unmappedStages: string[];
  /** True when the provider has not published this season yet. Not an error. */
  seasonUnavailable: boolean;
  /** Team crests copied into R2 by this sync. Zero on every sync after the first. */
  crestsMirrored: number;
}

function emptyResult(): SyncResult {
  return {
    teams: 0,
    fixtures: 0,
    standings: 0,
    newlyFinishedFixtureIds: [],
    changedFixtureIds: [],
    unmappedStages: [],
    seasonUnavailable: false,
    crestsMirrored: 0,
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
//
// Exported for unit testing: these carry the logic worth pinning, and none of them
// touch the database.

/**
 * Group the two legs of a two-legged tie under one key.
 *
 * The provider gives no tie identifier, so it is derived from the pair of teams. Sorting
 * the ids makes the key identical for both legs despite home and away swapping.
 */
export function buildTieKey(
  stageKey: string | null,
  homeTeamId: string | null,
  awayTeamId: string | null,
): string | null {
  if (!stageKey || !homeTeamId || !awayTeamId) return null;
  return `${stageKey}:${[homeTeamId, awayTeamId].sort().join('-')}`;
}

export interface TieAssignable {
  providerFixtureId: string;
  stageKey: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  matchday: number | null;
  kickoffAt: Date | null;
}

/**
 * Work out `tieKey` and `legNumber` for every fixture in a two-legged stage.
 *
 * football-data reports the leg number as the fixture's `matchday` (verified in Phase 2:
 * PLAYOFFS, LAST_16, QUARTER_FINALS and SEMI_FINALS all come back with matchday 1 or 2),
 * so that is used directly. Ordering by kickoff — the original plan — is ambiguous when
 * both legs share a date, and wrong when a leg is postponed. Kickoff order is kept only
 * as the fallback for a provider that does not supply a usable matchday.
 */
export function assignTieMetadata<T extends TieAssignable>(
  fixtures: T[],
  format: LiveFormatDef,
): Map<string, { tieKey: string | null; legNumber: number | null }> {
  const out = new Map<string, { tieKey: string | null; legNumber: number | null }>();
  const needsFallback = new Map<string, T[]>();

  for (const f of fixtures) {
    const stage = format.stages.find(s => s.key === f.stageKey);
    if (!stage || stage.kind !== 'knockout' || stage.legs !== 2) {
      out.set(f.providerFixtureId, { tieKey: null, legNumber: null });
      continue;
    }

    const tieKey = buildTieKey(f.stageKey, f.homeTeamId, f.awayTeamId);
    if (tieKey === null) {
      // Teams not drawn yet — the tie cannot be identified.
      out.set(f.providerFixtureId, { tieKey: null, legNumber: null });
      continue;
    }

    if (f.matchday === 1 || f.matchday === 2) {
      out.set(f.providerFixtureId, { tieKey, legNumber: f.matchday });
    } else {
      out.set(f.providerFixtureId, { tieKey, legNumber: null });
      const bucket = needsFallback.get(tieKey);
      if (bucket) bucket.push(f);
      else needsFallback.set(tieKey, [f]);
    }
  }

  // Fallback: order whatever is left within its tie by kickoff time.
  for (const [tieKey, group] of needsFallback) {
    const ordered = [...group].sort((a, b) => {
      const at = a.kickoffAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = b.kickoffAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at === bt ? a.providerFixtureId.localeCompare(b.providerFixtureId) : at - bt;
    });
    ordered.forEach((f, i) => out.set(f.providerFixtureId, { tieKey, legNumber: i + 1 }));
  }

  return out;
}

export interface QualificationInput {
  teamIds: string[];
  /** Teams with a row in live_standings — i.e. they are in the competition proper. */
  teamIdsInStandings: Set<string>;
  /** Teams appearing in a fixture at or above the tournament's startStageKey. */
  teamIdsAtOrAboveStart: Set<string>;
  /** Teams that lost a decided tie in a stage below startStageKey. */
  teamIdsEliminatedBelowStart: Set<string>;
}

/**
 * Decide each team's qualification status.
 *
 * Note this is weaker than the original plan intended, and deliberately so. That design
 * derived `eliminated` from lost ties in the qualifying rounds — but football-data does
 * not cover the Champions League qualifiers at all (Phase 2 confirmed coverage starts at
 * the league phase), so for the first target competition there is nothing to derive it
 * from. The elimination branch is kept for providers that do expose those rounds; on
 * football-data every team is simply `pending` until the draw, then `qualified`.
 */
export function deriveQualificationStatuses(
  input: QualificationInput,
): Map<string, LiveQualificationStatus> {
  const out = new Map<string, LiveQualificationStatus>();
  for (const teamId of input.teamIds) {
    if (input.teamIdsInStandings.has(teamId) || input.teamIdsAtOrAboveStart.has(teamId)) {
      out.set(teamId, 'qualified');
    } else if (input.teamIdsEliminatedBelowStart.has(teamId)) {
      out.set(teamId, 'eliminated');
    } else {
      out.set(teamId, 'pending');
    }
  }
  return out;
}

/** Which team lost, if the fixture is decided. Uses the provider's own winner field. */
export function loserOf(fixture: {
  status: string;
  winner: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
}): string | null {
  if (fixture.status !== 'finished') return null;
  if (fixture.winner === 'HOME_TEAM') return fixture.awayTeamId;
  if (fixture.winner === 'AWAY_TEAM') return fixture.homeTeamId;
  return null;
}

/** `dateFrom`/`dateTo` for the live window: yesterday through tomorrow, UTC. */
export function liveWindowDates(now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const day = 24 * 60 * 60 * 1000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: iso(new Date(now.getTime() - day)), dateTo: iso(new Date(now.getTime() + day)) };
}

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Persistence ───────────────────────────────────────────────────────────────

type TournamentRow = typeof liveTournaments.$inferSelect;

async function loadTournament(tournamentId: string): Promise<TournamentRow> {
  const [row] = await db.select().from(liveTournaments).where(eq(liveTournaments.id, tournamentId));
  if (!row) throw new Error(`Live tournament not found: ${tournamentId}`);
  return row;
}

async function chunked<T>(rows: T[], fn: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await fn(rows.slice(i, i + CHUNK_SIZE));
  }
}

/**
 * Upsert teams and return a providerTeamId → local id map.
 *
 * `qualification_status` is deliberately absent from the update set: it is derived later
 * in the sync, and overwriting it here would flap it back to the column default.
 */
async function upsertTeams(
  tournamentId: string,
  teams: ProviderTeam[],
): Promise<Map<string, string>> {
  const unique = new Map<string, ProviderTeam>();
  for (const t of teams) if (!unique.has(t.providerTeamId)) unique.set(t.providerTeamId, t);

  if (unique.size > 0) {
    const rows = [...unique.values()].map(t => ({
      id: generateId(15),
      liveTournamentId: tournamentId,
      providerTeamId: t.providerTeamId,
      name: t.name,
      shortName: t.shortName ?? null,
      tla: t.tla ?? null,
      crestUrl: t.crestUrl ?? null,
      groupName: t.groupName ?? null,
    }));

    await chunked(rows, async chunk => {
      await db
        .insert(liveTeams)
        .values(chunk)
        .onConflictDoUpdate({
          target: [liveTeams.liveTournamentId, liveTeams.providerTeamId],
          set: {
            name: sql`excluded.name`,
            shortName: sql`excluded.short_name`,
            tla: sql`excluded.tla`,
            // A crest already mirrored into R2 must survive re-syncing, or every sync
            // would reset it to the provider URL and mirrorTeamCrests would re-download
            // all of them. See server/src/live/crests.ts.
            crestUrl: sql`CASE WHEN ${liveTeams.crestUrl} LIKE '/api/images/%' THEN ${liveTeams.crestUrl} ELSE excluded.crest_url END`,
            groupName: sql`coalesce(excluded.group_name, ${liveTeams.groupName})`,
          },
        });
    });
  }

  const stored = await db
    .select({ id: liveTeams.id, providerTeamId: liveTeams.providerTeamId })
    .from(liveTeams)
    .where(eq(liveTeams.liveTournamentId, tournamentId));

  return new Map(stored.map(t => [t.providerTeamId, t.id]));
}

interface FixtureUpsertResult {
  written: number;
  newlyFinishedFixtureIds: string[];
  changedFixtureIds: string[];
  unmappedStages: string[];
}

async function upsertFixtures(
  tournament: TournamentRow,
  format: LiveFormatDef,
  fixtures: ProviderFixture[],
  teamIdByProviderId: Map<string, string>,
): Promise<FixtureUpsertResult> {
  const unmapped = new Set<string>();
  if (fixtures.length === 0) {
    return { written: 0, newlyFinishedFixtureIds: [], changedFixtureIds: [], unmappedStages: [] };
  }

  // What we already hold for these fixtures, so transitions can be detected.
  const providerIds = fixtures.map(f => f.providerFixtureId);
  const existing = new Map<string, { id: string; status: string; normalTimeHome: number | null; normalTimeAway: number | null }>();
  await chunked(providerIds, async chunk => {
    const rows = await db
      .select({
        id: liveFixtures.id,
        providerFixtureId: liveFixtures.providerFixtureId,
        status: liveFixtures.status,
        normalTimeHome: liveFixtures.normalTimeHome,
        normalTimeAway: liveFixtures.normalTimeAway,
      })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, tournament.id),
          inArray(liveFixtures.providerFixtureId, chunk),
        ),
      );
    for (const r of rows) existing.set(r.providerFixtureId, r);
  });

  const prepared = fixtures.map(f => {
    const stageKey = resolveStageKey(format, tournament.provider, f.providerStage);
    if (!stageKey && f.providerStage) unmapped.add(f.providerStage);

    return {
      dto: f,
      stageKey,
      homeTeamId: f.homeProviderTeamId ? teamIdByProviderId.get(f.homeProviderTeamId) ?? null : null,
      awayTeamId: f.awayProviderTeamId ? teamIdByProviderId.get(f.awayProviderTeamId) ?? null : null,
      kickoffAt: toDate(f.kickoffAt),
    };
  });

  const ties = assignTieMetadata(
    prepared.map(p => ({
      providerFixtureId: p.dto.providerFixtureId,
      stageKey: p.stageKey,
      homeTeamId: p.homeTeamId,
      awayTeamId: p.awayTeamId,
      matchday: p.dto.matchday,
      kickoffAt: p.kickoffAt,
    })),
    format,
  );

  const now = new Date();
  const rows = prepared.map(p => {
    const tie = ties.get(p.dto.providerFixtureId) ?? { tieKey: null, legNumber: null };
    const score = p.dto.score;
    return {
      id: existing.get(p.dto.providerFixtureId)?.id ?? generateId(15),
      liveTournamentId: tournament.id,
      providerFixtureId: p.dto.providerFixtureId,
      homeTeamId: p.homeTeamId,
      awayTeamId: p.awayTeamId,
      kickoffAt: p.kickoffAt,
      kickoffConfirmed: p.dto.kickoffConfirmed,
      status: p.dto.status,
      stageKey: p.stageKey,
      providerStage: p.dto.providerStage,
      groupName: p.dto.groupName,
      matchday: p.dto.matchday,
      tieKey: tie.tieKey,
      legNumber: tie.legNumber,
      normalTimeHome: score.normalTime.home,
      normalTimeAway: score.normalTime.away,
      halfTimeHome: score.halfTime.home,
      halfTimeAway: score.halfTime.away,
      extraTimeHome: score.extraTime.home,
      extraTimeAway: score.extraTime.away,
      penaltiesHome: score.penalties.home,
      penaltiesAway: score.penalties.away,
      finalHome: score.final.home,
      finalAway: score.final.away,
      winner: score.winner,
      minute: p.dto.minute,
      providerScoreRaw: score.raw as object,
      providerLastUpdated: toDate(p.dto.providerLastUpdated),
      updatedAt: now,
    };
  });

  await chunked(rows, async chunk => {
    await db
      .insert(liveFixtures)
      .values(chunk)
      .onConflictDoUpdate({
        target: [liveFixtures.liveTournamentId, liveFixtures.providerFixtureId],
        set: {
          // Team links are only ever upgraded, never cleared: once a draw has assigned a
          // team, a later payload that omits it must not blank an existing prediction's
          // opponent out from under the users.
          homeTeamId: sql`coalesce(excluded.home_team_id, ${liveFixtures.homeTeamId})`,
          awayTeamId: sql`coalesce(excluded.away_team_id, ${liveFixtures.awayTeamId})`,
          kickoffAt: sql`excluded.kickoff_at`,
          kickoffConfirmed: sql`excluded.kickoff_confirmed`,
          status: sql`excluded.status`,
          stageKey: sql`excluded.stage_key`,
          providerStage: sql`excluded.provider_stage`,
          groupName: sql`excluded.group_name`,
          matchday: sql`excluded.matchday`,
          tieKey: sql`excluded.tie_key`,
          legNumber: sql`excluded.leg_number`,
          normalTimeHome: sql`excluded.normal_time_home`,
          normalTimeAway: sql`excluded.normal_time_away`,
          halfTimeHome: sql`excluded.half_time_home`,
          halfTimeAway: sql`excluded.half_time_away`,
          extraTimeHome: sql`excluded.extra_time_home`,
          extraTimeAway: sql`excluded.extra_time_away`,
          penaltiesHome: sql`excluded.penalties_home`,
          penaltiesAway: sql`excluded.penalties_away`,
          finalHome: sql`excluded.final_home`,
          finalAway: sql`excluded.final_away`,
          winner: sql`excluded.winner`,
          minute: sql`excluded.minute`,
          providerScoreRaw: sql`excluded.provider_score_raw`,
          providerLastUpdated: sql`excluded.provider_last_updated`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  });

  const newlyFinishedFixtureIds: string[] = [];
  const changedFixtureIds: string[] = [];
  for (const row of rows) {
    const before = existing.get(row.providerFixtureId);
    if (row.status === 'finished' && before?.status !== 'finished') {
      newlyFinishedFixtureIds.push(row.id);
    } else if (
      before &&
      (before.normalTimeHome !== row.normalTimeHome || before.normalTimeAway !== row.normalTimeAway)
    ) {
      changedFixtureIds.push(row.id);
    }
  }

  return {
    written: rows.length,
    newlyFinishedFixtureIds,
    changedFixtureIds,
    unmappedStages: [...unmapped],
  };
}

async function replaceStandings(
  tournament: TournamentRow,
  format: LiveFormatDef,
  provider: ProviderStandingRow[],
  teamIdByProviderId: Map<string, string>,
): Promise<number> {
  const now = new Date();
  const rows = provider
    .map(r => {
      const stageKey = resolveStageKey(format, tournament.provider, r.providerStage);
      const teamId = teamIdByProviderId.get(r.providerTeamId);
      // stage_key and team_id are both NOT NULL, so a row we cannot resolve is dropped.
      if (!stageKey || !teamId) return null;
      return {
        id: generateId(15),
        liveTournamentId: tournament.id,
        stageKey,
        groupName: r.groupName,
        teamId,
        position: r.position,
        played: r.played,
        won: r.won,
        drawn: r.drawn,
        lost: r.lost,
        goalsFor: r.goalsFor,
        goalsAgainst: r.goalsAgainst,
        goalDifference: r.goalDifference,
        points: r.points,
        form: r.form,
        updatedAt: now,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return 0;

  await chunked(rows, async chunk => {
    await db
      .insert(liveStandings)
      .values(chunk)
      .onConflictDoUpdate({
        target: [liveStandings.liveTournamentId, liveStandings.stageKey, liveStandings.teamId],
        set: {
          groupName: sql`excluded.group_name`,
          position: sql`excluded.position`,
          played: sql`excluded.played`,
          won: sql`excluded.won`,
          drawn: sql`excluded.drawn`,
          lost: sql`excluded.lost`,
          goalsFor: sql`excluded.goals_for`,
          goalsAgainst: sql`excluded.goals_against`,
          goalDifference: sql`excluded.goal_difference`,
          points: sql`excluded.points`,
          form: sql`excluded.form`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  });

  // Drop rows the provider no longer lists, so a team removed from a table disappears
  // rather than lingering at a stale position.
  const keptStages = [...new Set(rows.map(r => r.stageKey))];
  const keptTeamIds = [...new Set(rows.map(r => r.teamId))];
  await db
    .delete(liveStandings)
    .where(
      and(
        eq(liveStandings.liveTournamentId, tournament.id),
        inArray(liveStandings.stageKey, keptStages),
        notInArray(liveStandings.teamId, keptTeamIds),
      ),
    );

  return rows.length;
}

/**
 * Recompute every team's qualification status from what is now in the database.
 * Cheap enough to redo wholesale after each structure sync.
 */
async function refreshQualificationStatuses(
  tournament: TournamentRow,
  format: LiveFormatDef,
): Promise<void> {
  const teams = await db
    .select({ id: liveTeams.id, current: liveTeams.qualificationStatus })
    .from(liveTeams)
    .where(eq(liveTeams.liveTournamentId, tournament.id));
  if (teams.length === 0) return;

  const standingRows = await db
    .select({ teamId: liveStandings.teamId })
    .from(liveStandings)
    .where(eq(liveStandings.liveTournamentId, tournament.id));

  const fixtureRows = await db
    .select({
      stageKey: liveFixtures.stageKey,
      status: liveFixtures.status,
      winner: liveFixtures.winner,
      homeTeamId: liveFixtures.homeTeamId,
      awayTeamId: liveFixtures.awayTeamId,
    })
    .from(liveFixtures)
    .where(eq(liveFixtures.liveTournamentId, tournament.id));

  const atOrAbove = new Set<string>();
  const eliminated = new Set<string>();
  for (const f of fixtureRows) {
    const isAtOrAbove = isStageAtOrAfter(format, f.stageKey, tournament.startStageKey);
    if (isAtOrAbove) {
      if (f.homeTeamId) atOrAbove.add(f.homeTeamId);
      if (f.awayTeamId) atOrAbove.add(f.awayTeamId);
    } else {
      const loser = loserOf(f);
      if (loser) eliminated.add(loser);
    }
  }

  const statuses = deriveQualificationStatuses({
    teamIds: teams.map(t => t.id),
    teamIdsInStandings: new Set(standingRows.map(r => r.teamId)),
    teamIdsAtOrAboveStart: atOrAbove,
    teamIdsEliminatedBelowStart: eliminated,
  });

  // Only write the ones that actually moved.
  const byStatus = new Map<LiveQualificationStatus, string[]>();
  for (const team of teams) {
    const next = statuses.get(team.id);
    if (!next || next === team.current) continue;
    const bucket = byStatus.get(next);
    if (bucket) bucket.push(team.id);
    else byStatus.set(next, [team.id]);
  }

  for (const [status, ids] of byStatus) {
    await chunked(ids, async chunk => {
      await db
        .update(liveTeams)
        .set({ qualificationStatus: status })
        .where(inArray(liveTeams.id, chunk));
    });
  }
}

async function recordSyncOutcome(
  tournamentId: string,
  field: 'structure' | 'window',
  error: string | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(liveTournaments)
    .set(
      field === 'structure'
        ? { lastStructureSyncAt: now, lastFixtureSyncAt: now, lastSyncError: error }
        : { lastFixtureSyncAt: now, lastSyncError: error },
    )
    .where(eq(liveTournaments.id, tournamentId));
}

/**
 * Turn a thrown provider error into the message stored on the tournament.
 * An unpublished season is reported as a state, not a failure.
 */
function describeError(err: unknown): { message: string; seasonUnavailable: boolean } {
  if (err instanceof ProviderError) {
    if (err.isSeasonUnavailable) {
      return {
        message: `Season not published by the provider yet (404 on ${err.path})`,
        seasonUnavailable: true,
      };
    }
    return { message: err.message, seasonUnavailable: false };
  }
  return { message: err instanceof Error ? err.message : String(err), seasonUnavailable: false };
}

// ── Entry points ──────────────────────────────────────────────────────────────

/**
 * Full structure sync: teams, every fixture, and standings. Roughly three provider
 * requests. Safe to re-run at any time, including before the competition's draw.
 */
export async function syncTournamentStructure(tournamentId: string): Promise<SyncResult> {
  const tournament = await loadTournament(tournamentId);
  const format = getLiveFormat(tournament.format);
  const provider = getProvider(tournament.provider);
  const result = emptyResult();

  try {
    const [providerTeams, providerFixtures] = await Promise.all([
      provider
        .fetchTeams(tournament.providerCompetitionId, tournament.season)
        // A missing teams list is survivable — fixtures carry their teams inline.
        .catch(err => {
          if (err instanceof ProviderError && err.isSeasonUnavailable) return [] as ProviderTeam[];
          throw err;
        }),
      provider.fetchFixtures(tournament.providerCompetitionId, tournament.season),
    ]);

    // Teams named on fixtures but absent from /teams still need rows, or the fixture
    // would point at nothing. Listing /teams first means it wins on conflicting details.
    const fromFixtures = providerFixtures.flatMap(f =>
      [f.homeTeam, f.awayTeam].filter((t): t is ProviderTeam => t !== null),
    );
    const teamIdByProviderId = await upsertTeams(tournament.id, [...providerTeams, ...fromFixtures]);
    result.teams = teamIdByProviderId.size;

    const fixtureOutcome = await upsertFixtures(
      tournament,
      format,
      providerFixtures,
      teamIdByProviderId,
    );
    result.fixtures = fixtureOutcome.written;
    result.newlyFinishedFixtureIds = fixtureOutcome.newlyFinishedFixtureIds;
    result.changedFixtureIds = fixtureOutcome.changedFixtureIds;
    result.unmappedStages = fixtureOutcome.unmappedStages;

    // Standings are optional: a season with no games played has no table yet.
    try {
      const providerStandings = await provider.fetchStandings(
        tournament.providerCompetitionId,
        tournament.season,
      );
      result.standings = await replaceStandings(
        tournament,
        format,
        providerStandings,
        teamIdByProviderId,
      );
    } catch (err) {
      if (!(err instanceof ProviderError && err.isSeasonUnavailable)) throw err;
    }

    await refreshQualificationStatuses(tournament, format);

    // Best-effort, and last: a crest host that is down or an R2 hiccup must not cost us
    // the fixtures and standings we just fetched.
    try {
      const crests = await mirrorTeamCrests(
        tournament.id,
        [...providerTeams, ...fromFixtures],
        teamIdByProviderId,
      );
      result.crestsMirrored = crests.mirrored;
      if (crests.failed > 0) {
        console.warn(`[live-sync] ${tournament.id}: ${crests.failed} crest(s) failed to mirror`);
      }
    } catch (err) {
      console.warn(
        `[live-sync] ${tournament.id}: crest mirroring skipped:`,
        err instanceof Error ? err.message : err,
      );
    }

    await recordSyncOutcome(tournament.id, 'structure', null);
    return result;
  } catch (err) {
    const { message, seasonUnavailable } = describeError(err);
    await recordSyncOutcome(tournament.id, 'structure', seasonUnavailable ? null : message);
    if (!seasonUnavailable) throw err;
    result.seasonUnavailable = true;
    return result;
  }
}

/**
 * Fixture-only sync across a narrow date window. One provider request, and the path that
 * carries live scores. Does not touch teams or standings.
 */
export async function syncLiveWindow(tournamentId: string): Promise<SyncResult> {
  const tournament = await loadTournament(tournamentId);
  const format = getLiveFormat(tournament.format);
  const provider = getProvider(tournament.provider);
  const result = emptyResult();

  try {
    const providerFixtures = await provider.fetchFixtures(
      tournament.providerCompetitionId,
      tournament.season,
      liveWindowDates(),
    );

    const existingTeams = await db
      .select({ id: liveTeams.id, providerTeamId: liveTeams.providerTeamId })
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id));
    const teamIdByProviderId = new Map(existingTeams.map(t => [t.providerTeamId, t.id]));

    const outcome = await upsertFixtures(tournament, format, providerFixtures, teamIdByProviderId);
    result.fixtures = outcome.written;
    result.newlyFinishedFixtureIds = outcome.newlyFinishedFixtureIds;
    result.changedFixtureIds = outcome.changedFixtureIds;
    result.unmappedStages = outcome.unmappedStages;

    await recordSyncOutcome(tournament.id, 'window', null);
    return result;
  } catch (err) {
    const { message, seasonUnavailable } = describeError(err);
    await recordSyncOutcome(tournament.id, 'window', seasonUnavailable ? null : message);
    if (!seasonUnavailable) throw err;
    result.seasonUnavailable = true;
    return result;
  }
}
