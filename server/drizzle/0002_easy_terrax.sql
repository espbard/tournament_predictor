CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "group";