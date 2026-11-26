-- Live tournaments: stages visible to test accounts and admins only.
--
-- Lets the Champions League knockout rounds be set up and tried out before regular
-- players see them. NULL means "use the preset's default" (shared/src/live/rounds.ts,
-- liveTestOnlyStageKeys), which for the UCL 2026/27 preset hides every knockout stage —
-- so no existing row needs updating. An admin's choice is stored as a JSON array of
-- stage keys, an empty one meaning "nothing hidden".
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_tournaments" ADD COLUMN IF NOT EXISTS "test_only_stage_keys" jsonb;
