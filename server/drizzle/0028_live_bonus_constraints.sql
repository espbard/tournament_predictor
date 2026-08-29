-- Live bonus questions: answer constraints, and a country answer type.
--
-- Three things an admin may now narrow when writing a question (all optional, all
-- enforced in shared/src/live/bonus.ts so the input, the save route and scoring agree):
--
--   * min_value / max_value — a number answer must fall inside the range;
--   * leeway               — a number answer within ±leeway of the correct one scores in
--                            full, so "25, give or take 5" accepts 20 through 30;
--   * options              — the only answers a player, team or country question accepts.
--                            Null or empty means every option is available.
--
-- The new 'country' answer type offers UEFA's member associations, narrowed by `options`
-- like the others.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TYPE "live_bonus_answer_type" ADD VALUE IF NOT EXISTS 'country';

ALTER TABLE "live_bonus_questions"
  ADD COLUMN IF NOT EXISTS "min_value" integer,
  ADD COLUMN IF NOT EXISTS "max_value" integer,
  ADD COLUMN IF NOT EXISTS "leeway" integer,
  ADD COLUMN IF NOT EXISTS "options" json;
