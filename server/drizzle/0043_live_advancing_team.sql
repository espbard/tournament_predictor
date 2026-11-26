-- Live tournaments: a point for the right team going through on a two-legged tie.
--
-- On the second leg of a two-legged knockout tie, a prediction also says which team goes
-- through: the one ahead on the first leg's result plus the predicted score, or — when that
-- total is level — the team the member picked (advancing_team_id). Getting it right earns
-- advancing_team_points, summed per member like the other tiers. An admin can name the team
-- that went through (live_fixtures.advancing_team_override) when the provider cannot say.
-- See shared/src/live/ties.ts.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_predictions" ADD COLUMN IF NOT EXISTS "advancing_team_id" text;
ALTER TABLE "live_predictions" ADD COLUMN IF NOT EXISTS "advancing_team_points" integer NOT NULL DEFAULT 0;
ALTER TABLE "live_competition_members" ADD COLUMN IF NOT EXISTS "advancing_team_points" integer NOT NULL DEFAULT 0;
ALTER TABLE "live_fixtures" ADD COLUMN IF NOT EXISTS "advancing_team_override" text;
