-- Live tournaments: a per-player glow colour.
--
-- The top-scorer shortlist is now built by searching for players by name and adding them
-- one at a time, so each one is a deliberate choice worth decorating: the admin picks a
-- picture and a colour, and the colour is drawn as a glow around that player's row in the
-- ranking every user sees.
--
-- Stored as a CSS hex string (#rrggbb), validated on the way in. Null means no glow, which
-- is what every player imported before this had and what a hand-added one gets by default.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_players"
  ADD COLUMN IF NOT EXISTS "glow_color" text;
