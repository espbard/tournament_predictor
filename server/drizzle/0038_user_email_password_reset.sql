-- Optional email on users, and the tokens behind "forgot password" links.
--
-- The email is optional, so both columns are nullable. It is never stored readable:
--   email_encrypted  AES-256-GCM ciphertext of the (lowercased) address
--   email_hash       keyed HMAC of the address, for lookup and uniqueness
-- The key lives in EMAIL_ENCRYPTION_KEY, not in the database. See server/src/lib/emailCrypto.ts.
--
-- Only the SHA-256 of a reset token is stored. A token is valid for 30 minutes and once.
--
-- Hand-written: see CLAUDE_CONTEXT.md on why db:generate is unsafe here. Mirrored with
-- IF NOT EXISTS in server/src/index.ts — keep the two in sync.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_encrypted" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_hash" text;
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_hash_unique" ON "users" ("email_hash");

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx" ON "password_reset_tokens" ("user_id");
