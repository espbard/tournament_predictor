import type { LiveTeam } from '@tournament-predictor/shared';

// ── Table prediction ordering ─────────────────────────────────────────────────
//
// The two pure pieces of the table-prediction UI, kept out of the component so they can
// be reasoned about — and checked — without mounting React.

/** Move an item within an array, returning a new array. Out-of-range moves are no-ops. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The order to show when the user has not saved one.
 *
 * Prefers the live standings, so the starting point is meaningful rather than arbitrary,
 * then appends anything missing in name order — which before a ball is kicked is every
 * team, since there are no standings yet.
 *
 * A saved order is used as-is, but only after being reconciled against the current team
 * list: teams can be added or removed between saving and reading, and the result must
 * always be a complete permutation or the server will reject it on the next save.
 */
export function initialOrder(
  savedOrder: string[] | null,
  currentOrder: string[],
  teams: LiveTeam[],
): string[] {
  const valid = new Set(teams.map(t => t.id));
  const byName = (a: LiveTeam, b: LiveTeam) => a.name.localeCompare(b.name);

  if (savedOrder?.length) {
    const kept = savedOrder.filter(id => valid.has(id));
    const keptSet = new Set(kept);
    const missing = teams
      .filter(t => !keptSet.has(t.id))
      .sort(byName)
      .map(t => t.id);
    return [...kept, ...missing];
  }

  const seeded = currentOrder.filter(id => valid.has(id));
  const seededSet = new Set(seeded);
  const rest = teams
    .filter(t => !seededSet.has(t.id))
    .sort(byName)
    .map(t => t.id);
  return [...seeded, ...rest];
}
