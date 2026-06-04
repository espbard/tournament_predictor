CREATE TABLE IF NOT EXISTS "app_config" (
  "id" text PRIMARY KEY DEFAULT 'singleton',
  "maintenance_mode" boolean NOT NULL DEFAULT false
);

INSERT INTO "app_config" ("id", "maintenance_mode") VALUES ('singleton', false) ON CONFLICT DO NOTHING;
