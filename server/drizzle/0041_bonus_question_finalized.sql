-- Bonus questions: a per-question "finalized" flag, for both tournament types.
--
-- Until an admin finalizes a question its correct answer stays hidden from regular members
-- (test accounts may see it) and it awards no points. This replaces the old rule, under
-- which a whole tournament being marked completed revealed and scored every question.
--
-- Backfill: questions that already had a correct answer on a completed tournament were
-- revealed and scored under the old rule, so they start out finalized and keep their points.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored in server/src/index.ts (bonus_questions) and server/src/live/ensureSchema.ts
-- (live_bonus_questions), which add the column and run the backfill once — keep them in sync.

ALTER TABLE "bonus_questions" ADD COLUMN IF NOT EXISTS "finalized" boolean NOT NULL DEFAULT false;
UPDATE "bonus_questions" q SET "finalized" = true
  FROM "tournaments" t
  WHERE t."id" = q."tournament_id" AND t."status" = 'completed' AND q."correct_answer" IS NOT NULL;

ALTER TABLE "live_bonus_questions" ADD COLUMN IF NOT EXISTS "finalized" boolean NOT NULL DEFAULT false;
UPDATE "live_bonus_questions" q SET "finalized" = true
  FROM "live_tournaments" t
  WHERE t."id" = q."live_tournament_id" AND t."status" = 'completed' AND q."correct_answer" IS NOT NULL;
