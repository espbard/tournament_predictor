CREATE TYPE "bonus_answer_type" AS ENUM ('text', 'number', 'player', 'team');

CREATE TABLE "bonus_questions" (
  "id" text PRIMARY KEY,
  "competition_id" text NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
  "question" text NOT NULL,
  "answer_type" "bonus_answer_type" NOT NULL DEFAULT 'text',
  "points" integer NOT NULL,
  "correct_answer" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "bonus_answers" (
  "id" text PRIMARY KEY,
  "question_id" text NOT NULL REFERENCES "bonus_questions"("id") ON DELETE CASCADE,
  "competition_id" text NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "answer" text NOT NULL,
  "points" integer,
  "created_at" timestamp NOT NULL DEFAULT now()
);
