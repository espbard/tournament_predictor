import { Router } from 'express';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { generateId } from 'lucia';
import {
  CreateLiveBonusQuestionSchema,
  CreateLiveTournamentSchema,
  LIVE_FORMATS,
  LIVE_TOURNAMENT_PRESETS,
  ListLiveFixturesQuerySchema,
  SaveLiveGameweekSelectionSchema,
  SyncLiveTournamentSchema,
  UpdateLiveBonusQuestionSchema,
  UpdateLiveTournamentSchema,
  getLiveFormat,
  isLiveFixtureSelected,
  isStageAtOrAfter,
  summariseLiveGameweeks,
} from '@tournament-predictor/shared';
import { db } from '../../db/client';
import {
  liveBonusQuestions,
  liveCompetitions,
  liveFixtures,
  liveGameweekSelections,
  livePredictions,
  liveStandings,
  liveTeams,
  liveTournaments,
} from '../../db/liveSchema';
import { requireAdmin, requireAuth } from '../../middleware/auth';
import { notifyLiveCompetitions } from '../liveEvents';
import { scoreAllLiveBonusQuestions, scoreLiveBonusQuestion } from '../bonusScoring';
import { redactLiveBonusQuestions } from '../bonusVisibility';
import { recalculateLiveTournament, recomputeLiveMemberTotals } from '../scoringTrigger';
import { diagnoseTournamentFixtures } from '../diagnostics';
import { loadSelectionIndex } from '../selections';
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
        id: liveFixtures.id,
        stageKey: liveFixtures.stageKey,
        matchday: liveFixtures.matchday,
        providerStage: liveFixtures.providerStage,
        status: liveFixtures.status,
        normalTimeHome: liveFixtures.normalTimeHome,
        homeTeamId: liveFixtures.homeTeamId,
        awayTeamId: liveFixtures.awayTeamId,
        kickoffAt: liveFixtures.kickoffAt,
      })
      .from(liveFixtures)
      .where(eq(liveFixtures.liveTournamentId, tournament.id));

    const preset = LIVE_TOURNAMENT_PRESETS.find(p => p.key === tournament.presetKey);

    // A finished fixture with no normal-time score cannot be scored — surfaced so an
    // admin can see it rather than wondering why nobody got points. A match left out of
    // its gameweek's selection was never going to score, so it is not a problem to report.
    const selections = await loadSelectionIndex(tournament.id);
    const unscorableFixtures = fixtures.filter(
      f =>
        f.status === 'finished' &&
        f.normalTimeHome === null &&
        isLiveFixtureSelected(f, selections),
    ).length;

    return res.json({
      ...tournament,
      teamCount: teams.length,
      qualifiedCount: teams.filter(t => t.qualificationStatus === 'qualified').length,
      expectedTeamCount: preset?.expectedTeamCount ?? null,
      fixtureCount: fixtures.length,
      unscorableFixtures,
      fixtureProviderCompetitionId: tournament.fixtureProviderCompetitionId,
      // A fixture with a kickoff time but no team on one side. Undrawn knockout slots
      // legitimately look like this, so it only counts once a fixture has a date — and
      // with a split fixture provider it is how a failed name match surfaces.
      fixturesMissingTeams: fixtures.filter(
        f => f.kickoffAt !== null && (f.homeTeamId === null || f.awayTeamId === null),
      ).length,
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

    const [current] = await db
      .select()
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!current) return res.status(404).json({ error: 'Not found' });

    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.imageUrl !== undefined) update.imageUrl = parsed.data.imageUrl;
    if (parsed.data.status !== undefined) update.status = parsed.data.status;
    if (parsed.data.syncEnabled !== undefined) update.syncEnabled = parsed.data.syncEnabled;
    if (parsed.data.fixtureProvider !== undefined) update.fixtureProvider = parsed.data.fixtureProvider;
    if (parsed.data.fixtureProviderCompetitionId !== undefined) {
      update.fixtureProviderCompetitionId = parsed.data.fixtureProviderCompetitionId;
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    // Fixtures are keyed by (tournament, provider_fixture_id) and two providers do not
    // agree on those ids, so the rows the old provider wrote cannot be updated by the new
    // one — they would sit alongside a second, duplicate set of the same matches. They
    // are cleared instead. Predictions cascade from fixtures, so a tournament that has
    // any is not something to do silently: the switch is refused and the admin is told.
    const nextFixtureProvider =
      parsed.data.fixtureProvider !== undefined ? parsed.data.fixtureProvider : current.fixtureProvider;
    const providerChanged =
      (nextFixtureProvider ?? current.provider) !== (current.fixtureProvider ?? current.provider);

    if (providerChanged) {
      const [predicted] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(livePredictions)
        .innerJoin(liveFixtures, eq(livePredictions.liveFixtureId, liveFixtures.id))
        .where(eq(liveFixtures.liveTournamentId, current.id));

      if ((predicted?.count ?? 0) > 0) {
        return res.status(409).json({
          error:
            `Cannot change the fixture provider: ${predicted!.count} prediction(s) are attached ` +
            'to the current fixtures, and switching provider replaces them. Clear the ' +
            'predictions first if this is really what you want.',
        });
      }
    }

    const [row] = await db
      .update(liveTournaments)
      .set(update)
      .where(eq(liveTournaments.id, req.params.id))
      .returning();
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (providerChanged) {
      await db.delete(liveFixtures).where(eq(liveFixtures.liveTournamentId, row.id));
    }

    // Bonus points are withheld while a tournament is still running, so the status change
    // is what awards them — and moving a tournament back out of `completed` takes them
    // away again. Either way the answers, and the totals they feed, are rebuilt here.
    if (parsed.data.status !== undefined) {
      const scored = await scoreAllLiveBonusQuestions(row.id);
      if (scored.affectedCompetitionIds.length > 0) {
        await recomputeLiveMemberTotals(scored.affectedCompetitionIds);
        notifyLiveCompetitions(scored.affectedCompetitionIds, 'leaderboard-updated');
      }
    }

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

/**
 * What does the provider actually return for this tournament?
 *
 * The one honest answer to "why are there no fixtures": five requests, each reported
 * with its URL, status and count, plus what the database holds. Admin-only, read-only,
 * and it spends half a minute's request budget — so it is a button, not a poll.
 */
liveTournamentsRouter.post('/tournaments/:id/diagnose', requireAdmin, async (req, res) => {
  try {
    return res.json(await diagnoseTournamentFixtures(req.params.id));
  } catch (err) {
    console.error(err);
    return res.status(502).json({
      error: 'Diagnostic failed',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Rebuild scores for every competition on this tournament.
 *
 * Needed after a scoringConfig change, or if a fixture's stored result is corrected.
 */
liveTournamentsRouter.post('/tournaments/:id/recalculate', requireAdmin, async (req, res) => {
  try {
    const [tournament] = await db
      .select({ id: liveTournaments.id })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const result = await recalculateLiveTournament(tournament.id);
    return res.json(result);
  } catch (err) {
    return fail(res, err);
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
    const selections = await loadSelectionIndex(tournament.id);
    return res.json(
      rows.map(r => ({
        ...r,
        homeTeam: r.homeTeamId ? teamById.get(r.homeTeamId) ?? null : null,
        awayTeam: r.awayTeamId ? teamById.get(r.awayTeamId) ?? null : null,
        // Stages below startStageKey are ingested but never predicted on.
        isPredictable: isStageAtOrAfter(format, r.stageKey, tournament.startStageKey),
        isSelected: isLiveFixtureSelected(r, selections),
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

// ── Selected matches ──────────────────────────────────────────────────────────
//
// The admin picks which fixtures of a gameweek users predict on. Everything not picked is
// ignored: no inputs, no points. A gameweek nobody has touched has nothing selected, so a
// tournament is not playable until an admin has been through it.
//
// See shared/src/live/selection.ts for the rule itself.

/** Every gameweek in the tournament, with how many of its fixtures are selected. */
liveTournamentsRouter.get('/tournaments/:id/selected-matches', requireAuth, async (req, res) => {
  try {
    const [tournament] = await db
      .select({ id: liveTournaments.id })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const fixtures = await db
      .select({
        id: liveFixtures.id,
        stageKey: liveFixtures.stageKey,
        matchday: liveFixtures.matchday,
        status: liveFixtures.status,
      })
      .from(liveFixtures)
      .where(eq(liveFixtures.liveTournamentId, tournament.id));

    const selections = await loadSelectionIndex(tournament.id);
    return res.json(summariseLiveGameweeks(fixtures, selections));
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Register one gameweek's selection.
 *
 * `fixtureIds: null` (or an empty list) clears the gameweek back to its default of nothing
 * selected, which is why it deletes the row rather than storing an empty one — under that
 * default the two are the same thing.
 *
 * Scores are rebuilt afterwards: a fixture that has just been deselected must give back
 * the points it awarded, and one that has just been selected must award the points it
 * already earned. Doing it here rather than leaving it to the next sync means the
 * leaderboard is never briefly wrong.
 */
liveTournamentsRouter.put('/tournaments/:id/selected-matches', requireAdmin, async (req, res) => {
  try {
    const parsed = SaveLiveGameweekSelectionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const [tournament] = await db
      .select({ id: liveTournaments.id })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const { stageKey, matchday, fixtureIds } = parsed.data;
    const gameweekFixtures = await db
      .select({ id: liveFixtures.id })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, tournament.id),
          eq(liveFixtures.stageKey, stageKey),
          eq(liveFixtures.matchday, matchday),
        ),
      );
    if (gameweekFixtures.length === 0) {
      return res.status(404).json({ error: 'That gameweek has no fixtures' });
    }

    // Duplicates in the request would make selectedCount disagree with the real number of
    // selected fixtures, so normalise before storing.
    const requested = [...new Set(fixtureIds ?? [])];
    const gameweekFixtureIds = new Set(gameweekFixtures.map(f => f.id));
    const stray = requested.filter(id => !gameweekFixtureIds.has(id));
    if (stray.length > 0) {
      return res.status(400).json({
        error: 'Those fixtures are not in this gameweek',
        fixtureIds: stray,
      });
    }

    const now = new Date();
    let selection = null;
    if (requested.length === 0) {
      await db
        .delete(liveGameweekSelections)
        .where(
          and(
            eq(liveGameweekSelections.liveTournamentId, tournament.id),
            eq(liveGameweekSelections.stageKey, stageKey),
            eq(liveGameweekSelections.matchday, matchday),
          ),
        );
    } else {
      [selection] = await db
        .insert(liveGameweekSelections)
        .values({
          id: generateId(15),
          liveTournamentId: tournament.id,
          stageKey,
          matchday,
          selectedFixtureIds: requested,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            liveGameweekSelections.liveTournamentId,
            liveGameweekSelections.stageKey,
            liveGameweekSelections.matchday,
          ],
          set: { selectedFixtureIds: requested, updatedAt: now },
        })
        .returning();
    }

    const recalculated = await recalculateLiveTournament(tournament.id);

    // Both the fixture list and the leaderboard can have changed under anyone with the
    // competition open.
    const competitions = await db
      .select({ id: liveCompetitions.id })
      .from(liveCompetitions)
      .where(eq(liveCompetitions.liveTournamentId, tournament.id));
    if (competitions.length > 0) {
      const ids = competitions.map(c => c.id);
      notifyLiveCompetitions(ids, 'fixtures-updated');
      notifyLiveCompetitions(ids, 'leaderboard-updated');
    }

    return res.json({
      selection,
      isCustomised: selection !== null,
      // No row means nothing is selected, so there is nothing to echo back.
      selectedFixtureIds: selection ? selection.selectedFixtureIds : [],
      fixtureCount: gameweekFixtures.length,
      scoredPredictions: recalculated.scoredPredictions,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ── Bonus questions ───────────────────────────────────────────────────────────
//
// Season-long side bets, defined on the tournament so every league playing it asks the
// same ones — exactly how the manual type works. Answers, and the points they earn, live
// on the competition; see routes/competitions.ts.
//
// A correct answer is invisible to non-admins until the tournament is marked completed,
// which is also the moment the points it implies are actually awarded.

/** The tournament's questions. Correct answers are redacted until completion. */
liveTournamentsRouter.get('/tournaments/:id/bonus-questions', requireAuth, async (req, res) => {
  try {
    const [tournament] = await db
      .select({ id: liveTournaments.id, status: liveTournaments.status })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const questions = await db
      .select()
      .from(liveBonusQuestions)
      .where(eq(liveBonusQuestions.liveTournamentId, tournament.id))
      .orderBy(asc(liveBonusQuestions.createdAt));

    return res.json(
      redactLiveBonusQuestions(
        questions,
        res.locals.user.isAdmin,
        tournament.status === 'completed',
      ),
    );
  } catch (err) {
    return fail(res, err);
  }
});

liveTournamentsRouter.post('/tournaments/:id/bonus-questions', requireAdmin, async (req, res) => {
  try {
    const parsed = CreateLiveBonusQuestionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const [tournament] = await db
      .select({ id: liveTournaments.id })
      .from(liveTournaments)
      .where(eq(liveTournaments.id, req.params.id));
    if (!tournament) return res.status(404).json({ error: 'Not found' });

    const [created] = await db
      .insert(liveBonusQuestions)
      .values({
        id: generateId(15),
        liveTournamentId: tournament.id,
        question: parsed.data.question.trim(),
        answerType: parsed.data.answerType,
        points: parsed.data.points,
        lockAt: parsed.data.lockAt ? new Date(parsed.data.lockAt) : null,
        minValue: parsed.data.minValue ?? null,
        maxValue: parsed.data.maxValue ?? null,
        leeway: parsed.data.leeway ?? null,
        // An empty list means "no restriction", which is what null stores.
        options: parsed.data.options?.length ? parsed.data.options : null,
      })
      .returning();

    return res.status(201).json(created);
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * Edit a question, or record its correct answer.
 *
 * Setting the correct answer scores it — but only if the tournament is already completed.
 * Before that the answer is stored and scoring is deferred, so nobody can infer it from a
 * leaderboard that moved.
 */
liveTournamentsRouter.patch(
  '/tournaments/:id/bonus-questions/:questionId',
  requireAdmin,
  async (req, res) => {
    try {
      const parsed = UpdateLiveBonusQuestionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      }

      const [existing] = await db
        .select()
        .from(liveBonusQuestions)
        .where(
          and(
            eq(liveBonusQuestions.id, req.params.questionId),
            eq(liveBonusQuestions.liveTournamentId, req.params.id),
          ),
        );
      if (!existing) return res.status(404).json({ error: 'Question not found' });

      const update: Record<string, unknown> = {};
      if (parsed.data.question !== undefined) update.question = parsed.data.question.trim();
      if (parsed.data.answerType !== undefined) update.answerType = parsed.data.answerType;
      if (parsed.data.points !== undefined) update.points = parsed.data.points;
      if (parsed.data.correctAnswer !== undefined) update.correctAnswer = parsed.data.correctAnswer;
      if (parsed.data.lockAt !== undefined) {
        update.lockAt = parsed.data.lockAt ? new Date(parsed.data.lockAt) : null;
      }
      if (parsed.data.minValue !== undefined) update.minValue = parsed.data.minValue;
      if (parsed.data.maxValue !== undefined) update.maxValue = parsed.data.maxValue;
      if (parsed.data.leeway !== undefined) update.leeway = parsed.data.leeway;
      if (parsed.data.options !== undefined) {
        update.options = parsed.data.options?.length ? parsed.data.options : null;
      }
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'Nothing to update' });
      }

      const [updated] = await db
        .update(liveBonusQuestions)
        .set(update)
        .where(eq(liveBonusQuestions.id, existing.id))
        .returning();

      // Anything that changes what an answer is worth, or what counts as right, means the
      // stored points are stale — leeway most obviously, since it decides the match.
      if (
        parsed.data.correctAnswer !== undefined ||
        parsed.data.points !== undefined ||
        parsed.data.leeway !== undefined ||
        parsed.data.answerType !== undefined
      ) {
        const scored = await scoreLiveBonusQuestion(updated.id);
        if (scored.affectedCompetitionIds.length > 0) {
          await recomputeLiveMemberTotals(scored.affectedCompetitionIds);
          notifyLiveCompetitions(scored.affectedCompetitionIds, 'leaderboard-updated');
        }
      }

      return res.json(updated);
    } catch (err) {
      return fail(res, err);
    }
  },
);

liveTournamentsRouter.delete(
  '/tournaments/:id/bonus-questions/:questionId',
  requireAdmin,
  async (req, res) => {
    try {
      const [existing] = await db
        .select({ id: liveBonusQuestions.id, liveTournamentId: liveBonusQuestions.liveTournamentId })
        .from(liveBonusQuestions)
        .where(
          and(
            eq(liveBonusQuestions.id, req.params.questionId),
            eq(liveBonusQuestions.liveTournamentId, req.params.id),
          ),
        );
      if (!existing) return res.status(404).json({ error: 'Question not found' });

      // Answers cascade away with the question, so the totals they fed have to be rebuilt.
      const competitions = await db
        .select({ id: liveCompetitions.id })
        .from(liveCompetitions)
        .where(eq(liveCompetitions.liveTournamentId, existing.liveTournamentId));

      await db.delete(liveBonusQuestions).where(eq(liveBonusQuestions.id, existing.id));

      if (competitions.length > 0) {
        const ids = competitions.map(c => c.id);
        await recomputeLiveMemberTotals(ids);
        notifyLiveCompetitions(ids, 'leaderboard-updated');
      }

      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  },
);
