import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { tournaments, teams, matches, groups } from '../db/schema';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  CreateTournamentSchema,
  UpdateTournamentSchema,
  CreateTeamSchema,
  UpdateTeamSchema,
  CreateMatchSchema,
  UpdateMatchSchema,
  CreateGroupSchema,
  UpdateKnockoutConfigSchema,
} from '@tournament-predictor/shared';
import type { KnockoutConfig } from '@tournament-predictor/shared';

export const tournamentsRouter = Router();
export const matchesRouter = Router();
export const teamsRouter = Router();

tournamentsRouter.get('/', requireAuth, async (_req, res) => {
  try {
    const all = await db.select().from(tournaments).orderBy(tournaments.createdAt);
    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, imageUrl } = CreateTournamentSchema.parse(req.body);
    const id = crypto.randomUUID();
    const [tournament] = await db
      .insert(tournaments)
      .values({ id, name, imageUrl: imageUrl ?? null })
      .returning();
    return res.status(201).json(tournament);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    return res.json(tournament);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const updates = UpdateTournamentSchema.parse(req.body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const [updated] = await db
      .update(tournaments)
      .set(updates)
      .where(eq(tournaments.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Tournament not found' });
    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id/teams', requireAuth, async (req, res) => {
  try {
    const all = await db
      .select()
      .from(teams)
      .where(eq(teams.tournamentId, req.params.id));
    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/teams', requireAdmin, async (req, res) => {
  try {
    const { name, groupId, imageUrl } = CreateTeamSchema.parse(req.body);
    const [exists] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const id = crypto.randomUUID();
    const [team] = await db
      .insert(teams)
      .values({ id, tournamentId: req.params.id, name, groupId: groupId ?? null, imageUrl: imageUrl ?? null })
      .returning();
    return res.status(201).json(team);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id/matches', requireAuth, async (req, res) => {
  try {
    const matchRows = await db
      .select()
      .from(matches)
      .where(eq(matches.tournamentId, req.params.id));

    const teamIds = [
      ...new Set(
        matchRows
          .flatMap(m => [m.homeTeamId, m.awayTeamId])
          .filter((tid): tid is string => tid !== null)
      ),
    ];

    const teamRows =
      teamIds.length > 0
        ? await db.select().from(teams).where(inArray(teams.id, teamIds))
        : [];

    const teamMap = new Map(teamRows.map(t => [t.id, { name: t.name, imageUrl: t.imageUrl, groupId: t.groupId }]));

    const groupIds = [...new Set(teamRows.map(t => t.groupId).filter((id): id is string => id !== null))];
    const groupRows = groupIds.length > 0
      ? await db.select().from(groups).where(inArray(groups.id, groupIds))
      : [];
    const groupMap = new Map(groupRows.map(g => [g.id, g.name]));

    return res.json(
      matchRows.map(m => {
        const homeGroupId = m.homeTeamId ? (teamMap.get(m.homeTeamId)?.groupId ?? null) : null;
        const groupName = homeGroupId ? (groupMap.get(homeGroupId) ?? null) : null;
        return {
          ...m,
          homeTeamName: m.homeTeamId ? (teamMap.get(m.homeTeamId)?.name ?? null) : null,
          awayTeamName: m.awayTeamId ? (teamMap.get(m.awayTeamId)?.name ?? null) : null,
          homeTeamImageUrl: m.homeTeamId ? (teamMap.get(m.homeTeamId)?.imageUrl ?? null) : null,
          awayTeamImageUrl: m.awayTeamId ? (teamMap.get(m.awayTeamId)?.imageUrl ?? null) : null,
          groupName,
        };
      })
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/matches', requireAdmin, async (req, res) => {
  try {
    const { homeTeamId, awayTeamId, stage, scheduledAt } = CreateMatchSchema.parse(req.body);
    const [exists] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const id = crypto.randomUUID();
    const [match] = await db
      .insert(matches)
      .values({
        id,
        tournamentId: req.params.id,
        homeTeamId: homeTeamId ?? null,
        awayTeamId: awayTeamId ?? null,
        stage,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      })
      .returning();
    return res.status(201).json(match);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.get('/:id/groups', requireAuth, async (req, res) => {
  try {
    const all = await db
      .select()
      .from(groups)
      .where(eq(groups.tournamentId, req.params.id))
      .orderBy(groups.name);
    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.post('/:id/groups', requireAdmin, async (req, res) => {
  try {
    const { name } = CreateGroupSchema.parse(req.body);
    const [exists] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const id = crypto.randomUUID();
    const [group] = await db
      .insert(groups)
      .values({ id, tournamentId: req.params.id, name })
      .returning();
    return res.status(201).json(group);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.patch('/:id/knockout-config', requireAdmin, async (req, res) => {
  try {
    const body = UpdateKnockoutConfigSchema.parse(req.body);
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const existing: KnockoutConfig = (tournament.knockoutConfig as KnockoutConfig | null) ?? {
      firstRound: 'round_of_16',
      hasBronzeFinal: false,
      directQualifiers: 2,
      luckyLosers: 0,
      bracketSlots: {},
    };

    const merged: KnockoutConfig = { ...existing, ...body };

    const [updated] = await db
      .update(tournaments)
      .set({ knockoutConfig: merged })
      .where(eq(tournaments.id, req.params.id))
      .returning();

    return res.json(updated.knockoutConfig);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

tournamentsRouter.delete('/:id/groups/:groupId', requireAdmin, async (req, res) => {
  try {
    const [deleted] = await db
      .delete(groups)
      .where(eq(groups.id, req.params.groupId))
      .returning();
    if (!deleted) return res.status(404).json({ error: 'Group not found' });
    return res.json(deleted);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

matchesRouter.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const updates = UpdateMatchSchema.parse(req.body);
    const setData: Record<string, unknown> = {};
    if (updates.homeTeamId !== undefined) setData.homeTeamId = updates.homeTeamId;
    if (updates.awayTeamId !== undefined) setData.awayTeamId = updates.awayTeamId;
    if (updates.stage !== undefined) setData.stage = updates.stage;
    if (updates.scheduledAt !== undefined) {
      setData.scheduledAt = updates.scheduledAt ? new Date(updates.scheduledAt) : null;
    }
    if (updates.homeScore !== undefined && updates.awayScore !== undefined) {
      setData.homeScore = updates.homeScore;
      setData.awayScore = updates.awayScore;
      setData.status = 'completed';
    }
    if (Object.keys(setData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const [updated] = await db
      .update(matches)
      .set(setData)
      .where(eq(matches.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Match not found' });
    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

teamsRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const [team] = await db
      .select()
      .from(teams)
      .where(eq(teams.id, req.params.id))
      .limit(1);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    return res.json(team);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

teamsRouter.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const updates = UpdateTeamSchema.parse(req.body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const [updated] = await db
      .update(teams)
      .set(updates)
      .where(eq(teams.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Team not found' });
    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
