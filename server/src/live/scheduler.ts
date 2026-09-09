import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { appConfig } from '../db/schema';
import { liveFixtures, liveTournaments } from '../db/liveSchema';
import { applyScorerRefresh, applySyncResult } from './scoringTrigger';
import { syncLiveScorers, syncLiveWindow, syncTournamentStructure, type SyncResult } from './sync';

// ── Sync scheduler ────────────────────────────────────────────────────────────
//
// There is no cron, queue or worker in this project and it deploys as a single Railway
// service, so the sync runs on an in-process interval started from start() in
// server/src/index.ts. It is what makes scores and points update themselves: nobody has
// to open a tournament and press a button for a result to reach a leaderboard.
//
// The hard constraint is the provider's free tier: 10 requests per minute across the
// whole account. So the tick does not sync everything it could — it ranks tournaments by
// how urgently they need data and spends a per-minute budget on the most urgent.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §7.

/**
 * Advisory lock key. Arbitrary but must stay stable — changing it would let an old and a
 * new deployment sync concurrently during a rollover.
 */
const ADVISORY_LOCK_KEY = 8_027_431_105;

const DEFAULT_TICK_SECONDS = 30;
/** Requests a single tick may spend, leaving headroom for admin-triggered syncs. */
const DEFAULT_TICK_BUDGET = 6;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A hot tournament is re-polled at most this often. */
const HOT_INTERVAL = MINUTE;
const WARM_INTERVAL = 15 * MINUTE;
const COLD_INTERVAL = 6 * HOUR;

/**
 * How stale a structure sync may get before one is planned whatever the temperature.
 *
 * A window sync carries live scores but not the table, the qualification statuses or the
 * scorers' goal counts. A tournament playing something every day — a World Cup group
 * stage — never goes cold, so without this it would never refresh any of them and an
 * admin would have to press "Full sync" to move a table prediction.
 */
const STRUCTURE_MAX_AGE = COLD_INTERVAL;

/** Roughly the cost of each sync in provider requests. */
const STRUCTURE_REQUEST_COST = 3;
const WINDOW_REQUEST_COST = 1;

export type SyncTemperature = 'hot' | 'warm' | 'cold';

let tickInProgress = false;
let timer: NodeJS.Timeout | null = null;

// ── Is the sync on? ───────────────────────────────────────────────────────────
//
// Two switches, because they answer different questions:
//
//   * the environment sets the default for a deployment — a dev machine must not quietly
//     spend the shared account budget, a production deploy should not need one more
//     variable set before results arrive on their own;
//   * app_config.live_sync_enabled is an admin override that survives a restart and,
//     crucially, can be flipped from the admin page without a redeploy.

export type SyncEnabledReason =
  | 'env-on'
  | 'env-off'
  | 'production-default'
  | 'development-default'
  | 'no-provider-key';

export interface SyncEnabledDecision {
  enabled: boolean;
  reason: SyncEnabledReason;
}

const TRUTHY = new Set(['true', '1', 'on', 'yes']);
const FALSY = new Set(['false', '0', 'off', 'no']);

/**
 * The deployment's default, from the environment alone.
 *
 * `LIVE_SYNC_ENABLED` is still honoured in both directions and still wins, so an existing
 * deployment behaves exactly as it was configured to. What changed is the *unset* case:
 * it used to mean "off everywhere", which left a production deployment syncing only when
 * an admin pressed a button. Unset now means "on in production if there is a key to sync
 * with", and stays off in development for the reason the flag was introduced — two
 * developers running `npm run dev` would otherwise share, and exhaust, the account-wide
 * request budget.
 */
export function resolveSyncEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SyncEnabledDecision {
  const raw = (env.LIVE_SYNC_ENABLED ?? '').trim().toLowerCase();
  if (FALSY.has(raw)) return { enabled: false, reason: 'env-off' };
  if (TRUTHY.has(raw)) return { enabled: true, reason: 'env-on' };

  if (env.NODE_ENV !== 'production') return { enabled: false, reason: 'development-default' };

  const hasKey = Boolean(env.FOOTBALL_DATA_API_KEY?.trim() || env.BIG_BALLS_API_KEY?.trim());
  if (!hasKey) return { enabled: false, reason: 'no-provider-key' };
  return { enabled: true, reason: 'production-default' };
}

/**
 * Combine the deployment default with the stored admin override.
 *
 * A null override defers to the environment — which is not the same as `false`, and is
 * why the column is nullable. `LIVE_SYNC_ENABLED=false` is the one thing an override
 * cannot beat: it is the kill switch a developer sets to be certain their machine spends
 * nothing, and a switch that something in a shared database can flip back on is not one.
 */
export function resolveSyncEnabled(
  override: boolean | null,
  env: NodeJS.ProcessEnv = process.env,
): SyncEnabledDecision & { override: boolean | null } {
  const fromEnv = resolveSyncEnabledFromEnv(env);
  if (override === null || fromEnv.reason === 'env-off') return { ...fromEnv, override };
  return { enabled: override, reason: fromEnv.reason, override };
}

/** The stored override, or null when an admin has never set one. */
export async function readSyncOverride(): Promise<boolean | null> {
  const [row] = await db
    .select({ liveSyncEnabled: appConfig.liveSyncEnabled })
    .from(appConfig)
    .where(eq(appConfig.id, 'singleton'))
    .limit(1);
  return row?.liveSyncEnabled ?? null;
}

/** Set — or with null clear — the admin override. Takes effect on the next tick. */
export async function writeSyncOverride(enabled: boolean | null): Promise<void> {
  await db
    .insert(appConfig)
    .values({ id: 'singleton', liveSyncEnabled: enabled })
    .onConflictDoUpdate({ target: appConfig.id, set: { liveSyncEnabled: enabled } });
}

// ── Pure scheduling logic ─────────────────────────────────────────────────────

export interface SchedulableTournament {
  id: string;
  lastStructureSyncAt: Date | null;
  lastFixtureSyncAt: Date | null;
  /** Earliest kickoff among fixtures that have not finished. Null when none are known. */
  nextKickoffAt: Date | null;
  /** True when any fixture is currently in_play or paused. */
  hasLiveFixture: boolean;
}

/**
 * How urgently a tournament needs data.
 *
 * hot   a fixture is under way, or one kicks off within 15 minutes, or one kicked off in
 *       the last 3 hours and so is probably still being played
 * warm  something kicks off in the next 24 hours
 * cold  nothing imminent
 */
export function classifyTournament(t: SchedulableTournament, now: Date = new Date()): SyncTemperature {
  if (t.hasLiveFixture) return 'hot';

  if (t.nextKickoffAt) {
    const delta = t.nextKickoffAt.getTime() - now.getTime();
    if (delta <= 15 * MINUTE && delta >= -3 * HOUR) return 'hot';
    if (delta > 0 && delta <= 24 * HOUR) return 'warm';
  }
  return 'cold';
}

/** How often the window sync runs at each temperature. Cold does not window-sync at all. */
function windowInterval(temperature: SyncTemperature): number | null {
  if (temperature === 'hot') return HOT_INTERVAL;
  if (temperature === 'warm') return WARM_INTERVAL;
  return null;
}

export interface PlannedSync {
  tournamentId: string;
  temperature: SyncTemperature;
  kind: 'structure' | 'window';
  /** Milliseconds since the relevant sync last ran. Higher is more urgent. */
  staleness: number;
  cost: number;
}

/**
 * Everything a tournament is due for right now, at most one job of each kind.
 *
 * A hot or warm tournament is due a window sync on its own clock and, independently, a
 * structure sync once its last one is `STRUCTURE_MAX_AGE` old. A cold one is due only the
 * structure sync, which is the same job on the same clock — so a tournament cooling down
 * mid-season does not suddenly re-sync.
 */
function candidatesFor(t: SchedulableTournament, now: Date): PlannedSync[] {
  const temperature = classifyTournament(t, now);
  const out: PlannedSync[] = [];

  const interval = windowInterval(temperature);
  if (interval !== null) {
    const staleness = now.getTime() - (t.lastFixtureSyncAt?.getTime() ?? 0);
    if (staleness >= interval) {
      out.push({
        tournamentId: t.id,
        temperature,
        kind: 'window',
        staleness,
        cost: WINDOW_REQUEST_COST,
      });
    }
  }

  const structureStaleness = now.getTime() - (t.lastStructureSyncAt?.getTime() ?? 0);
  if (structureStaleness >= (temperature === 'cold' ? COLD_INTERVAL : STRUCTURE_MAX_AGE)) {
    out.push({
      tournamentId: t.id,
      temperature,
      kind: 'structure',
      staleness: structureStaleness,
      cost: STRUCTURE_REQUEST_COST,
    });
  }

  return out;
}

/**
 * Order in which jobs are offered the budget.
 *
 * Live scores first, then tomorrow's fixtures, then the periodic structure refresh — that
 * last one carries the table and the goal counts, which nobody is watching change minute
 * by minute, so it yields to anything with a match in it.
 */
function rank(job: PlannedSync): number {
  if (job.kind === 'structure' && job.temperature !== 'cold') return 3;
  return { hot: 0, warm: 1, cold: 2 }[job.temperature];
}

/**
 * Decide what a single tick should do.
 *
 * Anything not yet due is dropped, the rest is sorted by urgency then staleness, and the
 * list is cut at the request budget. Sorting by staleness rather than, say, tournament age
 * is what stops one busy competition from starving another.
 */
export function planTick(
  tournaments: SchedulableTournament[],
  budget: number,
  now: Date = new Date(),
): PlannedSync[] {
  const candidates = tournaments.flatMap(t => candidatesFor(t, now));

  candidates.sort((a, b) =>
    rank(a) !== rank(b) ? rank(a) - rank(b) : b.staleness - a.staleness,
  );

  const planned: PlannedSync[] = [];
  let spent = 0;
  for (const c of candidates) {
    if (spent + c.cost > budget) continue;
    planned.push(c);
    spent += c.cost;
  }
  return planned;
}

/**
 * Whether this finished job should be followed by a scorer refresh.
 *
 * Goal counts used to ride along with the structure sync alone, which is planned once its
 * last one is six hours old and is ranked *below* every job with a match in it — so on a
 * busy weekend the top-scorer tab could sit half a day behind a scoreline the same page
 * was updating every minute.
 *
 * Polling harder would be the obvious fix and the wrong one: goals cannot move except by
 * being scored, so the full-time whistle is the signal, and asking at any other moment
 * spends a request from a ten-a-minute budget to be told nothing changed. A structure job
 * is excluded because it has already refreshed the goals itself, and a season the provider
 * has not published has nothing to refresh from.
 */
export function shouldRefreshScorers(
  kind: PlannedSync['kind'],
  result: Pick<SyncResult, 'newlyFinishedFixtureIds' | 'seasonUnavailable'>,
): boolean {
  if (kind === 'structure' || result.seasonUnavailable) return false;
  return result.newlyFinishedFixtureIds.length > 0;
}

/**
 * When this tournament is next due a sync, for the admin page.
 *
 * Never in the past: a tournament that is due now reads as "now" rather than as a
 * negative countdown, since the tick that will pick it up is at most one interval away.
 */
export function nextSyncDueAt(t: SchedulableTournament, now: Date = new Date()): Date {
  const temperature = classifyTournament(t, now);
  const dues: number[] = [];

  const interval = windowInterval(temperature);
  if (interval !== null) dues.push((t.lastFixtureSyncAt?.getTime() ?? 0) + interval);
  dues.push(
    (t.lastStructureSyncAt?.getTime() ?? 0) +
      (temperature === 'cold' ? COLD_INTERVAL : STRUCTURE_MAX_AGE),
  );

  return new Date(Math.max(Math.min(...dues), now.getTime()));
}

// ── Database-backed tick ──────────────────────────────────────────────────────

interface SchedulableRow extends SchedulableTournament {
  name: string;
  status: string;
  syncEnabled: boolean;
  lastSyncError: string | null;
}

async function loadSchedulableTournaments(includePaused = false): Promise<SchedulableRow[]> {
  const rows = await db
    .select({
      id: liveTournaments.id,
      name: liveTournaments.name,
      status: liveTournaments.status,
      syncEnabled: liveTournaments.syncEnabled,
      lastSyncError: liveTournaments.lastSyncError,
      lastStructureSyncAt: liveTournaments.lastStructureSyncAt,
      lastFixtureSyncAt: liveTournaments.lastFixtureSyncAt,
    })
    .from(liveTournaments)
    .where(
      includePaused
        ? ne(liveTournaments.status, 'completed')
        : and(eq(liveTournaments.syncEnabled, true), ne(liveTournaments.status, 'completed')),
    );
  if (rows.length === 0) return [];

  const out: SchedulableRow[] = [];
  for (const row of rows) {
    const [next] = await db
      .select({ kickoffAt: liveFixtures.kickoffAt })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, row.id),
          ne(liveFixtures.status, 'finished'),
          ne(liveFixtures.status, 'cancelled'),
          sql`${liveFixtures.kickoffAt} IS NOT NULL`,
        ),
      )
      .orderBy(liveFixtures.kickoffAt)
      .limit(1);

    const [live] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, row.id),
          sql`${liveFixtures.status} IN ('in_play', 'paused')`,
        ),
      );

    out.push({
      id: row.id,
      name: row.name,
      status: row.status,
      syncEnabled: row.syncEnabled,
      lastSyncError: row.lastSyncError,
      lastStructureSyncAt: row.lastStructureSyncAt,
      lastFixtureSyncAt: row.lastFixtureSyncAt,
      nextKickoffAt: next?.kickoffAt ?? null,
      hasLiveFixture: (live?.count ?? 0) > 0,
    });
  }
  return out;
}

/**
 * Move a tournament out of `upcoming` once its first match has started.
 *
 * The other direction — into `completed` — stays an admin decision on purpose: it is what
 * reveals the bonus answers and the top-scorer ranking, and only a person knows the goal
 * counts are final.
 */
export async function advanceTournamentStatus(tournamentId: string): Promise<boolean> {
  const [started] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(liveFixtures)
    .where(
      and(
        eq(liveFixtures.liveTournamentId, tournamentId),
        sql`${liveFixtures.status} IN ('in_play', 'paused', 'finished')`,
      ),
    );
  if ((started?.count ?? 0) === 0) return false;

  const updated = await db
    .update(liveTournaments)
    .set({ status: 'active' })
    .where(and(eq(liveTournaments.id, tournamentId), eq(liveTournaments.status, 'upcoming')))
    .returning({ id: liveTournaments.id });
  return updated.length > 0;
}

// ── Observable state, for the admin page ──────────────────────────────────────

let startedAt: Date | null = null;
let lastTickAt: Date | null = null;
let lastTickPlanned = 0;
let lastTickError: string | null = null;

export interface LiveSyncTournamentStatus {
  id: string;
  name: string;
  status: string;
  temperature: SyncTemperature;
  lastStructureSyncAt: string | null;
  lastFixtureSyncAt: string | null;
  lastSyncError: string | null;
  nextKickoffAt: string | null;
  /** Null when this tournament is paused — nothing is due for it. */
  nextSyncDueAt: string | null;
  syncEnabled: boolean;
}

export interface LiveSyncStatus {
  /** Whether the tick actually syncs, override applied. */
  enabled: boolean;
  /** Why, so an admin can tell "nobody turned it on" from "no API key". */
  reason: SyncEnabledReason;
  /** The admin override, or null when the environment decides. */
  override: boolean | null;
  /** Whether the interval is installed. False only when the environment hard-disables it. */
  running: boolean;
  tickSeconds: number;
  tickBudget: number;
  startedAt: string | null;
  lastTickAt: string | null;
  lastTickPlanned: number;
  lastTickError: string | null;
  tournaments: LiveSyncTournamentStatus[];
}

/** Everything the admin page needs to answer "is this updating itself?". */
export async function getLiveSyncStatus(): Promise<LiveSyncStatus> {
  const decision = resolveSyncEnabled(await readSyncOverride());
  const now = new Date();
  const rows = await loadSchedulableTournaments(true);

  return {
    enabled: decision.enabled,
    reason: decision.reason,
    override: decision.override,
    running: timer !== null,
    tickSeconds: tickSeconds(),
    tickBudget: tickBudget(),
    startedAt: startedAt?.toISOString() ?? null,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    lastTickPlanned,
    lastTickError,
    tournaments: rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      temperature: classifyTournament(row, now),
      lastStructureSyncAt: row.lastStructureSyncAt?.toISOString() ?? null,
      lastFixtureSyncAt: row.lastFixtureSyncAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      nextKickoffAt: row.nextKickoffAt?.toISOString() ?? null,
      syncEnabled: row.syncEnabled,
      nextSyncDueAt:
        row.syncEnabled && decision.enabled ? nextSyncDueAt(row, now).toISOString() : null,
    })),
  };
}

function tickSeconds(): number {
  return Number(process.env.LIVE_SYNC_TICK_SECONDS) || DEFAULT_TICK_SECONDS;
}

function tickBudget(): number {
  return Number(process.env.LIVE_SYNC_TICK_BUDGET) || DEFAULT_TICK_BUDGET;
}

/**
 * Run one scheduling pass.
 *
 * Exported so it can be triggered by hand; the interval is the normal caller. Returns the
 * syncs it actually performed, which is what the tests and the boot log care about.
 */
export async function tick(): Promise<PlannedSync[]> {
  if (tickInProgress) return [];
  tickInProgress = true;

  try {
    // Read every tick rather than at boot, so an admin turning the sync on from the admin
    // page takes effect within one interval instead of at the next deploy.
    if (!resolveSyncEnabled(await readSyncOverride()).enabled) return [];

    // Cheap insurance against a second replica: whoever holds the lock does the work,
    // everyone else returns immediately. Released in the finally below.
    const [lock] = await db.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`,
    );
    if (!lock?.locked) return [];

    try {
      const tournaments = await loadSchedulableTournaments();
      const planned = planTick(tournaments, tickBudget());
      lastTickAt = new Date();
      lastTickPlanned = planned.length;
      lastTickError = null;

      for (const job of planned) {
        try {
          const result =
            job.kind === 'structure'
              ? await syncTournamentStructure(job.tournamentId)
              : await syncLiveWindow(job.tournamentId);

          if (result.seasonUnavailable) {
            console.log(
              `[live-sync] ${job.tournamentId} (${job.temperature}): season not published yet`,
            );
          } else {
            console.log(
              `[live-sync] ${job.tournamentId} (${job.temperature}/${job.kind}): ` +
                `${result.fixtures} fixtures, ${result.teams} teams, ${result.standings} standings` +
                (result.newlyFinishedFixtureIds.length
                  ? `, ${result.newlyFinishedFixtureIds.length} newly finished`
                  : ''),
            );
          }

          if (await advanceTournamentStatus(job.tournamentId)) {
            console.log(`[live-sync] ${job.tournamentId}: first match under way, now active`);
          }

          // Score whatever just finished and push SSE to anyone watching. Kept out of
          // the sync itself so syncing stays a pure data concern.
          const scored = await applySyncResult({
            liveTournamentId: job.tournamentId,
            newlyFinishedFixtureIds: result.newlyFinishedFixtureIds,
            changedFixtureIds: result.changedFixtureIds,
          });
          if (scored.scoredPredictions > 0) {
            console.log(
              `[live-sync] ${job.tournamentId}: scored ${scored.scoredPredictions} prediction(s) ` +
                `across ${scored.affectedCompetitionIds.length} competition(s)`,
            );
          }

          // A fixture just reached full time, so somebody's tally may have moved.
          //
          // One request, deliberately outside the tick budget — planTick() would have to
          // predict a full-time whistle before the sync that discovers it. The worst case
          // is one extra request per planned job, i.e. every tournament in a tick finishing
          // a fixture in the same 30 seconds; uncapped on purpose, because a cap would defer
          // those goals to the six-hourly structure sync, and the transition that would have
          // asked for them fires exactly once. The overspend degrades into a 429 that
          // syncLiveScorers swallows, which the next whistle or that backstop then corrects.
          const scorersMoved = shouldRefreshScorers(job.kind, result)
            ? await syncLiveScorers(job.tournamentId)
            : result.scorersSynced;

          if (scorersMoved > 0) {
            // Re-score and push. Before the tournament is completed this awards nothing —
            // it moves the ranking users are watching, which is its own SSE event.
            await applyScorerRefresh(job.tournamentId);
            console.log(`[live-sync] ${job.tournamentId}: ${scorersMoved} player tally(s) updated`);
          }
        } catch (err) {
          // One tournament failing must not stop the others. The message is already
          // recorded on live_tournaments.last_sync_error by the sync itself.
          console.warn(
            `[live-sync] ${job.tournamentId} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      return planned;
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  } catch (err) {
    lastTickError = err instanceof Error ? err.message : String(err);
    console.warn('[live-sync] tick failed:', lastTickError);
    return [];
  } finally {
    tickInProgress = false;
  }
}

/**
 * Start the interval.
 *
 * The timer is installed unless the environment hard-disables the sync, because the
 * on/off decision is re-read inside every tick — that is what lets an admin turn the sync
 * on from the admin page without a redeploy. A tick with the sync off costs one indexed
 * lookup and does nothing else.
 */
export function startLiveScheduler(): void {
  if (timer) return;

  const fromEnv = resolveSyncEnabledFromEnv();
  if (!fromEnv.enabled && fromEnv.reason === 'env-off') {
    console.log('[live-sync] disabled by LIVE_SYNC_ENABLED=false');
    return;
  }

  const seconds = tickSeconds();
  timer = setInterval(() => {
    void tick();
  }, seconds * 1000);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();
  startedAt = new Date();

  console.log(
    fromEnv.enabled
      ? `[live-sync] scheduler started, ticking every ${seconds}s (${fromEnv.reason})`
      : `[live-sync] scheduler idle (${fromEnv.reason}) — turn it on from the admin page ` +
          'or set LIVE_SYNC_ENABLED=true',
  );
}

export function stopLiveScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    startedAt = null;
  }
}
