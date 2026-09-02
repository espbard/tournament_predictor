-- Live tournaments: the top-scorer ranking.
--
-- A second ranking prediction alongside the league table, but about players: an admin
-- curates a shortlist out of `live_players`, users order it, and each player placed in
-- exactly the right position at the end of the tournament is worth
-- `scoring_config.scorer_exact_position` (2 by default).
--
-- Two things worth knowing about the shape:
--
--   * `provider_player_id` is null for a player an admin typed in. The unique index still
--     holds because Postgres treats NULLs as distinct, and the sync only ever writes rows
--     it can identify — which is what keeps hand-entered goals from being overwritten.
--   * `assists` exists only to break a tie on goals. A top-scorer table is full of them,
--     and the ranking has to be strict 1..N for every position to be winnable.
--
-- Points are withheld until the tournament is marked completed, exactly as bonus points
-- are, so `points` stays null until then rather than reading as a scored zero.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

CREATE TABLE IF NOT EXISTS "live_players" (
  "id" text PRIMARY KEY,
  "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
  "provider_player_id" text,
  "name" text NOT NULL,
  "team_id" text REFERENCES "live_teams"("id") ON DELETE SET NULL,
  "image_url" text,
  "goals" integer NOT NULL DEFAULT 0,
  "assists" integer NOT NULL DEFAULT 0,
  "is_selected" boolean NOT NULL DEFAULT false,
  "provider_last_updated" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_players_tournament_provider_player_unique"
  ON "live_players" ("live_tournament_id", "provider_player_id");
CREATE INDEX IF NOT EXISTS "live_players_tournament_idx"
  ON "live_players" ("live_tournament_id");

CREATE TABLE IF NOT EXISTS "live_scorer_predictions" (
  "id" text PRIMARY KEY,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "ordered_player_ids" json NOT NULL,
  "points" integer,
  "exact_position_points" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_scorer_predictions_competition_user_unique"
  ON "live_scorer_predictions" ("live_competition_id", "user_id");

-- Denormalised aggregate on the member row, alongside the other point sources.
ALTER TABLE "live_competition_members"
  ADD COLUMN IF NOT EXISTS "scorer_points" integer NOT NULL DEFAULT 0;
