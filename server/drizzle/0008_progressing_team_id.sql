ALTER TABLE "matches" ADD COLUMN "progressing_team_id" text REFERENCES "teams"("id");
