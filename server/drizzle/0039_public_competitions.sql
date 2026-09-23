-- A public competition is readable by every signed-in user, member or not. Only members
-- can predict in it; joining is unchanged. Both tournament types carry the flag.
ALTER TABLE "competitions" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
ALTER TABLE "live_competitions" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
