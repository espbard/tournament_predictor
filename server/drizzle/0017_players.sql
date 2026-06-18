CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"name" text NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	"goals_scored" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
