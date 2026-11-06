import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * Idempotent DDL for the live tournament tables, run on every boot.
 *
 * This repo's migration journal has drifted from the SQL on disk (no snapshots past 0004,
 * several files unjournaled), so `server/src/index.ts` already compensates with defensive
 * statements. Live tables follow the same convention: the real definition is
 * drizzle/0023_live_tournaments.sql, and everything here mirrors it with IF NOT EXISTS so a
 * database that missed the migration still ends up correct.
 *
 * Keep the two in sync. See docs/LIVE_TOURNAMENTS_PLAN.md.
 */
export async function ensureLiveSchema(): Promise<void> {
  // ── Enums ───────────────────────────────────────────────────────────────────
  await db.execute(sql`DO $$ BEGIN CREATE TYPE "live_provider" AS ENUM ('football_data', 'big_balls'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  // Added to the enum after its first release, so an existing database needs it too.
  await db.execute(sql`ALTER TYPE "live_provider" ADD VALUE IF NOT EXISTS 'big_balls'`);
  await db.execute(sql`DO $$ BEGIN CREATE TYPE "live_tournament_status" AS ENUM ('upcoming', 'active', 'completed'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await db.execute(sql`DO $$ BEGIN CREATE TYPE "live_fixture_status" AS ENUM ('scheduled', 'in_play', 'paused', 'finished', 'postponed', 'suspended', 'cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await db.execute(sql`DO $$ BEGIN CREATE TYPE "live_qualification_status" AS ENUM ('qualified', 'pending', 'eliminated'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await db.execute(sql`DO $$ BEGIN CREATE TYPE "live_bonus_answer_type" AS ENUM ('number', 'player', 'team', 'yes_no', 'country'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  // Added to the enum after its first release, so an existing database needs it too.
  await db.execute(sql`ALTER TYPE "live_bonus_answer_type" ADD VALUE IF NOT EXISTS 'country'`);

  // ── Tables ──────────────────────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_tournaments" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "image_url" text,
      "preset_key" text,
      "provider" "live_provider" NOT NULL DEFAULT 'football_data',
      "fixture_provider" "live_provider",
      "fixture_provider_competition_id" text,
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
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_teams" (
      "id" text PRIMARY KEY,
      "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
      "provider_team_id" text NOT NULL,
      "name" text NOT NULL,
      "short_name" text,
      "tla" text,
      "crest_url" text,
      "group_name" text,
      "qualification_status" "live_qualification_status" NOT NULL DEFAULT 'pending'
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_fixtures" (
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
      "normal_time_home" integer,
      "normal_time_away" integer,
      "half_time_home" integer,
      "half_time_away" integer,
      "extra_time_home" integer,
      "extra_time_away" integer,
      "penalties_home" integer,
      "penalties_away" integer,
      "final_home" integer,
      "final_away" integer,
      "winner" text,
      "minute" integer,
      "provider_score_raw" json,
      "provider_last_updated" timestamp,
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_standings" (
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
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_competitions" (
      "id" text PRIMARY KEY,
      "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "image_url" text,
      "invite_code" text NOT NULL UNIQUE,
      "invite_token" text,
      "scoring_config" json NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_competition_members" (
      "id" text PRIMARY KEY,
      "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "joined_at" timestamp NOT NULL DEFAULT now(),
      "correct_outcome_points" integer NOT NULL DEFAULT 0,
      "correct_goal_difference_points" integer NOT NULL DEFAULT 0,
      "exact_score_points" integer NOT NULL DEFAULT 0,
      "total_points" integer NOT NULL DEFAULT 0
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_predictions" (
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
    )
  `);

  await db.execute(sql`
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
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_gameweek_selections" (
      "id" text PRIMARY KEY,
      "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
      "stage_key" text NOT NULL,
      "matchday" integer NOT NULL,
      "selected_fixture_ids" json NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_bonus_questions" (
      "id" text PRIMARY KEY,
      "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
      "question" text NOT NULL,
      "answer_type" "live_bonus_answer_type" NOT NULL DEFAULT 'number',
      "points" integer NOT NULL,
      "correct_answer" text,
      "lock_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_bonus_answers" (
      "id" text PRIMARY KEY,
      "question_id" text NOT NULL REFERENCES "live_bonus_questions"("id") ON DELETE CASCADE,
      "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "answer" text NOT NULL,
      "points" integer,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_players" (
      "id" text PRIMARY KEY,
      "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
      "provider_player_id" text,
      "name" text NOT NULL,
      "team_id" text REFERENCES "live_teams"("id") ON DELETE SET NULL,
      "position" text,
      "image_url" text,
      "glow_color" text,
      "goals" integer NOT NULL DEFAULT 0,
      "assists" integer NOT NULL DEFAULT 0,
      "is_selected" boolean NOT NULL DEFAULT false,
      "provider_last_updated" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_scorer_predictions" (
      "id" text PRIMARY KEY,
      "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "ordered_player_ids" json NOT NULL,
      "points" integer,
      "exact_position_points" integer NOT NULL DEFAULT 0,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  // ── Columns added after a table's first release ──────────────────────────────
  await db.execute(sql`ALTER TABLE "live_competition_members" ADD COLUMN IF NOT EXISTS "table_points" integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE "live_competition_members" ADD COLUMN IF NOT EXISTS "bonus_points" integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE "live_bonus_questions" ADD COLUMN IF NOT EXISTS "min_value" integer`);
  await db.execute(sql`ALTER TABLE "live_bonus_questions" ADD COLUMN IF NOT EXISTS "max_value" integer`);
  await db.execute(sql`ALTER TABLE "live_bonus_questions" ADD COLUMN IF NOT EXISTS "leeway" integer`);
  await db.execute(sql`ALTER TABLE "live_bonus_questions" ADD COLUMN IF NOT EXISTS "options" json`);
  // Added to live_players after its first release, for filtering a squad-sized list.
  await db.execute(sql`ALTER TABLE "live_players" ADD COLUMN IF NOT EXISTS "position" text`);
  await db.execute(sql`ALTER TABLE "live_players" ADD COLUMN IF NOT EXISTS "glow_color" text`);
  // Highlighted-match points, kept out of the three tiers so a leaderboard column per
  // source attributes them honestly. See drizzle/0035 for the backfill.
  await db.execute(sql`ALTER TABLE "live_predictions" ADD COLUMN IF NOT EXISTS "multiplier_bonus_points" integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE "live_competition_members" ADD COLUMN IF NOT EXISTS "multiplier_bonus_points" integer NOT NULL DEFAULT 0`);
  // Top-scorer ranking points, alongside the other point sources on the member row.
  await db.execute(sql`ALTER TABLE "live_competition_members" ADD COLUMN IF NOT EXISTS "scorer_points" integer NOT NULL DEFAULT 0`);
  // Per-fixture point multiplier. Admin-set; 1 means scoring is untouched.
  await db.execute(sql`ALTER TABLE "live_fixtures" ADD COLUMN IF NOT EXISTS "multiplier" integer NOT NULL DEFAULT 1`);
  // Share-link token. Nullable: minted the first time somebody presses Invite.
  await db.execute(sql`ALTER TABLE "live_competitions" ADD COLUMN IF NOT EXISTS "invite_token" text`);
  // Public: readable (never playable) by every signed-in user, member or not.
  await db.execute(sql`ALTER TABLE "live_competitions" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false`);

  // ── Indexes ─────────────────────────────────────────────────────────────────
  await db.execute(sql`ALTER TABLE "live_tournaments" ADD COLUMN IF NOT EXISTS "fixture_provider" "live_provider"`);
  await db.execute(sql`ALTER TABLE "live_tournaments" ADD COLUMN IF NOT EXISTS "fixture_provider_competition_id" text`);
  await db.execute(sql`ALTER TABLE "live_tournaments" ADD COLUMN IF NOT EXISTS "scorer_nationalities" jsonb`);

  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_tournaments_provider_competition_season_unique" ON "live_tournaments" ("provider", "provider_competition_id", "season")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_teams_tournament_provider_team_unique" ON "live_teams" ("live_tournament_id", "provider_team_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_fixtures_tournament_provider_fixture_unique" ON "live_fixtures" ("live_tournament_id", "provider_fixture_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_fixtures_tournament_kickoff_idx" ON "live_fixtures" ("live_tournament_id", "kickoff_at")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_fixtures_tournament_stage_idx" ON "live_fixtures" ("live_tournament_id", "stage_key")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_fixtures_status_idx" ON "live_fixtures" ("status")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_standings_tournament_stage_team_unique" ON "live_standings" ("live_tournament_id", "stage_key", "team_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_competitions_invite_token_unique" ON "live_competitions" ("invite_token")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_competition_members_competition_user_unique" ON "live_competition_members" ("live_competition_id", "user_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_predictions_competition_user_fixture_unique" ON "live_predictions" ("live_competition_id", "user_id", "live_fixture_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_predictions_fixture_idx" ON "live_predictions" ("live_fixture_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_table_predictions_competition_user_stage_unique" ON "live_table_predictions" ("live_competition_id", "user_id", "stage_key")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_gameweek_selections_tournament_stage_matchday_unique" ON "live_gameweek_selections" ("live_tournament_id", "stage_key", "matchday")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_answers_question_competition_user_unique" ON "live_bonus_answers" ("question_id", "live_competition_id", "user_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_bonus_answers_competition_idx" ON "live_bonus_answers" ("live_competition_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_players_tournament_provider_player_unique" ON "live_players" ("live_tournament_id", "provider_player_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_players_tournament_idx" ON "live_players" ("live_tournament_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_scorer_predictions_competition_user_unique" ON "live_scorer_predictions" ("live_competition_id", "user_id")`);



  // ── Bonus rounds — mirrors drizzle/0040_live_bonus_rounds.sql ───────────────
  await db.execute(sql`ALTER TABLE "live_competition_members" ADD COLUMN IF NOT EXISTS "bonus_round_points" integer NOT NULL DEFAULT 0`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_bonus_rounds" (
      "id" text PRIMARY KEY,
      "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "after_stage_key" text,
      "after_matchday" integer,
      "visibility" text NOT NULL DEFAULT 'test',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_bonus_rounds_competition_idx" ON "live_bonus_rounds" ("live_competition_id")`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "live_bonus_teams" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "image_url" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_teams_name_unique" ON "live_bonus_teams" (lower("name"))`);
  // Before the CREATE below, which would skip a table left over in an older shape.
  await upgradeEarlyBonusRoundTables();
  await addBonusQuestionFinalized();
  await db.execute(sql`
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
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_bonus_round_fixtures_round_idx" ON "live_bonus_round_fixtures" ("bonus_round_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_bonus_round_fixtures_competition_idx" ON "live_bonus_round_fixtures" ("live_competition_id")`);
  await db.execute(sql`
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
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_round_predictions_fixture_user_unique" ON "live_bonus_round_predictions" ("bonus_fixture_id", "user_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "live_bonus_round_predictions_competition_idx" ON "live_bonus_round_predictions" ("live_competition_id")`);
}

/** Whether a column exists, for the one-off upgrades below. */
async function hasColumn(table: string, column: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}
  `);
  return Array.from(rows as unknown as unknown[]).length > 0;
}

/**
 * The per-question `finalized` flag (drizzle/0041). Added and backfilled only the first
 * time: a question that already had a correct answer on a completed tournament was revealed
 * and scored under the old rule, so it starts out finalized. Running the backfill on every
 * boot would re-finalize a question an admin has since unticked.
 */
async function addBonusQuestionFinalized(): Promise<void> {
  if (await hasColumn('live_bonus_questions', 'finalized')) return;
  await db.execute(sql`ALTER TABLE "live_bonus_questions" ADD COLUMN IF NOT EXISTS "finalized" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`
    UPDATE "live_bonus_questions" q SET "finalized" = true
      FROM "live_tournaments" t
      WHERE t."id" = q."live_tournament_id" AND t."status" = 'completed' AND q."correct_answer" IS NOT NULL
  `);
}

/**
 * Bring bonus-round tables written by earlier versions of the feature up to date.
 *
 * Bonus rounds changed shape twice before release, and a database that ran an earlier
 * version keeps that table — CREATE TABLE IF NOT EXISTS skips it — so the current code
 * would read columns that are not there. Runs on every boot and does nothing once a
 * database is current.
 *
 *   1. Matches borrowed from a synced tournament (`live_fixture_id`, no `id` column). Those
 *      matches no longer exist in any form, so the matches and their predictions are
 *      dropped and recreated empty. The rounds themselves are kept.
 *   2. Hand-entered matches with free-text team names (`home_team_name`). Each name is
 *      registered as a bonus team (one per name, ignoring case) and the match is pointed
 *      at it, so no match or prediction is lost.
 *
 * Requires live_bonus_teams and its name index, which the caller creates first.
 */
async function upgradeEarlyBonusRoundTables(): Promise<void> {
  if (!(await hasColumn('live_bonus_round_fixtures', 'bonus_round_id'))) return; // fresh database

  // 1. The first shape: matches borrowed from the Nations League tournament.
  if (!(await hasColumn('live_bonus_round_fixtures', 'id'))) {
    console.warn('[ensureSchema] replacing first-version bonus-round match tables (their matches cannot be kept)');
    await db.execute(sql`DROP TABLE IF EXISTS "live_bonus_round_predictions"`);
    await db.execute(sql`DROP TABLE IF EXISTS "live_bonus_round_fixtures"`);
    // Its leftovers on other tables, unused since.
    await db.execute(sql`ALTER TABLE "live_fixtures" DROP COLUMN IF EXISTS "score_override_home"`);
    await db.execute(sql`ALTER TABLE "live_fixtures" DROP COLUMN IF EXISTS "score_override_away"`);
    await db.execute(sql`ALTER TABLE "live_tournaments" DROP COLUMN IF EXISTS "is_bonus_source"`);
    return;
  }

  // 2. The second shape: team names typed in by hand.
  if (await hasColumn('live_bonus_round_fixtures', 'home_team_name')) {
    console.warn('[ensureSchema] moving bonus-round matches from team names to bonus teams');
    await db.execute(sql`
      INSERT INTO "live_bonus_teams" ("id", "name")
      SELECT substr(md5(random()::text || n.name), 1, 15), n.name
      FROM (
        SELECT DISTINCT ON (lower(trim(name))) trim(name) AS name
        FROM (
          SELECT "home_team_name" AS name FROM "live_bonus_round_fixtures"
          UNION ALL
          SELECT "away_team_name" FROM "live_bonus_round_fixtures"
        ) AS all_names
      ) AS n
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`ALTER TABLE "live_bonus_round_fixtures" ADD COLUMN IF NOT EXISTS "home_team_id" text`);
    await db.execute(sql`ALTER TABLE "live_bonus_round_fixtures" ADD COLUMN IF NOT EXISTS "away_team_id" text`);
    await db.execute(sql`
      UPDATE "live_bonus_round_fixtures" f
      SET "home_team_id" = (SELECT t."id" FROM "live_bonus_teams" t WHERE lower(t."name") = lower(trim(f."home_team_name"))),
          "away_team_id" = (SELECT t."id" FROM "live_bonus_teams" t WHERE lower(t."name") = lower(trim(f."away_team_name")))
    `);
    await db.execute(sql`ALTER TABLE "live_bonus_round_fixtures" ALTER COLUMN "home_team_id" SET NOT NULL`);
    await db.execute(sql`ALTER TABLE "live_bonus_round_fixtures" ALTER COLUMN "away_team_id" SET NOT NULL`);
    await db.execute(sql`
      ALTER TABLE "live_bonus_round_fixtures"
        ADD CONSTRAINT "live_bonus_round_fixtures_home_team_id_fk"
        FOREIGN KEY ("home_team_id") REFERENCES "live_bonus_teams"("id") ON DELETE RESTRICT
    `);
    await db.execute(sql`
      ALTER TABLE "live_bonus_round_fixtures"
        ADD CONSTRAINT "live_bonus_round_fixtures_away_team_id_fk"
        FOREIGN KEY ("away_team_id") REFERENCES "live_bonus_teams"("id") ON DELETE RESTRICT
    `);
    await db.execute(sql`ALTER TABLE "live_bonus_round_fixtures" DROP COLUMN "home_team_name"`);
    await db.execute(sql`ALTER TABLE "live_bonus_round_fixtures" DROP COLUMN "away_team_name"`);
  }
}
