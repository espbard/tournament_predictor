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

// ── Table predictions ─────────────────────────────────────────────────────────

/**
 * When a table prediction closes: the same hour before kickoff, but measured from the
 * *first* fixture of the stage.
 *
 * Predicting the final order only makes sense before any of it has been played, so the
 * deadline is the first match rather than the last. Null when no fixture in the stage has
 * a date yet — which is the normal state for a competition created before its draw, and
 * leaves the prediction open.
 */
export function tablePredictionLockAt(
  fixtureKickoffs: Array<string | Date | null>,
): Date | null {
  const times = fixtureKickoffs
    .map(toDate)
    .filter((d): d is Date => d !== null)
    .map(d => d.getTime());
  if (times.length === 0) return null;
  return fixtureLockAt(new Date(Math.min(...times)));
}

/**
 * Whether the shared deadline has passed. This is the competition-wide clock, not the
 * answer for one member: whether a given member may still submit goes through
 * `seasonPredictionLock` below, which lets somebody who never entered a table in late.
 */
export function isTablePredictionLocked(
  fixtureKickoffs: Array<string | Date | null>,
  now: Date = new Date(),
): boolean {
  const lockAt = tablePredictionLockAt(fixtureKickoffs);
  if (!lockAt) return false;
  return now.getTime() >= lockAt.getTime();
}

// ── Season-long predictions: the table and the top-scorer ranking ─────────────

export interface SeasonPredictionLock {
  /** The competition-wide deadline, or null while no fixture of the stage has a date. */
  lockedAt: Date | null;
  /** Whether this member may still submit or change their prediction. */
  isLocked: boolean;
  /**
   * The deadline has passed and the only thing keeping this member's prediction open is
   * that they never made one. Their next save is their last.
   */
  isLateEntry: boolean;
}

/**
 * Whether one member's season-long prediction is closed to them.
 *
 * The deadline is the first kickoff for everybody, but it only bites on a prediction that
 * exists. Somebody who never submitted a table has nothing that hindsight could improve,
 * and locking them out would strand them behind the first-run gate of a league they had
 * already joined — with no way in and no way to play. So the door stays open until they
 * submit, and what they submit is final the moment it lands: a late entrant gets one
 * shot, not an editable prediction.
 *
 * The same rule governs the top-scorer ranking, which shares this deadline.
 */
export function seasonPredictionLock(
  fixtureKickoffs: Array<string | Date | null>,
  hasPrediction: boolean,
  now: Date = new Date(),
): SeasonPredictionLock {
  const deadlinePassed = isTablePredictionLocked(fixtureKickoffs, now);
  return {
    lockedAt: tablePredictionLockAt(fixtureKickoffs),
    isLocked: deadlinePassed && hasPrediction,
    isLateEntry: deadlinePassed && !hasPrediction,
  };
}

// ── Bonus questions ───────────────────────────────────────────────────────────

/**
 * When a bonus question closes.
 *
 * A live competition has no competition-wide deadline, so a season-long side bet needs one
 * of its own. The default is the same instant the table prediction locks — one hour before
 * the first match of the tournament's predictable stage — because both are predictions
 * about how a season turns out, and neither means much once it is under way.
 *
 * An admin can override it per question with `lockAt`, which is what makes a question added
 * mid-season answerable at all. Null on both sides leaves the question open: no fixture has
 * a date yet, so nothing has started.
 */
export function bonusQuestionLockAt(
  lockAt: string | Date | null,
  stageKickoffs: Array<string | Date | null>,
): Date | null {
  const own = toDate(lockAt);
  if (own) return own;
  return tablePredictionLockAt(stageKickoffs);
}

export function isBonusQuestionLocked(
  lockAt: string | Date | null,
  stageKickoffs: Array<string | Date | null>,
  now: Date = new Date(),
): boolean {
  const deadline = bonusQuestionLockAt(lockAt, stageKickoffs);
  if (!deadline) return false;
  return now.getTime() >= deadline.getTime();
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
