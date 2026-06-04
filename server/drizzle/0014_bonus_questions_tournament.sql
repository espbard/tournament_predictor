-- Add yes_no answer type to enum
ALTER TYPE "bonus_answer_type" ADD VALUE IF NOT EXISTS 'yes_no';

-- Migrate bonus_questions from competition-scoped to tournament-scoped

-- Step 1: Add new tournament_id column (nullable first)
ALTER TABLE "bonus_questions" ADD COLUMN "tournament_id" text;

-- Step 2: Populate from the linked competition's tournament_id
UPDATE "bonus_questions" bq
SET "tournament_id" = c."tournament_id"
FROM "competitions" c
WHERE c."id" = bq."competition_id";

-- Step 3: Set NOT NULL
ALTER TABLE "bonus_questions" ALTER COLUMN "tournament_id" SET NOT NULL;

-- Step 4: Add new FK
ALTER TABLE "bonus_questions" ADD CONSTRAINT "bonus_questions_tournament_id_fkey"
  FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE;

-- Step 5: Drop old FK and column
ALTER TABLE "bonus_questions" DROP CONSTRAINT "bonus_questions_competition_id_fkey";
ALTER TABLE "bonus_questions" DROP COLUMN "competition_id";
