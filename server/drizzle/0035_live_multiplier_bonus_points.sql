-- Live tournaments: highlighted matches keep their extra points in their own column.
--
-- A fixture multiplier used to inflate the three scoring tiers: a perfect prediction on a
-- x3 match stored 3 + 3 + 6. That reads wrong on a leaderboard with a column per source —
-- it makes somebody look like a better predictor of goal difference than they are, purely
-- because an admin highlighted a match they happened to get right.
--
-- The tiers now hold what the prediction itself earned (1 + 1 + 2) and the extra goes to
-- `multiplier_bonus_points` (8). The totals are unchanged; only their attribution moves.
--
-- The backfill below restates rows scored under the old scheme. The old tier values were
-- the base times the fixture's multiplier, so dividing by it recovers the base exactly —
-- integer multiplication, integer division, no rounding to worry about — and whatever is
-- left of `points` is the bonus. Rows on unmultiplied fixtures are already correct and are
-- not touched.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_predictions"
  ADD COLUMN IF NOT EXISTS "multiplier_bonus_points" integer NOT NULL DEFAULT 0;

ALTER TABLE "live_competition_members"
  ADD COLUMN IF NOT EXISTS "multiplier_bonus_points" integer NOT NULL DEFAULT 0;

UPDATE "live_predictions" p
SET correct_outcome_points = p.correct_outcome_points / f.multiplier,
    correct_goal_difference_points = p.correct_goal_difference_points / f.multiplier,
    exact_score_points = p.exact_score_points / f.multiplier,
    multiplier_bonus_points = COALESCE(p.points, 0)
      - (p.correct_outcome_points + p.correct_goal_difference_points + p.exact_score_points)
        / f.multiplier
FROM "live_fixtures" f
WHERE p.live_fixture_id = f.id
  AND f.multiplier > 1
  AND p.points IS NOT NULL
  AND p.multiplier_bonus_points = 0;

-- ...and restate the member aggregates the same values roll up into.
UPDATE "live_competition_members" m
SET correct_outcome_points = COALESCE(s.outcome, 0),
    correct_goal_difference_points = COALESCE(s.gd, 0),
    exact_score_points = COALESCE(s.exact, 0),
    multiplier_bonus_points = COALESCE(s.bonus, 0)
FROM (
  SELECT live_competition_id,
         user_id,
         SUM(correct_outcome_points)          AS outcome,
         SUM(correct_goal_difference_points)  AS gd,
         SUM(exact_score_points)              AS exact,
         SUM(multiplier_bonus_points)         AS bonus
  FROM "live_predictions"
  WHERE points IS NOT NULL
  GROUP BY live_competition_id, user_id
) s
WHERE m.live_competition_id = s.live_competition_id
  AND m.user_id = s.user_id;
