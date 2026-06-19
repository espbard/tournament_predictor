ALTER TABLE "users" ADD COLUMN "is_late_addition" boolean NOT NULL DEFAULT false;
ALTER TABLE "competition_members" ADD COLUMN "late_addition_points" integer NOT NULL DEFAULT 0;
ALTER TABLE "competition_members" ADD COLUMN "late_addition_window_ends_at" timestamp;
