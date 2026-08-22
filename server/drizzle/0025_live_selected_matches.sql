-- Live tournaments: selected matches per gameweek.
--
-- An admin may register a subset of a gameweek's fixtures (one matchday inside one stage)
-- as the ones users predict on; the rest are ignored. A gameweek with no row here has
-- every fixture selected, which is the default and the reason a row is never stored with
-- an empty array.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

CREATE TABLE IF NOT EXISTS "live_gameweek_selections" (
  "id" text PRIMARY KEY,
  "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
  "stage_key" text NOT NULL,
  "matchday" integer NOT NULL,
  "selected_fixture_ids" json NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_gameweek_selections_tournament_stage_matchday_unique"
  ON "live_gameweek_selections" ("live_tournament_id", "stage_key", "matchday");
