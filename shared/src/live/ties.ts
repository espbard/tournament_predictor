import type { LiveFormatDef, LiveStageDef } from './formats';

// ── Two-legged ties: who goes through ─────────────────────────────────────────
//
// The second leg of a two-legged knockout tie awards one extra point, on top of the usual
// tiers, for the right team going through. Which team a prediction sends through:
//
//   * the first leg's actual result plus the predicted second-leg score, added up; the
//     team ahead on that total goes through;
//   * if that total is level, the team the member picked. Without a pick, nobody — and so
//     no point.
//
// Before the first leg has been played nobody can know whether their score will leave the
// tie level, so the pick is offered all along, worded "if level on aggregate", and only
// ever consulted when the total turns out level.
//
// Which team actually went through: both legs' 90-minute goals, plus any extra-time goals
// in the second leg; if still level, the penalty shootout. Only the advancing team is taken
// from extra time and penalties — the tiers stay on the 90-minute score as everywhere else.
// An admin can set it by hand where the provider cannot say (`overrideTeamId`), and that
// wins.
//
// Only the second leg of a two-legged knockout stage takes part. First legs and the final
// score exactly as any other match.
//
// Pure, and the one place this is decided: the server scores with it, the client words its
// prompt with it.

/** Whether a stage's second legs award the team-through point. */
export function isAdvanceStage(stage: Pick<LiveStageDef, 'kind' | 'legs'> | null | undefined): boolean {
  return !!stage && stage.kind === 'knockout' && stage.legs === 2;
}

/** The fields of a stored fixture this module reads. */
export interface TieLegFixture {
  id: string;
  stageKey: string | null;
  tieKey: string | null;
  legNumber: number | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  status: string;
  normalTimeHome: number | null;
  normalTimeAway: number | null;
  extraTimeHome?: number | null;
  extraTimeAway?: number | null;
  penaltiesHome?: number | null;
  penaltiesAway?: number | null;
  /** The provider's match winner, 'HOME_TEAM' / 'AWAY_TEAM' / 'DRAW'. */
  winner?: string | null;
  /** Set by an admin when the provider cannot say who went through. */
  advancingTeamOverride?: string | null;
}

/** A score from the second leg's point of view: its home team first. */
export interface CarriedScore {
  home: number;
  away: number;
}

/**
 * The first leg's result, as goals for the second leg's home and away team.
 *
 * The teams normally swap ends between legs, so a first-leg 2-0 home win shows above the
 * second leg as (0-2). Matched by team, not by position, so it is right whichever way
 * round the provider lists them. Null until the first leg has a 90-minute result.
 */
export function carriedScore(firstLeg: TieLegFixture | null, secondLeg: TieLegFixture): CarriedScore | null {
  if (!firstLeg || firstLeg.normalTimeHome === null || firstLeg.normalTimeAway === null) return null;
  if (firstLeg.status !== 'finished') return null;
  const goalsFor = (teamId: string | null): number | null => {
    if (teamId === null) return null;
    if (teamId === firstLeg.homeTeamId) return firstLeg.normalTimeHome;
    if (teamId === firstLeg.awayTeamId) return firstLeg.normalTimeAway;
    return null;
  };
  const home = goalsFor(secondLeg.homeTeamId);
  const away = goalsFor(secondLeg.awayTeamId);
  if (home === null || away === null) return null;
  return { home, away };
}

/**
 * The team a prediction sends through, or null when it sends nobody: the first leg is
 * not known yet, or the total is level and no team was picked.
 */
export function predictedAdvancer(opts: {
  carried: CarriedScore | null;
  homeScore: number;
  awayScore: number;
  homeTeamId: string | null;
  awayTeamId: string | null;
  pickedTeamId: string | null;
}): string | null {
  if (!opts.carried || !opts.homeTeamId || !opts.awayTeamId) return null;
  const home = opts.carried.home + opts.homeScore;
  const away = opts.carried.away + opts.awayScore;
  if (home > away) return opts.homeTeamId;
  if (away > home) return opts.awayTeamId;
  return opts.pickedTeamId === opts.homeTeamId || opts.pickedTeamId === opts.awayTeamId
    ? opts.pickedTeamId
    : null;
}

/**
 * Whether the prediction needs a pick to send anybody through: the total is level, or the
 * first leg has not been played so it might yet be.
 */
export function advancePickApplies(carried: CarriedScore | null, homeScore: number | null, awayScore: number | null): boolean {
  if (!carried) return true;
  if (homeScore === null || awayScore === null) return false;
  return carried.home + homeScore === carried.away + awayScore;
}

/**
 * The team that actually went through, or null while that is not known: the second leg
 * has not finished, the first leg has no result, or the score data cannot settle it.
 */
export function actualAdvancer(firstLeg: TieLegFixture | null, secondLeg: TieLegFixture): string | null {
  if (secondLeg.advancingTeamOverride) return secondLeg.advancingTeamOverride;
  if (secondLeg.status !== 'finished') return null;
  if (secondLeg.normalTimeHome === null || secondLeg.normalTimeAway === null) return null;
  const carried = carriedScore(firstLeg, secondLeg);
  if (!carried || !secondLeg.homeTeamId || !secondLeg.awayTeamId) return null;

  const home = carried.home + secondLeg.normalTimeHome + (secondLeg.extraTimeHome ?? 0);
  const away = carried.away + secondLeg.normalTimeAway + (secondLeg.extraTimeAway ?? 0);
  if (home > away) return secondLeg.homeTeamId;
  if (away > home) return secondLeg.awayTeamId;

  // Level after extra time: the shootout decides.
  const penHome = secondLeg.penaltiesHome;
  const penAway = secondLeg.penaltiesAway;
  if (penHome != null && penAway != null && penHome !== penAway) {
    return penHome > penAway ? secondLeg.homeTeamId : secondLeg.awayTeamId;
  }
  // A level aggregate only ends by shootout, and on a shootout the provider's match winner
  // is its winner — the one case where that field is the tie's winner too.
  if (secondLeg.winner === 'HOME_TEAM') return secondLeg.homeTeamId;
  if (secondLeg.winner === 'AWAY_TEAM') return secondLeg.awayTeamId;
  return null;
}

/** What scoring and display need about one second leg. */
export interface SecondLegContext {
  firstLegId: string | null;
  carried: CarriedScore | null;
  actualAdvancerId: string | null;
}

/**
 * Index every eligible second leg among `fixtures` by id, with its first leg found by
 * tie key. A second leg whose first leg is missing is still listed, with nothing carried.
 */
export function indexSecondLegs(format: LiveFormatDef, fixtures: TieLegFixture[]): Map<string, SecondLegContext> {
  const firstLegs = new Map<string, TieLegFixture>();
  for (const f of fixtures) {
    if (f.tieKey && f.legNumber === 1) firstLegs.set(f.tieKey, f);
  }
  const out = new Map<string, SecondLegContext>();
  for (const f of fixtures) {
    if (f.legNumber !== 2 || !f.tieKey) continue;
    const stage = format.stages.find(s => s.key === f.stageKey);
    if (!isAdvanceStage(stage)) continue;
    const first = firstLegs.get(f.tieKey) ?? null;
    out.set(f.id, {
      firstLegId: first?.id ?? null,
      carried: carriedScore(first, f),
      actualAdvancerId: actualAdvancer(first, f),
    });
  }
  return out;
}
