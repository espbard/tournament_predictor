-- Live tournaments: league table predictions.
--
-- Users order every team in a table stage from top to bottom. Each team in exactly the
-- right final position scores; in the Champions League, landing a team in the right band
-- of the table (top 8 / 9th-24th / 25th and below) scores again on top.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

CREATE TABLE IF NOT EXISTS "live_table_predictions" (
  "id" text PRIMARY KEY,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "stage_key" text NOT NULL,
  "ordered_team_ids" json NOT NULL,
  "points" integer,
  "exact_position_points" integer NOT NULL DEFAULT 0,
  "band_points" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_table_predictions_competition_user_stage_unique"
  ON "live_table_predictions" ("live_competition_id", "user_id", "stage_key");

-- Denormalised aggregate on the member row, alongside the three per-fixture sources.
ALTER TABLE "live_competition_members"
  ADD COLUMN IF NOT EXISTS "table_points" integer NOT NULL DEFAULT 0;
