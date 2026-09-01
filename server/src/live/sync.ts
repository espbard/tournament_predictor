import { and, eq, gt, inArray, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  getLiveFormat,
  getLiveTournamentPreset,
  isStageAtOrAfter,
  resolveStageKey,
  type LiveFormatDef,
  type LiveQualificationStatus,
} from '@tournament-predictor/shared';
import { db } from '../db/client';
import {
  liveFixtures,
  livePredictions,
  liveStandings,
  liveTeams,
  liveTournaments,
} from '../db/liveSchema';
import { mirrorTeamCrests } from './crests';
import { deriveMatchdays } from './matchdays';
import { syncLivePlayers } from './scorers';
import { seasonWindow } from './season';
import { getProvider } from './providers';
import { buildTeamNameIndex, matchTeamByName } from './teamMatching';
import {
  ProviderError,
  type FetchFixturesOptions,
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
// A tournament may read fixtures from a *different* provider than its teams and table
// (live_tournaments.fixture_provider — the Champions League 2026/27 is why). Two things
// change when it does, both handled here rather than in the adapters:
//
//   * a fixture's teams are matched by name against the rows the main provider created,
//     because providers do not share team ids, and the embedded teams are NOT inserted;
//   * a fixture with no stage is filed under the tournament's startStageKey, since a
//     provider that reports no stage would otherwise leave every fixture unpredictable;
//   * a matchday is derived from the calendar when the provider reports none, because the
//     matchday *is* the gameweek — see matchdays.ts.
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
  /**
   * Team names on fixtures from a second fixture provider that no stored team matched.
   * Those fixtures are stored with no team link rather than a guessed one.
   */
  unresolvedTeamNames: string[];
  /** True when the provider has not published this season yet. Not an error. */
  seasonUnavailable: boolean;
  /** Team crests copied into R2 by this sync. Zero on every sync after the first. */
  crestsMirrored: number;
  /** Fixtures removed because their kickoff falls outside the tournament's season. */
  outOfSeasonRemoved: number;
  /**
   * Players whose goals were refreshed from the provider's scorer list, created or
   * updated. Zero for a provider that serves none — the top-scorer ranking then runs on
   * the counts an admin maintains by hand.
   */
  scorersSynced: number;
}

function emptyResult(): SyncResult {
  return {
    teams: 0,
    fixtures: 0,
    standings: 0,
    newlyFinishedFixtureIds: [],
    changedFixtureIds: [],
    unmappedStages: [],
    unresolvedTeamNames: [],
    seasonUnavailable: false,
    crestsMirrored: 0,
    outOfSeasonRemoved: 0,
    scorersSynced: 0,
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
  unresolvedTeamNames: string[];
}

/**
 * How a fixture's two teams are turned into local team ids.
 *
 * `byProviderId` is the normal path: one provider serves both teams and fixtures, so the
 * ids line up. `byName` is used when fixtures come from a second provider, which knows
 * the clubs by name only. Deciding this once, here, keeps the branch out of every call
 * site and makes the two paths testable in isolation.
 */
export type TeamResolver = (fixture: ProviderFixture, side: 'home' | 'away') =>
  { teamId: string | null; unresolvedName: string | null };

export function resolveByProviderId(teamIdByProviderId: Map<string, string>): TeamResolver {
  return (fixture, side) => {
    const providerTeamId =
      side === 'home' ? fixture.homeProviderTeamId : fixture.awayProviderTeamId;
    return {
      teamId: providerTeamId ? teamIdByProviderId.get(providerTeamId) ?? null : null,
      unresolvedName: null,
    };
  };
}

export function resolveByName(nameIndex: Map<string, string>): TeamResolver {
  return (fixture, side) => {
    const team = side === 'home' ? fixture.homeTeam : fixture.awayTeam;
    // No team named at all is an undrawn slot, not a failure to match.
    if (!team) return { teamId: null, unresolvedName: null };

    const teamId = matchTeamByName(team, nameIndex);
    return { teamId, unresolvedName: teamId ? null : team.name };
  };
}

async function upsertFixtures(
  tournament: TournamentRow,
  format: LiveFormatDef,
  fixtures: ProviderFixture[],
  resolveTeam: TeamResolver,
  /** Stage for a fixture the provider files under none. Null leaves it unmapped. */
  defaultStageKey: string | null,
): Promise<FixtureUpsertResult> {
  const unmapped = new Set<string>();
  const unresolvedTeamNames = new Set<string>();
  if (fixtures.length === 0) {
    return {
      written: 0,
      newlyFinishedFixtureIds: [],
      changedFixtureIds: [],
      unmappedStages: [],
      unresolvedTeamNames: [],
    };
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

  const fixtureProviderId = tournament.fixtureProvider ?? tournament.provider;

  const prepared = fixtures.map(f => {
    const mapped = resolveStageKey(format, fixtureProviderId, f.providerStage);
    if (!mapped && f.providerStage) unmapped.add(f.providerStage);
    // A provider that reports no stage at all gets the tournament's default rather than
    // a null that would make the fixture unpredictable. A stage string we simply do not
    // recognise keeps its null: that is a mapping gap worth surfacing, not papering over.
    const stageKey = mapped ?? (f.providerStage === null ? defaultStageKey : null);

    const home = resolveTeam(f, 'home');
    const away = resolveTeam(f, 'away');
    if (home.unresolvedName) unresolvedTeamNames.add(home.unresolvedName);
    if (away.unresolvedName) unresolvedTeamNames.add(away.unresolvedName);

    return {
      dto: f,
      stageKey,
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      kickoffAt: toDate(f.kickoffAt),
    };
  });

  // A provider that reports no matchday leaves every fixture outside every gameweek, so
  // one is derived from the kickoff calendar. A no-op for football-data, which always
  // reports one. Done before the tie metadata below, which reads the matchday as a leg
  // number for two-legged ties.
  const matchdayByFixtureId = deriveMatchdays(
    prepared.map(p => ({
      providerFixtureId: p.dto.providerFixtureId,
      stageKey: p.stageKey,
      matchday: p.dto.matchday,
      kickoffAt: p.kickoffAt,
    })),
  );
  const matchdayOf = (providerFixtureId: string) =>
    matchdayByFixtureId.get(providerFixtureId) ?? null;

  const ties = assignTieMetadata(
    prepared.map(p => ({
      providerFixtureId: p.dto.providerFixtureId,
      stageKey: p.stageKey,
      homeTeamId: p.homeTeamId,
      awayTeamId: p.awayTeamId,
      matchday: matchdayOf(p.dto.providerFixtureId),
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
      matchday: matchdayOf(p.dto.providerFixtureId),
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
    unresolvedTeamNames: [...unresolvedTeamNames],
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

/**
 * Remove fixtures whose kickoff falls outside the tournament's season.
 *
 * A provider that ignores the date range it was given writes a neighbouring season's
 * fixtures into the tournament, and upserting never takes them back out again — so a
 * single bad sync leaves them there for good. bigballsdata did exactly this: asked for
 * 2026/27 it answered with all 273 Champions League matches it holds.
 *
 * Fixtures carrying predictions are left alone and reported instead. Nobody should have
 * predicted a fixture from another season, but deleting one would cascade to real
 * predictions and points, and that is not a call a sync gets to make quietly.
 */
async function removeOutOfSeasonFixtures(tournament: TournamentRow): Promise<number> {
  const window = seasonWindow(tournament.season, seasonBoundsFor(tournament));
  if (!window) return 0;

  const from = new Date(`${window.dateFrom}T00:00:00Z`);
  const to = new Date(`${window.dateTo}T23:59:59Z`);

  // Drizzle's own operators rather than a sql`` template: a Date interpolated into a raw
  // fragment reaches Postgres as an untyped parameter, and comparing a timestamp against
  // one is rejected outright. lt/gt carry the column's type with them.
  const strays = await db
    .select({ id: liveFixtures.id })
    .from(liveFixtures)
    .where(
      and(
        eq(liveFixtures.liveTournamentId, tournament.id),
        isNotNull(liveFixtures.kickoffAt),
        or(lt(liveFixtures.kickoffAt, from), gt(liveFixtures.kickoffAt, to)),
      ),
    );
  if (strays.length === 0) return 0;

  const strayIds = strays.map(f => f.id);
  const predicted = await db
    .select({ liveFixtureId: livePredictions.liveFixtureId })
    .from(livePredictions)
    .where(inArray(livePredictions.liveFixtureId, strayIds));
  const keep = new Set(predicted.map(p => p.liveFixtureId));

  const removable = strayIds.filter(id => !keep.has(id));
  if (keep.size > 0) {
    console.warn(
      `[live-sync] ${tournament.id}: ${keep.size} out-of-season fixture(s) have predictions ` +
        'attached and were left in place — remove them by hand if they are wrong',
    );
  }
  if (removable.length === 0) return 0;

  await chunked(removable, async chunk => {
    await db.delete(liveFixtures).where(inArray(liveFixtures.id, chunk));
  });

  console.warn(
    `[live-sync] ${tournament.id}: removed ${removable.length} fixture(s) outside season ` +
      `${tournament.season} (${window.dateFrom} to ${window.dateTo})`,
  );
  return removable.length;
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

/**
 * The competition identifier to ask the fixture provider for.
 *
 * Providers do not agree on these: football-data takes "CL", bigballsdata its own league
 * key. Null falls back to the main identifier, which is right whenever one provider
 * serves everything.
 */
export function fixtureCompetitionId(tournament: TournamentRow): string {
  return tournament.fixtureProviderCompetitionId ?? tournament.providerCompetitionId;
}

/**
 * When this tournament's season starts and ends, from its preset.
 *
 * Competitions do not share a calendar, so this is not one rule for all of them: the
 * Champions League league phase opens in September and finishes in late May, a domestic
 * league a month either side of that. Undefined for a tournament created outside the
 * presets, which leaves the generous default in season.ts.
 */
function seasonBoundsFor(tournament: TournamentRow) {
  return getLiveTournamentPreset(tournament.presetKey ?? '')?.seasonBounds;
}

/** The season as a date range, for a provider that filters by date rather than season. */
function seasonWindowFor(tournament: TournamentRow): FetchFixturesOptions {
  const window = seasonWindow(tournament.season, seasonBoundsFor(tournament));
  return window ? { seasonWindow: window } : {};
}

/**
 * The two providers a tournament reads from, and whether they differ.
 *
 * Same provider for both is the normal case and the default: `fixtureProvider` is null
 * unless an admin has deliberately split them.
 */
function providersFor(tournament: TournamentRow) {
  const fixtureProviderId = tournament.fixtureProvider ?? tournament.provider;
  return {
    structure: getProvider(tournament.provider),
    fixtures: getProvider(fixtureProviderId),
    isSplit: fixtureProviderId !== tournament.provider,
  };
}

/**
 * Build the resolver that turns a fixture's teams into local ids.
 *
 * Split providers match by name against the teams already stored; a single provider
 * matches by id, which is exact. The name index is read from the database rather than
 * from the payload being synced, so it works on the live-window path too, where no team
 * data is fetched at all.
 */
async function teamResolverFor(
  tournament: TournamentRow,
  isSplit: boolean,
  teamIdByProviderId: Map<string, string>,
): Promise<TeamResolver> {
  if (!isSplit) return resolveByProviderId(teamIdByProviderId);

  const stored = await db
    .select({
      id: liveTeams.id,
      name: liveTeams.name,
      shortName: liveTeams.shortName,
      tla: liveTeams.tla,
    })
    .from(liveTeams)
    .where(eq(liveTeams.liveTournamentId, tournament.id));

  return resolveByName(buildTeamNameIndex(stored));
}

/**
 * The stage a fixture goes to when its provider names none.
 *
 * Only applied for a split, and only then the tournament's own starting stage: for the
 * Champions League that is the league phase, which is every fixture bigballsdata can
 * describe anyway. A single-provider tournament keeps the old behaviour exactly — an
 * absent stage stays null and shows up as an unmapped-stage warning.
 */
export function defaultStageFor(tournament: TournamentRow, isSplit: boolean): string | null {
  return isSplit ? tournament.startStageKey : null;
}

// ── Entry points ──────────────────────────────────────────────────────────────

/**
 * Full structure sync: teams, every fixture, and standings. Roughly three provider
 * requests. Safe to re-run at any time, including before the competition's draw.
 */
export async function syncTournamentStructure(tournamentId: string): Promise<SyncResult> {
  const tournament = await loadTournament(tournamentId);
  const format = getLiveFormat(tournament.format);
  const { structure, fixtures: fixtureProvider, isSplit } = providersFor(tournament);
  const result = emptyResult();

  try {
    const [providerTeams, providerFixtures] = await Promise.all([
      structure
        .fetchTeams(tournament.providerCompetitionId, tournament.season)
        // A missing teams list is survivable — fixtures carry their teams inline.
        .catch(err => {
          if (err instanceof ProviderError && err.isSeasonUnavailable) return [] as ProviderTeam[];
          throw err;
        }),
      fixtureProvider.fetchFixtures(
        // A split fixture provider has its own identifier for the competition.
        fixtureCompetitionId(tournament),
        tournament.season,
        // ...and may need telling where the season sits in the calendar, for want of a
        // season parameter of its own.
        seasonWindowFor(tournament),
      ),
    ]);

    // Teams named on fixtures but absent from /teams still need rows, or the fixture
    // would point at nothing. Listing /teams first means it wins on conflicting details.
    //
    // Not so for a split: the second provider names clubs without ids, so inserting its
    // teams would duplicate all 36 under a made-up key. Those fixtures are matched to
    // the rows the main provider created instead.
    const fromFixtures = isSplit
      ? []
      : providerFixtures.flatMap(f =>
          [f.homeTeam, f.awayTeam].filter((t): t is ProviderTeam => t !== null),
        );
    const teamIdByProviderId = await upsertTeams(tournament.id, [...providerTeams, ...fromFixtures]);
    result.teams = teamIdByProviderId.size;

    const fixtureOutcome = await upsertFixtures(
      tournament,
      format,
      providerFixtures,
      await teamResolverFor(tournament, isSplit, teamIdByProviderId),
      defaultStageFor(tournament, isSplit),
    );
    result.fixtures = fixtureOutcome.written;
    result.newlyFinishedFixtureIds = fixtureOutcome.newlyFinishedFixtureIds;
    result.changedFixtureIds = fixtureOutcome.changedFixtureIds;
    result.unmappedStages = fixtureOutcome.unmappedStages;
    result.unresolvedTeamNames = fixtureOutcome.unresolvedTeamNames;
    if (fixtureOutcome.unresolvedTeamNames.length > 0) {
      console.warn(
        `[live-sync] ${tournament.id}: ${fixtureOutcome.unresolvedTeamNames.length} team name(s) ` +
          `from ${fixtureProvider.id} matched no stored team: ` +
          fixtureOutcome.unresolvedTeamNames.join(', '),
      );
    }

    // Standings are optional: a season with no games played has no table yet.
    try {
      const providerStandings = await structure.fetchStandings(
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

    // After the upsert, so a provider that ignored the season it was asked for does not
    // leave another season's fixtures behind for good.
    result.outOfSeasonRemoved = await removeOutOfSeasonFixtures(tournament);

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

    // Also best-effort: the scorer list is a separate resource that a provider may not
    // serve at all, and the top-scorer ranking falls back to hand-entered goals when it
    // does not. Losing the fixtures and standings over it would be absurd.
    //
    // Goals only: squads are pulled by an admin import, not on every cold tick. See
    // SyncLiveScorersOptions.includeSquads.
    try {
      const players = await syncLivePlayers(tournament.id, { includeSquads: false });
      result.scorersSynced = players.created + players.updated + players.adopted;
    } catch (err) {
      console.warn(
        `[live-sync] ${tournament.id}: scorer list skipped:`,
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
  const { fixtures: fixtureProvider, isSplit } = providersFor(tournament);
  const result = emptyResult();

  try {
    const providerFixtures = await fixtureProvider.fetchFixtures(
      fixtureCompetitionId(tournament),
      tournament.season,
      { ...liveWindowDates(), ...seasonWindowFor(tournament) },
    );

    const existingTeams = await db
      .select({ id: liveTeams.id, providerTeamId: liveTeams.providerTeamId })
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id));
    const teamIdByProviderId = new Map(existingTeams.map(t => [t.providerTeamId, t.id]));

    const outcome = await upsertFixtures(
      tournament,
      format,
      providerFixtures,
      await teamResolverFor(tournament, isSplit, teamIdByProviderId),
      defaultStageFor(tournament, isSplit),
    );
    result.fixtures = outcome.written;
    result.newlyFinishedFixtureIds = outcome.newlyFinishedFixtureIds;
    result.changedFixtureIds = outcome.changedFixtureIds;
    result.unmappedStages = outcome.unmappedStages;
    result.unresolvedTeamNames = outcome.unresolvedTeamNames;

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
