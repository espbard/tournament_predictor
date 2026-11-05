-- Live tournaments: bonus rounds.
--
-- Extra rounds of match predictions inside one live competition, made of matches an
-- admin sets up by hand (teams, kickoff, and later the 90-minute result), the way the
-- manual tournament type works. Match predictions only.
--
-- Kept apart from live_fixtures / live_predictions, which belong to the provider-synced
-- tournament and are read everywhere on that assumption.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

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

-- Teams bonus-round matches are played by: one registry for the whole app, name + logo.
CREATE TABLE IF NOT EXISTS "live_bonus_teams" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "image_url" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_teams_name_unique" ON "live_bonus_teams" (lower("name"));

CREATE TABLE IF NOT EXISTS "live_bonus_round_fixtures" (
  "id" text PRIMARY KEY,
  "bonus_round_id" text NOT NULL REFERENCES "live_bonus_rounds"("id") ON DELETE CASCADE,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "home_team_id" text NOT NULL REFERENCES "live_bonus_teams"("id") ON DELETE RESTRICT,
  "away_team_id" text NOT NULL REFERENCES "live_bonus_teams"("id") ON DELETE RESTRICT,
  "label" text,
  "kickoff_at" timestamp NOT NULL,
  "multiplier" integer NOT NULL DEFAULT 1,
  "home_score" integer,
  "away_score" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "live_bonus_round_fixtures_round_idx" ON "live_bonus_round_fixtures" ("bonus_round_id");
CREATE INDEX IF NOT EXISTS "live_bonus_round_fixtures_competition_idx" ON "live_bonus_round_fixtures" ("live_competition_id");

CREATE TABLE IF NOT EXISTS "live_bonus_round_predictions" (
  "id" text PRIMARY KEY,
  "bonus_fixture_id" text NOT NULL REFERENCES "live_bonus_round_fixtures"("id") ON DELETE CASCADE,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
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
CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_round_predictions_fixture_user_unique" ON "live_bonus_round_predictions" ("bonus_fixture_id", "user_id");
CREATE INDEX IF NOT EXISTS "live_bonus_round_predictions_competition_idx" ON "live_bonus_round_predictions" ("live_competition_id");
