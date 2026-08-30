-- Share links for competitions, for both tournament types.
--
-- Alongside the five-digit invite code every competition can hand out a link. The token
-- behind it is unguessable and lives on the competition row, so a link is a standing
-- invitation exactly like the code — nothing to expire, nothing to clean up.
--
-- Nullable on purpose: the token is minted the first time somebody presses Invite, so
-- existing competitions need no backfill.
--
-- Hand-written: see CLAUDE_CONTEXT.md on why db:generate is unsafe here. Mirrored with
-- IF NOT EXISTS in server/src/index.ts (manual) and server/src/live/ensureSchema.ts
-- (live) — keep the three in sync.

ALTER TABLE "competitions" ADD COLUMN IF NOT EXISTS "invite_token" text;
ALTER TABLE "live_competitions" ADD COLUMN IF NOT EXISTS "invite_token" text;

CREATE UNIQUE INDEX IF NOT EXISTS "competitions_invite_token_unique"
  ON "competitions" ("invite_token");
CREATE UNIQUE INDEX IF NOT EXISTS "live_competitions_invite_token_unique"
  ON "live_competitions" ("invite_token");
