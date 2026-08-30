-- A tournament may read fixtures from a different provider than its teams and table.
--
-- The Champions League 2026/27 is the case this exists for: football-data published the
-- season's teams and table but no match calendar, well past the point where the app
-- needed one, so fixtures come from bigballsdata.com while everything else stays on
-- football-data. Null means "use `provider` for fixtures too", which is every existing
-- row and remains the default.
--
-- Note what this does NOT do: fixtures stay keyed by (tournament, provider_fixture_id),
-- and two providers do not agree on fixture ids. Changing this column therefore strands
-- the fixtures the previous provider wrote — the PATCH route clears them, and refuses to
-- when predictions are attached. See server/src/live/routes/tournaments.ts.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TYPE "live_provider" ADD VALUE IF NOT EXISTS 'big_balls';

ALTER TABLE "live_tournaments"
  ADD COLUMN IF NOT EXISTS "fixture_provider" "live_provider",
  -- Providers name competitions differently: football-data says "CL", bigballsdata uses
  -- its own league key. Null falls back to provider_competition_id.
  ADD COLUMN IF NOT EXISTS "fixture_provider_competition_id" text;
