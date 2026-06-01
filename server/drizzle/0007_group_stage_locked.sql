ALTER TABLE "competition_members" ADD COLUMN IF NOT EXISTS "group_stage_locked" boolean NOT NULL DEFAULT false;
