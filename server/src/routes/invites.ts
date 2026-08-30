import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { competitionMembers, tournaments } from '../db/schema.js';
import { liveCompetitionMembers, liveTournaments } from '../db/liveSchema.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { resolveInviteToken } from '../lib/inviteLinks.js';
import { joinLiveCompetition, joinManualCompetition } from '../lib/competitionJoin.js';
import type { InviteAcceptResult, InvitePreview } from '@tournament-predictor/shared';

// ── Invite links ──────────────────────────────────────────────────────────────
//
// The receiving end of a competition share link. The token says which competition and
// which tournament type, so a link works for both without the visitor knowing either.
//
//   GET  /api/invites/:token         — what the link points at (no account needed)
//   POST /api/invites/:token/accept  — join it (account needed)
//
// Minting a link is the competition's own business and lives with it:
// POST /api/competitions/:id/invite and POST /api/live/competitions/:id/invite.

export const invitesRouter = Router();

/**
 * The preview an invite link renders.
 *
 * Deliberately readable while signed out: whoever holds the link is meant to be able to
 * see what they are being invited to before making an account. It exposes nothing beyond
 * the competition's name, logo and tournament — no members, no codes, no predictions.
 */
invitesRouter.get('/:token', optionalAuth, async (req, res) => {
  try {
    const resolved = await resolveInviteToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'This invite link is not valid' });

    const user = res.locals.user as { id: string } | undefined;

    if (resolved.kind === 'manual') {
      const [tournament] = await db
        .select({ name: tournaments.name })
        .from(tournaments)
        .where(eq(tournaments.id, resolved.competition.tournamentId));
      const preview: InvitePreview = {
        kind: 'manual',
        competitionId: resolved.competition.id,
        competitionName: resolved.competition.name,
        imageUrl: resolved.competition.imageUrl ?? null,
        tournamentName: tournament?.name ?? null,
        isMember: user ? await isManualMember(resolved.competition.id, user.id) : false,
      };
      return res.json(preview);
    }

    const [tournament] = await db
      .select({ name: liveTournaments.name })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, resolved.competition.liveTournamentId));
    const preview: InvitePreview = {
      kind: 'live',
      competitionId: resolved.competition.id,
      competitionName: resolved.competition.name,
      imageUrl: resolved.competition.imageUrl ?? null,
      tournamentName: tournament?.name ?? null,
      isMember: user ? await isLiveMember(resolved.competition.id, user.id) : false,
    };
    return res.json(preview);
  } catch (err) {
    console.error('Invite preview error:', err);
    return res.status(500).json({ error: 'Failed to load invite' });
  }
});

/**
 * Join whatever the link points at.
 *
 * A member opening their own link again is not an error — the same join rules apply as
 * for the invite code, and the response says where to go either way.
 */
invitesRouter.post('/:token/accept', requireAuth, async (req, res) => {
  try {
    const resolved = await resolveInviteToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'This invite link is not valid' });

    const userId: string = res.locals.user.id;
    const result =
      resolved.kind === 'manual'
        ? await joinManualCompetition(resolved.competition, userId)
        : await joinLiveCompetition(resolved.competition, userId);

    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const body: InviteAcceptResult = {
      kind: resolved.kind,
      competitionId: resolved.competition.id,
    };
    return res.json(body);
  } catch (err) {
    console.error('Invite accept error:', err);
    return res.status(500).json({ error: 'Failed to join competition' });
  }
});

async function isManualMember(competitionId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: competitionMembers.userId })
    .from(competitionMembers)
    .where(and(eq(competitionMembers.competitionId, competitionId), eq(competitionMembers.userId, userId)));
  return !!row;
}

async function isLiveMember(competitionId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: liveCompetitionMembers.id })
    .from(liveCompetitionMembers)
    .where(
      and(
        eq(liveCompetitionMembers.liveCompetitionId, competitionId),
        eq(liveCompetitionMembers.userId, userId),
      ),
    );
  return !!row;
}
