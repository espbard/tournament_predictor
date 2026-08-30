// ── Deriving a matchday from the calendar ─────────────────────────────────────
//
// A matchday is not decoration here. It *is* the gameweek: `live_gameweek_selections`
// is keyed by (stage, matchday), the admin's selected-matches panel only shows fixtures
// that have one, and the fixtures tab pages through a table stage by matchday. A fixture
// with a null matchday sits outside all of that — permanently selected, invisible to the
// admin panel, and dumped onto one page with all 143 of its neighbours.
//
// football-data reports a matchday on every fixture. bigballsdata does not report one at
// all, so it is derived here from the one thing its payload does carry: kickoff times.
//
// That works because European club competitions are not played continuously. A Champions
// League league-phase round runs across a Tuesday and a Wednesday and the next is a
// fortnight later, so the fixtures fall into obvious clusters with large gaps between
// them. Clustering by those gaps recovers exactly the round numbering UEFA publishes.
//
// Everything here is pure and pinned in matchdays.test.ts.

/** A day in milliseconds. */
const DAY = 24 * 60 * 60 * 1000;

/**
 * A new round starts when a fixture is more than this long after the previous one.
 *
 * Four days separates "the Thursday of this round" from "the Tuesday of the next" while
 * comfortably holding a round that spreads over Tuesday, Wednesday and Thursday.
 */
const DEFAULT_GAP_DAYS = 4;

/**
 * ...and no round may span more than this, however tight the gaps.
 *
 * Without it a competition playing every three days would chain into one endless round.
 * With both guards a round ends at the first real break or after a week, whichever comes
 * first.
 */
const DEFAULT_MAX_SPAN_DAYS = 6;

export interface MatchdayAssignable {
  providerFixtureId: string;
  stageKey: string | null;
  /** What the provider said, if anything. A number here is always kept. */
  matchday: number | null;
  kickoffAt: Date | null;
}

export interface DeriveMatchdayOptions {
  gapDays?: number;
  maxSpanDays?: number;
}

/**
 * Work out a matchday for every fixture that has none.
 *
 * Returns the matchday to store per fixture, including the ones that already had one —
 * so a caller can use the result unconditionally.
 *
 * Two deliberate refusals:
 *
 *   * A stage where the provider reported *any* matchday is left entirely alone. Mixing
 *     reported and derived numbering within one stage would produce two fixtures
 *     labelled "matchday 3" that are not in the same round, which is worse than either
 *     scheme on its own.
 *   * A fixture with no kickoff time gets null. There is nothing to cluster it by, and
 *     guessing would put a match in a gameweek it may not belong to.
 *
 * Note the consequence of deriving rather than being told: the numbering follows the
 * calendar, so if the provider later moves a fixture across a gap it can land in a
 * different gameweek than it did before. That is visible (the admin's selected-matches
 * panel regroups) and only affects a gameweek an admin had narrowed by hand.
 */
export function deriveMatchdays<T extends MatchdayAssignable>(
  fixtures: T[],
  opts: DeriveMatchdayOptions = {},
): Map<string, number | null> {
  const gapMs = (opts.gapDays ?? DEFAULT_GAP_DAYS) * DAY;
  const maxSpanMs = (opts.maxSpanDays ?? DEFAULT_MAX_SPAN_DAYS) * DAY;

  const out = new Map<string, number | null>();
  const byStage = new Map<string, T[]>();

  for (const fixture of fixtures) {
    // Start from what the provider said, so anything not derived below keeps its value.
    out.set(fixture.providerFixtureId, fixture.matchday);

    // A fixture outside any stage is outside any gameweek too.
    if (!fixture.stageKey) continue;

    const bucket = byStage.get(fixture.stageKey);
    if (bucket) bucket.push(fixture);
    else byStage.set(fixture.stageKey, [fixture]);
  }

  for (const stageFixtures of byStage.values()) {
    if (stageFixtures.some(f => f.matchday != null)) continue;

    const dated = stageFixtures
      .filter(f => f.kickoffAt !== null)
      .sort(
        (a, b) =>
          a.kickoffAt!.getTime() - b.kickoffAt!.getTime() ||
          a.providerFixtureId.localeCompare(b.providerFixtureId),
      );

    let matchday = 0;
    let previous: number | null = null;
    let clusterStart = 0;

    for (const fixture of dated) {
      const at = fixture.kickoffAt!.getTime();
      const startsRound =
        previous === null || at - previous > gapMs || at - clusterStart > maxSpanMs;

      if (startsRound) {
        matchday += 1;
        clusterStart = at;
      }
      previous = at;
      out.set(fixture.providerFixtureId, matchday);
    }
  }

  return out;
}
