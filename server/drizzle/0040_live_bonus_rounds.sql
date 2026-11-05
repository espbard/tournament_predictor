-- Live tournaments: bonus rounds.
--
-- Extra rounds of match predictions inside one live competition, made of fixtures
-- borrowed from another live tournament — the UEFA Nations League to begin with, which
-- exists only as such a source (`is_bonus_source`). Match predictions only.
--
-- Predictions live in their own table rather than live_predictions, because everything
-- reading live_predictions assumes the fixture belongs to the competition's own
-- tournament.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_tournaments" ADD COLUMN IF NOT EXISTS "is_bonus_source" boolean NOT NULL DEFAULT false;

-- bigballsdata gives one score with no split between 90 minutes and extra time, so an
-- admin can state the normal-time score for bonus-round scoring. Never written by sync.
ALTER TABLE "live_fixtures" ADD COLUMN IF NOT EXISTS "score_override_home" integer;
ALTER TABLE "live_fixtures" ADD COLUMN IF NOT EXISTS "score_override_away" integer;

ALTER TABLE "live_competition_members" ADD COLUMN IF NOT EXISTS "bonus_round_points" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "live_bonus_rounds" (
  "id" text PRIMARY KEY,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "after_stage_key" text,
  "after_matchday" integer,
  "visibility" text NOT NULL DEFAULT 'test',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "live_bonus_rounds_competition_idx" ON "live_bonus_rounds" ("live_competition_id");

CREATE TABLE IF NOT EXISTS "live_bonus_round_fixtures" (
  "bonus_round_id" text NOT NULL REFERENCES "live_bonus_rounds"("id") ON DELETE CASCADE,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "live_fixture_id" text NOT NULL REFERENCES "live_fixtures"("id") ON DELETE CASCADE,
  "multiplier" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("bonus_round_id", "live_fixture_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_round_fixtures_competition_fixture_unique" ON "live_bonus_round_fixtures" ("live_competition_id", "live_fixture_id");
CREATE INDEX IF NOT EXISTS "live_bonus_round_fixtures_fixture_idx" ON "live_bonus_round_fixtures" ("live_fixture_id");

CREATE TABLE IF NOT EXISTS "live_bonus_round_predictions" (
  "id" text PRIMARY KEY,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "live_fixture_id" text NOT NULL REFERENCES "live_fixtures"("id") ON DELETE CASCADE,
  "home_score" integer NOT NULL,
  "away_score" integer NOT NULL,
  "points" integer,
  "correct_outcome_points" integer NOT NULL DEFAULT 0,
  "correct_goal_difference_points" integer NOT NULL DEFAULT 0,
  "exact_score_points" integer NOT NULL DEFAULT 0,
  "multiplier_bonus_points" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_round_predictions_competition_user_fixture_unique" ON "live_bonus_round_predictions" ("live_competition_id", "user_id", "live_fixture_id");
CREATE INDEX IF NOT EXISTS "live_bonus_round_predictions_fixture_idx" ON "live_bonus_round_predictions" ("live_fixture_id");
