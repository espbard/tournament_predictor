import { Router } from 'express';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  CreateLiveTournamentSchema,
  LIVE_FORMATS,
  LIVE_TOURNAMENT_PRESETS,
  ListLiveFixturesQuerySchema,
  SyncLiveTournamentSchema,
  UpdateLiveTournamentSchema,
  getLiveFormat,
  isStageAtOrAfter,
} from '@tournament-predictor/shared';
import { db } from '../../db/client';
import { liveFixtures, liveStandings, liveTeams, liveTournaments } from '../../db/liveSchema';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { syncLiveWindow, syncTournamentStructure } from '../sync';

// ── Live tournament API ───────────────────────────────────────────────────────
//
// Mounted at /api/live. Reads are open to any signed-in user; anything that creates,
// changes or triggers work is admin-only, matching the manual tournament routes.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §10.

export const liveTournamentsRouter = Router();

function fail(res: Parameters<typeof requireAuth>[1], err: unknown) {
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

// ── Static metadata ───────────────────────────────────────────────────────────

/** The "ready-made connections" dropdown for the create form. */
liveTournamentsRouter.get('/presets', requireAdmin, async (_req, res) => {
  return res.json(LIVE_TOURNAMENT_PRESETS);
});

/** Stage definitions, so the client can render a format-driven fixtures tab. */
liveTournamentsRouter.get('/formats', requireAuth, async (_req, res) => {
  return res.json(LIVE_FORMATS);
});

// ── Tournaments ───────────────────────────────────────────────────────────────

liveTournamentsRouter.get('/tournaments', requireAuth, async (_req, res) => {
  try {
    const rows = await db.select().from(liveTournaments).orderBy(asc(liveTournaments.createdAt));
    return res.json(rows);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Create from a preset and populate immediately.
 *
 * The structure sync runs inline so the admin sees a fully populated tournament rather
 * than an empty shell that fills in some time later. It is allowed to come back empty:
 * a competition whose season the provider has not published yet is a valid, expected
 * state, reported through `syncSeasonUnavailable` rather than as a failure.
 */
liveTournamentsRouter.post('/tournaments', requireAdmin, async (req, res) => {
  try {
    const parsed = CreateLiveTournamentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const preset = LIVE_TOURNAMENT_PRESETS.find(p => p.key === parsed.data.presetKey);
    if (!preset) return res.status(400).json({ error: 'Unknown preset' });

    const [existing] = await db
      .select({ id: liveTournaments.id })
      .from(liveTournaments)
      .where(
        and(
          eq(liveTournaments.provider, preset.provider),
          eq(liveTournaments.providerCompetitionId, preset.providerCompetitionId),
          eq(liveTournaments.season, preset.season),
        ),
      );
    if (existing) {
      return res.status(409).json({ error: 'That competition and season already exists' });
    }

    const [created] = await db
      .insert(liveTournaments)
      .values({
        id: generateId(15),
        name: parsed.data.name?.trim() || preset.defaultName,
        imageUrl: parsed.data.imageUrl ?? preset.defaultImageUrl ?? null,
        presetKey: preset.key,
        provider: preset.provider,
        providerCompetitionId: preset.providerCompetitionId,
        season: preset.season,
        format: preset.format,
        startStageKey: preset.startStageKey,
      })
      .returning();

    try {
      const result = await syncTournamentStructure(created.id);
      const [populated] = await db
        .select()
        .from(liveTournaments)
        .where(eq(liveTournaments.id, created.id));
      return res.status(201).json({
        ...populated,
        syncSeasonUnavailable: result.seasonUnavailable,
        syncedTeams: result.teams,
        syncedFixtures: result.fixtures,
        syncedStandings: result.standings,
        unmappedStages: result.unmappedStages,
      });
    } catch (err) {
      // The tournament exists and the error is recorded on it; the admin can retry the
      // sync from the detail page rather than having to recreate it.
      console.error('Initial sync failed:', err);
      const [row] = await db
        .select()
        .from(liveTournaments)
        .where(eq(liveTournaments.id, created.id));
      return res.status(201).json({ ...row, syncFailed: true });
    }
  } catch (err) {
    return fail(res, err);
  }
});

liveTournamentsRouter.get('/tournaments/:id', requireAuth, async (req, res) => {
  try {
    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const teams = await db
      .select()
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, tournament.id));

    const fixtures = await db
      .select({
        stageKey: liveFixtures.stageKey,
        providerStage: liveFixtures.providerStage,
        status: liveFixtures.status,
        normalTimeHome: liveFixtures.normalTimeHome,
      })
      .from(liveFixtures)
      .where(eq(liveFixtures.liveTournamentId, tournament.id));

    const preset = LIVE_TOURNAMENT_PRESETS.find(p => p.key === tournament.presetKey);

    // A finished fixture with no normal-time score cannot be scored — surfaced so an
    // admin can see it rather than wondering why nobody got points.
    const unscorableFixtures = fixtures.filter(
      f => f.status === 'finished' && f.normalTimeHome === null,
    ).length;

    return res.json({
      ...tournament,
      teamCount: teams.length,
      qualifiedCount: teams.filter(t => t.qualificationStatus === 'qualified').length,
      expectedTeamCount: preset?.expectedTeamCount ?? null,
      fixtureCount: fixtures.length,
      unscorableFixtures,
      // Distinct provider stage strings the format does not know: the early warning for
      // a provider rename, which would otherwise silently strand fixtures.
      unmappedStages: [
        ...new Set(
          fixtures.filter(f => f.stageKey === null && f.providerStage).map(f => f.providerStage!),
        ),
      ],
    });
  } catch (err) {
    return fail(res, err);
  }
});

liveTournamentsRouter.patch('/tournaments/:id', requireAdmin, async (req, res) => {
  try {
    const parsed = UpdateLiveTournamentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.imageUrl !== undefined) update.imageUrl = parsed.data.imageUrl;
    if (parsed.data.status !== undefined) update.status = parsed.data.status;
    if (parsed.data.syncEnabled !== undefined) update.syncEnabled = parsed.data.syncEnabled;
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const [row] = await db
      .update(liveTournaments)
      .set(update)
      .where(eq(liveTournaments.id, req.params.id))
      .returning();
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json(row);
  } catch (err) {
    return fail(res, err);
  }
});

liveTournamentsRouter.delete('/tournaments/:id', requireAdmin, async (req, res) => {
  try {
    const [row] = await db
      .delete(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id))
      .returning({ id: liveTournaments.id });
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

/** Sync on demand. `{full: true}` pulls teams and standings too, not just fixtures. */
liveTournamentsRouter.post('/tournaments/:id/sync', requireAdmin, async (req, res) => {
  try {
    const parsed = SyncLiveTournamentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const [tournament] = await db
      .select({ id: liveTournaments.id })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const result = parsed.data.full
      ? await syncTournamentStructure(tournament.id)
      : await syncLiveWindow(tournament.id);
    return res.json(result);
  } catch (err) {
    // A provider failure is the expected error here and is worth reporting verbatim, so
    // an admin can tell a rate limit apart from a bad key without reading server logs.
    console.error(err);
    return res.status(502).json({
      error: 'Provider sync failed',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Sub-resources ─────────────────────────────────────────────────────────────

liveTournamentsRouter.get('/tournaments/:id/teams', requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(liveTeams)
      .where(eq(liveTeams.liveTournamentId, req.params.id))
      .orderBy(asc(liveTeams.name));
    return res.json(rows);
  } catch (err) {
    return fail(res, err);
  }
});

liveTournamentsRouter.get('/tournaments/:id/fixtures', requireAuth, async (req, res) => {
  try {
    const parsed = ListLiveFixturesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    }

    const [tournament] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const filters = [eq(liveFixtures.liveTournamentId, tournament.id)];
    if (parsed.data.stageKey) filters.push(eq(liveFixtures.stageKey, parsed.data.stageKey));
    if (parsed.data.matchday) filters.push(eq(liveFixtures.matchday, parsed.data.matchday));
    if (parsed.data.status) filters.push(eq(liveFixtures.status, parsed.data.status));
    if (parsed.data.from) filters.push(gte(liveFixtures.kickoffAt, new Date(parsed.data.from)));
    if (parsed.data.to) filters.push(lte(liveFixtures.kickoffAt, new Date(parsed.data.to)));

    const rows = await db
      .select()
      .from(liveFixtures)
      .where(and(...filters))
      .orderBy(asc(liveFixtures.kickoffAt), asc(liveFixtures.providerFixtureId));

    // Resolve teams in one query rather than joining twice for home and away.
    const teamIds = [
      ...new Set(rows.flatMap(r => [r.homeTeamId, r.awayTeamId]).filter((id): id is string => !!id)),
    ];
    const teams = teamIds.length
      ? await db.select().from(liveTeams).where(inArray(liveTeams.id, teamIds))
      : [];
    const teamById = new Map(teams.map(t => [t.id, t]));

    const format = getLiveFormat(tournament.format);
    return res.json(
      rows.map(r => ({
        ...r,
        homeTeam: r.homeTeamId ? teamById.get(r.homeTeamId) ?? null : null,
        awayTeam: r.awayTeamId ? teamById.get(r.awayTeamId) ?? null : null,
        // Stages below startStageKey are ingested but never predicted on.
        isPredictable: isStageAtOrAfter(format, r.stageKey, tournament.startStageKey),
      })),
    );
  } catch (err) {
    return fail(res, err);
  }
});

liveTournamentsRouter.get('/tournaments/:id/standings', requireAuth, async (req, res) => {
  try {
    const stageKey = typeof req.query.stageKey === 'string' ? req.query.stageKey : null;
    const filters = [eq(liveStandings.liveTournamentId, req.params.id)];
    if (stageKey) filters.push(eq(liveStandings.stageKey, stageKey));

    const rows = await db
      .select()
      .from(liveStandings)
      .where(and(...filters))
      .orderBy(asc(liveStandings.stageKey), asc(liveStandings.position));

    const teamIds = [...new Set(rows.map(r => r.teamId))];
    const teams = teamIds.length
      ? await db.select().from(liveTeams).where(inArray(liveTeams.id, teamIds))
      : [];
    const teamById = new Map(teams.map(t => [t.id, t]));

    return res.json(rows.map(r => ({ ...r, team: teamById.get(r.teamId) ?? null })));
  } catch (err) {
    return fail(res, err);
  }
});
