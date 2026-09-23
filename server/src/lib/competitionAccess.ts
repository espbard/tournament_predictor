import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { competitionMembers, competitions } from '../db/schema.js';
import { liveCompetitionMembers, liveCompetitions } from '../db/liveSchema.js';

// ── Who may read a competition ────────────────────────────────────────────────
//
// Two levels, for both tournament types:
//
// - **Member** (or admin): may read everything and — members only — predict. Every route
//   that writes, or that reads the caller's *own* predictions, keeps checking membership.
// - **Viewer**: a member, an admin, or — when the competition is public — any signed-in
//   user.
//   Read-only routes about the competition as a whole (leaderboard, members, other
//   people's predictions, stats) check this instead.
//
// Being public changes nothing about joining: the invite code, the share link and the
// deadlines in competitionJoin.ts decide that, exactly as before.

type Viewer = { id: string; isAdmin: boolean };

export async function isManualMember(competitionId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ userId: competitionMembers.userId })
    .from(competitionMembers)
    .where(and(eq(competitionMembers.competitionId, competitionId), eq(competitionMembers.userId, userId)))
    .limit(1);
  return !!membership;
}

/** Admin, member, or the competition is public. A missing competition is not viewable. */
export async function canViewManualCompetition(competitionId: string, user: Viewer): Promise<boolean> {
  if (user.isAdmin) return true;
  if (await isManualMember(competitionId, user.id)) return true;
  const [row] = await db
    .select({ isPublic: competitions.isPublic })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);
  return !!row?.isPublic;
}

export async function isLiveMember(competitionId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: liveCompetitionMembers.id })
    .from(liveCompetitionMembers)
    .where(
      and(
        eq(liveCompetitionMembers.liveCompetitionId, competitionId),
        eq(liveCompetitionMembers.userId, userId),
      ),
    )
    .limit(1);
  return !!membership;
}

/** Admin, member, or the live competition is public. */
export async function canViewLiveCompetition(competitionId: string, user: Viewer): Promise<boolean> {
  if (user.isAdmin) return true;
  if (await isLiveMember(competitionId, user.id)) return true;
  const [row] = await db
    .select({ isPublic: liveCompetitions.isPublic })
    .from(liveCompetitions)
    .where(eq(liveCompetitions.id, competitionId))
    .limit(1);
  return !!row?.isPublic;
}
