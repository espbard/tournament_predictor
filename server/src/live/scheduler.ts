import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { liveFixtures, liveTournaments } from '../db/liveSchema';
import { syncLiveWindow, syncTournamentStructure } from './sync';

// ── Sync scheduler ────────────────────────────────────────────────────────────
//
// There is no cron, queue or worker in this project and it deploys as a single Railway
// service, so the sync runs on an in-process interval started from start() in
// server/src/index.ts.
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

/** Roughly the cost of each sync in provider requests. */
const STRUCTURE_REQUEST_COST = 3;
const WINDOW_REQUEST_COST = 1;

export type SyncTemperature = 'hot' | 'warm' | 'cold';

let tickInProgress = false;
let timer: NodeJS.Timeout | null = null;

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

export interface PlannedSync {
  tournamentId: string;
  temperature: SyncTemperature;
  kind: 'structure' | 'window';
  /** Milliseconds since the relevant sync last ran. Higher is more urgent. */
  staleness: number;
  cost: number;
}

/**
 * Decide what a single tick should do.
 *
 * Anything not yet due is dropped, the rest is sorted by staleness, and the list is cut
 * at the request budget. Sorting by staleness rather than, say, tournament age is what
 * stops one busy competition from starving another.
 */
export function planTick(
  tournaments: SchedulableTournament[],
  budget: number,
  now: Date = new Date(),
): PlannedSync[] {
  const candidates: PlannedSync[] = [];

  for (const t of tournaments) {
    const temperature = classifyTournament(t, now);
    const kind = temperature === 'cold' ? 'structure' : 'window';
    const last = kind === 'structure' ? t.lastStructureSyncAt : t.lastFixtureSyncAt;
    const staleness = now.getTime() - (last?.getTime() ?? 0);

    const due =
      temperature === 'hot'
        ? staleness >= HOT_INTERVAL
        : temperature === 'warm'
          ? staleness >= WARM_INTERVAL
          : staleness >= COLD_INTERVAL;
    if (!due) continue;

    candidates.push({
      tournamentId: t.id,
      temperature,
      kind,
      staleness,
      cost: kind === 'structure' ? STRUCTURE_REQUEST_COST : WINDOW_REQUEST_COST,
    });
  }

  const order: Record<SyncTemperature, number> = { hot: 0, warm: 1, cold: 2 };
  candidates.sort((a, b) =>
    order[a.temperature] !== order[b.temperature]
      ? order[a.temperature] - order[b.temperature]
      : b.staleness - a.staleness,
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

// ── Database-backed tick ──────────────────────────────────────────────────────

async function loadSchedulableTournaments(): Promise<SchedulableTournament[]> {
  const rows = await db
    .select({
      id: liveTournaments.id,
      lastStructureSyncAt: liveTournaments.lastStructureSyncAt,
      lastFixtureSyncAt: liveTournaments.lastFixtureSyncAt,
    })
    .from(liveTournaments)
    .where(
      and(eq(liveTournaments.syncEnabled, true), ne(liveTournaments.status, 'completed')),
    );
  if (rows.length === 0) return [];

  const out: SchedulableTournament[] = [];
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
      lastStructureSyncAt: row.lastStructureSyncAt,
      lastFixtureSyncAt: row.lastFixtureSyncAt,
      nextKickoffAt: next?.kickoffAt ?? null,
      hasLiveFixture: (live?.count ?? 0) > 0,
    });
  }
  return out;
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
    // Cheap insurance against a second replica: whoever holds the lock does the work,
    // everyone else returns immediately. Released in the finally below.
    const [lock] = await db.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`,
    );
    if (!lock?.locked) return [];

    try {
      const tournaments = await loadSchedulableTournaments();
      const budget = Number(process.env.LIVE_SYNC_TICK_BUDGET) || DEFAULT_TICK_BUDGET;
      const planned = planTick(tournaments, budget);

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

          // Phase 4 hooks in here: score result.newlyFinishedFixtureIds, then push SSE
          // for those plus result.changedFixtureIds.
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
    console.warn('[live-sync] tick failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    tickInProgress = false;
  }
}

/**
 * Start the interval. A no-op unless LIVE_SYNC_ENABLED is 'true', so the sync stays off
 * by default and a local dev server does not quietly burn the shared request budget.
 */
export function startLiveScheduler(): void {
  if (process.env.LIVE_SYNC_ENABLED !== 'true') {
    console.log('[live-sync] disabled (set LIVE_SYNC_ENABLED=true to enable)');
    return;
  }
  if (timer) return;

  const seconds = Number(process.env.LIVE_SYNC_TICK_SECONDS) || DEFAULT_TICK_SECONDS;
  timer = setInterval(() => {
    void tick();
  }, seconds * 1000);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();

  console.log(`[live-sync] scheduler started, ticking every ${seconds}s`);
}

export function stopLiveScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
