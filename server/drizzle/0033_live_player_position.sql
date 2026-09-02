-- Live tournaments: a player's position, and the reason it exists.
--
-- The top-scorer shortlist is now built from club squads rather than from the scorer list.
-- That was the only way to make it usable: the provider's scorers endpoint lists players
-- who have *already scored*, so before a competition starts it is empty, and an admin had
-- nothing to pick from.
--
-- A full Champions League squad import is ~900 players, which is a long list to choose ten
-- from. The position comes along for the ride so the admin panel can filter it down.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_players"
  ADD COLUMN IF NOT EXISTS "position" text;
