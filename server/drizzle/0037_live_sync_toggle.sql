-- Admin override for the live-tournament background sync.
-- Nullable on purpose: NULL defers to LIVE_SYNC_ENABLED, TRUE/FALSE force it.
--
-- app_config is created here too because 0015_maintenance_mode.sql, which introduced it,
-- is one of the files missing from the journal — see the note in server/src/index.ts.
CREATE TABLE IF NOT EXISTS "app_config" (
  "id" text PRIMARY KEY DEFAULT 'singleton',
  "maintenance_mode" boolean NOT NULL DEFAULT false
);

ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "live_sync_enabled" boolean;
