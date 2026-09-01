// ── Ranking prediction ordering ───────────────────────────────────────────────
//
// The two pure pieces of a ranking UI, kept out of the component so they can be reasoned
// about — and checked — without mounting React. Shared by the league-table prediction and
// the top-scorer ranking, which order different things but order them identically.

/** Anything a user drags into an order: a team, a player. */
export interface OrderableItem {
  id: string;
  name: string;
}

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
 * Prefers the current real order — the live standings, or the ranking as the goals stand
 * today — so the starting point is meaningful rather than arbitrary, then appends anything
 * missing in name order, which before a ball is kicked is everything.
 *
 * A saved order is used as-is, but only after being reconciled against the current list:
 * items can be added or removed between saving and reading — a team withdrawn, a player
 * added to the shortlist — and the result must always be a complete permutation or the
 * server will reject it on the next save.
 */
export function initialOrder(
  savedOrder: string[] | null,
  currentOrder: string[],
  items: OrderableItem[],
): string[] {
  const valid = new Set(items.map(t => t.id));
  const byName = (a: OrderableItem, b: OrderableItem) => a.name.localeCompare(b.name);

  if (savedOrder?.length) {
    const kept = savedOrder.filter(id => valid.has(id));
    const keptSet = new Set(kept);
    const missing = items
      .filter(t => !keptSet.has(t.id))
      .sort(byName)
      .map(t => t.id);
    return [...kept, ...missing];
  }

  const seeded = currentOrder.filter(id => valid.has(id));
  const seededSet = new Set(seeded);
  const rest = items
    .filter(t => !seededSet.has(t.id))
    .sort(byName)
    .map(t => t.id);
  return [...seeded, ...rest];
}
