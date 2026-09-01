// ── Live feature gating ───────────────────────────────────────────────────────
//
// Where a live feature is still being tried out, the rule for who can see it lives here
// rather than in each of the places that has to ask. Removing a flag is then one edit
// plus whatever the compiler points at, instead of a hunt through routes and components.

/** The parts of a signed-in user a feature gate is allowed to look at. */
export interface LiveFeatureViewer {
  isAdmin: boolean;
  isTestAccount: boolean;
}

/**
 * Whether the top-scorer ranking is visible to this user.
 *
 * A test feature for now: accounts marked as test users see it, and admins do too, since
 * an admin has to be able to build the shortlist and check what a player will get.
 * Everyone else gets a competition with no ranking at all — no tab, no first-run gate, and
 * a server that refuses to hand one over, so the feature cannot be reached through the API
 * either.
 *
 * To ship it to everyone, make this return true and delete the callers' `user` arguments.
 */
export function canSeeLiveScorerRanking(user: LiveFeatureViewer | null | undefined): boolean {
  return !!user && (user.isAdmin || user.isTestAccount);
}
