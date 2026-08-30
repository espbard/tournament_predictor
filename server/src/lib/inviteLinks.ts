import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { competitions } from '../db/schema.js';
import { liveCompetitions } from '../db/liveSchema.js';
import type { CompetitionKind } from '@tournament-predictor/shared';

// ── Competition share links ───────────────────────────────────────────────────
//
// The five-digit invite code is short enough to type but far too short to put in a link
// anyone might forward: 90 000 codes is a number a script can walk. A share token is 32
// url-safe characters of randomness instead, so the link itself is the credential.
//
// The token is minted on demand, the first time somebody presses Invite, and then kept —
// pressing Invite again hands out the same link rather than invalidating the one already
// sent to the group chat.

/** ~192 bits, url-safe, no padding. */
export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

/** The client-side route a token resolves at. */
export function inviteTokenPath(token: string): string {
  return `/invite/${token}`;
}

/**
 * The manual competition's share token, creating it if this is the first time.
 *
 * Returns null when the competition does not exist.
 */
export async function ensureManualInviteToken(competitionId: string): Promise<string | null> {
  const [row] = await db
    .select({ inviteToken: competitions.inviteToken })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  if (!row) return null;
  if (row.inviteToken) return row.inviteToken;

  const token = generateInviteToken();
  await db.update(competitions).set({ inviteToken: token }).where(eq(competitions.id, competitionId));
  return token;
}

/** The live competition's share token, creating it if this is the first time. */
export async function ensureLiveInviteToken(competitionId: string): Promise<string | null> {
  const [row] = await db
    .select({ inviteToken: liveCompetitions.inviteToken })
    .from(liveCompetitions)
    .where(eq(liveCompetitions.id, competitionId));
  if (!row) return null;
  if (row.inviteToken) return row.inviteToken;

  const token = generateInviteToken();
  await db
    .update(liveCompetitions)
    .set({ inviteToken: token })
    .where(eq(liveCompetitions.id, competitionId));
  return token;
}

export type ResolvedInvite =
  | { kind: Extract<CompetitionKind, 'manual'>; competition: typeof competitions.$inferSelect }
  | { kind: Extract<CompetitionKind, 'live'>; competition: typeof liveCompetitions.$inferSelect };

/**
 * Find the competition a token belongs to, whichever type it is.
 *
 * The two tournament types keep separate tables, and a link should not have to say which
 * kind it points at, so both are checked. Tokens are random enough that a collision
 * across the two is not a practical concern.
 */
export async function resolveInviteToken(token: string): Promise<ResolvedInvite | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const [manual] = await db.select().from(competitions).where(eq(competitions.inviteToken, trimmed));
  if (manual) return { kind: 'manual', competition: manual };

  const [live] = await db
    .select()
    .from(liveCompetitions)
    .where(eq(liveCompetitions.inviteToken, trimmed));
  if (live) return { kind: 'live', competition: live };

  return null;
}
