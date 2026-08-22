-- Live tournaments: bonus questions.
--
-- Season-long side bets — "how many goals will X score?" — mirroring the manual type's
-- bonus_questions / bonus_answers, but on their own tables so the two type systems stay
-- independent. Questions belong to the tournament, answers to a competition.
--
-- Two rules differ from the manual type, both because a live competition has no
-- competition-wide deadline:
--   * answers close at the question's own lock_at, or by default one hour before the
--     first match of the tournament's starting stage (see shared/src/live/lock.ts);
--   * points, as in the manual type, are withheld until the tournament is completed.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

DO $$ BEGIN
  CREATE TYPE "live_bonus_answer_type" AS ENUM ('number', 'player', 'team', 'yes_no');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "live_bonus_questions" (
  "id" text PRIMARY KEY,
  "live_tournament_id" text NOT NULL REFERENCES "live_tournaments"("id") ON DELETE CASCADE,
  "question" text NOT NULL,
  "answer_type" "live_bonus_answer_type" NOT NULL DEFAULT 'number',
  "points" integer NOT NULL,
  "correct_answer" text,
  "lock_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "live_bonus_answers" (
  "id" text PRIMARY KEY,
  "question_id" text NOT NULL REFERENCES "live_bonus_questions"("id") ON DELETE CASCADE,
  "live_competition_id" text NOT NULL REFERENCES "live_competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "answer" text NOT NULL,
  "points" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_bonus_answers_question_competition_user_unique"
  ON "live_bonus_answers" ("question_id", "live_competition_id", "user_id");
CREATE INDEX IF NOT EXISTS "live_bonus_answers_competition_idx"
  ON "live_bonus_answers" ("live_competition_id");

-- Denormalised aggregate on the member row, alongside the other point sources.
ALTER TABLE "live_competition_members"
  ADD COLUMN IF NOT EXISTS "bonus_points" integer NOT NULL DEFAULT 0;
