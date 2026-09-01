-- Live tournaments: a per-fixture point multiplier.
--
-- An admin can mark a match as worth more than the rest: every point the fixture awards —
-- outcome, goal difference and exact score alike — is multiplied by this whole number.
-- The default of 1 leaves scoring exactly as it was, so every existing fixture is
-- unaffected and no stored points need rewriting.
--
-- Set by an admin only. The fixture upsert in server/src/live/sync.ts lists the columns a
-- provider owns and this is not among them, so a sync never resets it.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_fixtures"
  ADD COLUMN IF NOT EXISTS "multiplier" integer NOT NULL DEFAULT 1;
