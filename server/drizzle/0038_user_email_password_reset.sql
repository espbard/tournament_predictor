-- Optional email on users, and the tokens behind "forgot password" links.
--
-- The email is nullable: it is optional, and existing users have none until they add one on
-- their profile. Stored lowercased by the app, so a plain unique index is case-insensitive
-- in practice.
--
-- Only the SHA-256 of a reset token is stored. A token is valid for 30 minutes and once.
--
-- Hand-written: see CLAUDE_CONTEXT.md on why db:generate is unsafe here. Mirrored with
-- IF NOT EXISTS in server/src/index.ts — keep the two in sync.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email");

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx" ON "password_reset_tokens" ("user_id");
