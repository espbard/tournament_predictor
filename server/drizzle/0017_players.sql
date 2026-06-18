CREATE TABLE IF NOT EXISTS "players" (
  "id" text PRIMARY KEY NOT NULL,
  "tournament_id" text NOT NULL,
  "name" text NOT NULL,
  "games_played" integer NOT NULL DEFAULT 0,
  "goals_scored" integer NOT NULL DEFAULT 0,
  CONSTRAINT "players_tournament_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE
);
