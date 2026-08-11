import type { LiveFixtureStatus } from './types';

// ── Per-fixture prediction deadline ───────────────────────────────────────────
//
// The defining rule of the live tournament type: a prediction can be created or changed
// right up until one hour before that fixture's kickoff, and nothing else ever locks a
// user out. There is deliberately no competition-wide deadline.
//
// This module is the single source of truth for that rule. Both the server (enforcement)
// and the client (disabled inputs, countdown) call it, so the two cannot drift.

export const LIVE_LOCK_MINUTES = 60;

const MS_PER_MINUTE = 60_000;

export interface LockableFixture {
  kickoffAt: string | Date | null;
  status: LiveFixtureStatus;
}

function toDate(value: string | Date | null): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The instant a fixture's predictions close, or null when the kickoff time is still
 * unknown. Knockout fixtures routinely exist before a draw has set a date.
 */
export function fixtureLockAt(kickoffAt: string | Date | null): Date | null {
  const kickoff = toDate(kickoffAt);
  if (!kickoff) return null;
  return new Date(kickoff.getTime() - LIVE_LOCK_MINUTES * MS_PER_MINUTE);
}

export function isFixtureLocked(fixture: LockableFixture, now: Date = new Date()): boolean {
  // Anything that has started, finished, or been called off is closed regardless of clock.
  if (fixture.status !== 'scheduled' && fixture.status !== 'postponed') return true;

  const kickoff = toDate(fixture.kickoffAt);
  const lockAt = fixtureLockAt(fixture.kickoffAt);

  // Kickoff still to be announced — stays open. It will lock once a date arrives.
  if (!kickoff || !lockAt) return false;

  // A postponed fixture keeps its old kickoff until the provider publishes the new one.
  // That stale date must not lock the fixture: the match has not been played.
  if (fixture.status === 'postponed' && kickoff.getTime() <= now.getTime()) return false;

  return now.getTime() >= lockAt.getTime();
}

/**
 * Whole minutes until a fixture locks. Null when the kickoff time is unknown,
 * zero once the deadline has passed. For the countdown UI.
 */
export function minutesUntilLock(
  fixture: LockableFixture,
  now: Date = new Date(),
): number | null {
  const lockAt = fixtureLockAt(fixture.kickoffAt);
  if (!lockAt) return null;
  if (isFixtureLocked(fixture, now)) return 0;
  return Math.max(0, Math.ceil((lockAt.getTime() - now.getTime()) / MS_PER_MINUTE));
}
