import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { tournaments, teams, matches } from '../db/schema';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  CreateTournamentSchema,
  UpdateTournamentSchema,
  CreateTeamSchema,
  CreateMatchSchema,
  UpdateMatchSchema,
} from '@tournament-predictor/shared';

export const tournamentsRouter = Router();
export const matchesRouter = Router();

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
    const { name } = CreateTournamentSchema.parse(req.body);
    const id = crypto.randomUUID();
    const [tournament] = await db.insert(tournaments).values({ id, name }).returning();
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
    const { name, group } = CreateTeamSchema.parse(req.body);
    const [exists] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, req.params.id))
      .limit(1);
    if (!exists) return res.status(404).json({ error: 'Tournament not found' });

    const id = crypto.randomUUID();
    const [team] = await db
      .insert(teams)
      .values({ id, tournamentId: req.params.id, name, group: group ?? null })
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

    const teamMap = new Map(teamRows.map(t => [t.id, t.name]));

    return res.json(
      matchRows.map(m => ({
        ...m,
        homeTeamName: m.homeTeamId ? (teamMap.get(m.homeTeamId) ?? null) : null,
        awayTeamName: m.awayTeamId ? (teamMap.get(m.awayTeamId) ?? null) : null,
      }))
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

matchesRouter.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { homeScore, awayScore } = UpdateMatchSchema.parse(req.body);
    const [updated] = await db
      .update(matches)
      .set({ homeScore, awayScore, status: 'completed' })
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
