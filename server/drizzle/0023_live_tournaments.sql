-- Live (API-linked) tournaments.
--
-- A second, completely separate tournament type: bound to a real competition through a
-- data provider, predicted per fixture with a kickoff-minus-one-hour deadline, and with
-- no predicted matchups. Shares only `users` with the manual tournament tables.
--
-- See docs/LIVE_TOURNAMENTS_PLAN.md.
--
-- Hand-written rather than generated: drizzle/meta/_journal.json has no snapshots past
-- 0004, so `drizzle-kit generate` would diff against a five-year-old schema. The same
-- statements are mirrored idempotently in server/src/live/ensureSchema.ts, which runs on
-- every boot.

CREATE TYPE "live_provider" AS ENUM ('football_data');
CREATE TYPE "live_tournament_status" AS ENUM ('upcoming', 'active', 'completed');
CREATE TYPE "live_fixture_status" AS ENUM ('scheduled', 'in_play', 'paused', 'finished', 'postponed', 'suspended', 'cancelled');
CREATE TYPE "live_qualification_status" AS ENUM ('qualified', 'pending', 'eliminated');

CREATE TABLE "live_tournaments" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "image_url" text,
  "preset_key" text,
  "provider" "live_provider" NOT NULL DEFAULT 'football_data',
  "provider_competition_id" text NOT NULL,
  "season" text NOT NULL,
  "format" text NOT NULL,
  "start_stage_key" text NOT NULL,
  "status" "live_tournament_status" NOT NULL DEFAULT 'upcoming',
  "sync_enabled" boolean NOT NULL DEFAULT true,
  "last_structure_sync_at" timestamp,
  "last_fixture_sync_at" timestamp,
  "last_sync_error" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "live_tournaments_provider_competition_season_unique"
  ON "live_tournaments" ("provider", "provider_competition_id", "season");

CREATE TABLE "live_teams" (
  "id" text PRIMARY KEY,
  "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
  "provider_team_id" text NOT NULL,
  "name" text NOT NULL,
  "short_name" text,
  "tla" text,
  "crest_url" text,
  "group_name" text,
  "qualification_status" "live_qualification_status" NOT NULL DEFAULT 'pending'
);

CREATE UNIQUE INDEX "live_teams_tournament_provider_team_unique"
  ON "live_teams" ("live_tournament_id", "provider_team_id");

CREATE TABLE "live_fixtures" (
  "id" text PRIMARY KEY,
  "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
  "provider_fixture_id" text NOT NULL,
  "home_team_id" text REFERENCES "live_teams"("id") ON DELETE SET NULL,
  "away_team_id" text REFERENCES "live_teams"("id") ON DELETE SET NULL,
  "kickoff_at" timestamp,
  "kickoff_confirmed" boolean NOT NULL DEFAULT false,
  "status" "live_fixture_status" NOT NULL DEFAULT 'scheduled',
  "stage_key" text,
  "provider_stage" text,
  "group_name" text,
  "matchday" integer,
  "tie_key" text,
  "leg_number" integer,
  -- End of normal time: the only score that awards points.
  "normal_time_home" integer,
  "normal_time_away" integer,
  "half_time_home" integer,
  "half_time_away" integer,
  "extra_time_home" integer,
  "extra_time_away" integer,
  "penalties_home" integer,
  "penalties_away" integer,
  -- Provider full-time score, including extra time. Display only.
  "final_home" integer,
  "final_away" integer,
  "winner" text,
  "minute" integer,
  "provider_score_raw" json,
  "provider_last_updated" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "live_fixtures_tournament_provider_fixture_unique"
  ON "live_fixtures" ("live_tournament_id", "provider_fixture_id");
CREATE INDEX "live_fixtures_tournament_kickoff_idx"
  ON "live_fixtures" ("live_tournament_id", "kickoff_at");
CREATE INDEX "live_fixtures_tournament_stage_idx"
  ON "live_fixtures" ("live_tournament_id", "stage_key");
CREATE INDEX "live_fixtures_status_idx" ON "live_fixtures" ("status");

CREATE TABLE "live_standings" (
  "id" text PRIMARY KEY,
  "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
  "stage_key" text NOT NULL,
  "group_name" text,
  "team_id" text NOT NULL REFERENCES "live_teams"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "played" integer NOT NULL DEFAULT 0,
  "won" integer NOT NULL DEFAULT 0,
  "drawn" integer NOT NULL DEFAULT 0,
  "lost" integer NOT NULL DEFAULT 0,
  "goals_for" integer NOT NULL DEFAULT 0,
  "goals_against" integer NOT NULL DEFAULT 0,
  "goal_difference" integer NOT NULL DEFAULT 0,
  "points" integer NOT NULL DEFAULT 0,
  "form" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- group_name is deliberately not part of the key: it is nullable, and Postgres treats
-- NULLs as distinct, which would let duplicates through for single-table formats.
CREATE UNIQUE INDEX "live_standings_tournament_stage_team_unique"
  ON "live_standings" ("live_tournament_id", "stage_key", "team_id");

CREATE TABLE "live_competitions" (
  "id" text PRIMARY KEY,
  "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "image_url" text,
  "invite_code" text NOT NULL UNIQUE,
  "scoring_config" json NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
  -- No prediction_deadline column: the live type locks per fixture only.
);

CREATE TABLE "live_competition_members" (
  "id" text PRIMARY KEY,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "joined_at" timestamp NOT NULL DEFAULT now(),
  "correct_outcome_points" integer NOT NULL DEFAULT 0,
  "correct_goal_difference_points" integer NOT NULL DEFAULT 0,
  "exact_score_points" integer NOT NULL DEFAULT 0,
  "total_points" integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX "live_competition_members_competition_user_unique"
  ON "live_competition_members" ("live_competition_id", "user_id");

CREATE TABLE "live_predictions" (
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
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- The constraint the manual `predictions` table lacks, where uniqueness is enforced
-- only in application code.
CREATE UNIQUE INDEX "live_predictions_competition_user_fixture_unique"
  ON "live_predictions" ("live_competition_id", "user_id", "live_fixture_id");
CREATE INDEX "live_predictions_fixture_idx" ON "live_predictions" ("live_fixture_id");
