import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LIVE_MAX_MULTIPLIER,
  LIVE_MIN_MULTIPLIER,
  liveFixtureMultiplier,
} from '@tournament-predictor/shared';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys, type LiveFixtureView } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';

// ── Admin: selected matches ───────────────────────────────────────────────────
//
// Which matches of a gameweek users predict on. A gameweek nobody has touched has every
// match selected — that default is what makes a freshly created tournament playable — so
// the panel opens showing everything ticked and only says "customised" once a selection
// has actually been registered.
//
// Unticking everything and saving is the reset: it deletes the registration and puts the
// gameweek back on the default. See shared/src/live/selection.ts.
//
// Each row also carries the fixture's point multiplier. Unlike the ticks — which are one
// registration per gameweek and so are saved together — a multiplier belongs to the single
// fixture, so it is saved on its own the moment the field is left.

interface Props {
  tournamentId: string;
}

/** A gameweek is one matchday inside one stage, so both identify it. */
interface GameweekId {
  stageKey: string;
  matchday: number;
}

export default function LiveSelectedMatchesPanel({ tournamentId }: Props) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const [gameweek, setGameweek] = useState<GameweekId | null>(null);
  const [checked, setChecked] = useState<Set<string> | null>(null);
  // Multiplier fields being typed in, by fixture id. Absent means "showing what is saved".
  const [multiplierDrafts, setMultiplierDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const { data: fixtures = [], isLoading } = useQuery({
    queryKey: liveKeys.tournamentFixtures(tournamentId),
    queryFn: () => liveApi.tournamentFixtures(tournamentId),
  });

  const { data: gameweeks = [] } = useQuery({
    queryKey: liveKeys.selectedMatches(tournamentId),
    queryFn: () => liveApi.selectedMatches(tournamentId),
  });

  // Only fixtures that sit in a gameweek can be selected; a knockout tie has no matchday.
  const gameweekFixtures = useMemo(
    () => fixtures.filter(f => f.stageKey !== null && f.matchday !== null),
    [fixtures],
  );

  // Grouped for the picker, in the order the fixtures themselves imply: stages appear in
  // kickoff order, and matchdays ascending within a stage.
  const stages = useMemo(() => {
    const byStage = new Map<string, Set<number>>();
    for (const f of [...gameweekFixtures].sort((a, b) =>
      (a.kickoffAt ?? '').localeCompare(b.kickoffAt ?? ''),
    )) {
      const matchdays = byStage.get(f.stageKey!);
      if (matchdays) matchdays.add(f.matchday!);
      else byStage.set(f.stageKey!, new Set([f.matchday!]));
    }
    return [...byStage.entries()].map(([stageKey, matchdays]) => ({
      stageKey,
      matchdays: [...matchdays].sort((a, b) => a - b),
    }));
  }, [gameweekFixtures]);

  // Open on the gameweek of the next match still to be played — the one an admin has come
  // here to set up — falling back to the last one of a finished season.
  useEffect(() => {
    if (gameweek !== null || gameweekFixtures.length === 0) return;
    const upcoming = [...gameweekFixtures]
      .filter(f => f.status !== 'finished' && f.status !== 'cancelled')
      .sort((a, b) => (a.kickoffAt ?? '').localeCompare(b.kickoffAt ?? ''))[0];
    const fallback = [...gameweekFixtures].sort((a, b) =>
      (b.kickoffAt ?? '').localeCompare(a.kickoffAt ?? ''),
    )[0];
    const chosen = upcoming ?? fallback;
    if (chosen) setGameweek({ stageKey: chosen.stageKey!, matchday: chosen.matchday! });
  }, [gameweekFixtures, gameweek]);

  const shown = useMemo(
    () =>
      gameweek
        ? gameweekFixtures
            .filter(f => f.stageKey === gameweek.stageKey && f.matchday === gameweek.matchday)
            .sort((a, b) => (a.kickoffAt ?? '').localeCompare(b.kickoffAt ?? ''))
        : [],
    [gameweekFixtures, gameweek],
  );

  const summary = gameweeks.find(
    g => g.stageKey === gameweek?.stageKey && g.matchday === gameweek?.matchday,
  );

  // The tick state is seeded from the server and then owned by the form, so an edit in
  // progress is not overwritten by a refetch.
  useEffect(() => {
    setChecked(null);
    setMultiplierDrafts({});
    setMessage('');
    setError('');
  }, [gameweek?.stageKey, gameweek?.matchday]);

  const selectedIds = checked ?? new Set(shown.filter(f => f.isSelected).map(f => f.id));

  const saveMutation = useMutation({
    mutationFn: (fixtureIds: string[] | null) =>
      liveApi.saveSelectedMatches(tournamentId, {
        stageKey: gameweek!.stageKey,
        matchday: gameweek!.matchday,
        fixtureIds,
      }),
    onSuccess: result => {
      setError('');
      setChecked(null);
      setMessage(
        result.isCustomised
          ? t('live.admin.selection.saved', {
              selected: result.selectedFixtureIds.length,
              total: result.fixtureCount,
            })
          : t('live.admin.selection.resetDone'),
      );
      queryClient.invalidateQueries({ queryKey: liveKeys.tournamentFixtures(tournamentId) });
      queryClient.invalidateQueries({ queryKey: liveKeys.selectedMatches(tournamentId) });
    },
    onError: err => {
      setMessage('');
      setError(err instanceof ApiError ? err.message : t('live.admin.selection.saveFailed'));
    },
  });

  const multiplierMutation = useMutation({
    mutationFn: (vars: { fixtureId: string; multiplier: number }) =>
      liveApi.saveFixtureMultiplier(tournamentId, vars.fixtureId, vars.multiplier),
    onSuccess: (result, vars) => {
      setError('');
      clearDraft(vars.fixtureId);
      setMessage(t('live.admin.multiplier.saved', { multiplier: result.fixture.multiplier }));
      // Points may have moved on every competition playing this tournament, so the
      // fixtures the panel renders are refetched rather than patched in place.
      queryClient.invalidateQueries({ queryKey: liveKeys.tournamentFixtures(tournamentId) });
    },
    onError: (err, vars) => {
      setMessage('');
      // The field goes back to the saved value: leaving a rejected number in it would
      // look like it had been applied.
      clearDraft(vars.fixtureId);
      setError(err instanceof ApiError ? err.message : t('live.admin.multiplier.saveFailed'));
    },
  });

  function clearDraft(fixtureId: string) {
    setMultiplierDrafts(prev => {
      if (!(fixtureId in prev)) return prev;
      const next = { ...prev };
      delete next[fixtureId];
      return next;
    });
  }

  /**
   * Save a multiplier the admin has finished typing.
   *
   * Anything unusable — an empty field, a decimal, a number outside the bounds — is
   * dropped back to the saved value rather than sent, so a half-typed "1" on the way to
   * "10" can never be committed by a stray click.
   */
  function commitMultiplier(fixture: LiveFixtureView) {
    const draft = multiplierDrafts[fixture.id];
    if (draft === undefined) return;

    const saved = liveFixtureMultiplier(fixture.multiplier);
    const parsed = Number(draft);
    const valid =
      draft.trim() !== '' &&
      Number.isInteger(parsed) &&
      parsed >= LIVE_MIN_MULTIPLIER &&
      parsed <= LIVE_MAX_MULTIPLIER;
    if (!valid || parsed === saved) {
      clearDraft(fixture.id);
      return;
    }
    multiplierMutation.mutate({ fixtureId: fixture.id, multiplier: parsed });
  }

  function toggle(fixtureId: string) {
    const next = new Set(selectedIds);
    if (next.has(fixtureId)) next.delete(fixtureId);
    else next.add(fixtureId);
    setChecked(next);
  }

  if (isLoading) {
    return (
      <div className="mb-6 rounded-lg border p-5">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-lg border p-5">
      <h2 className="mb-1 font-semibold">{t('live.admin.selection.title')}</h2>
      <p className="mb-1 text-sm text-muted-foreground">{t('live.admin.selection.explainer')}</p>
      <p className="mb-4 text-sm text-muted-foreground">{t('live.admin.multiplier.explainer')}</p>

      {gameweekFixtures.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('live.admin.selection.noGameweeks')}</p>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t('live.admin.selection.stage')}
              </span>
              <select
                value={gameweek?.stageKey ?? ''}
                onChange={e => {
                  const stage = stages.find(s => s.stageKey === e.target.value);
                  if (stage) setGameweek({ stageKey: stage.stageKey, matchday: stage.matchdays[0] });
                }}
                className="w-full rounded-md border bg-background px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {stages.map(stage => (
                  <option key={stage.stageKey} value={stage.stageKey}>
                    {t(`live.stages.${stage.stageKey}`)}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t('live.admin.selection.gameweek')}
              </span>
              <select
                value={gameweek?.matchday ?? ''}
                onChange={e =>
                  setGameweek(prev =>
                    prev ? { ...prev, matchday: Number(e.target.value) } : prev,
                  )
                }
                className="w-full rounded-md border bg-background px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {(stages.find(s => s.stageKey === gameweek?.stageKey)?.matchdays ?? []).map(md => {
                  const g = gameweeks.find(
                    x => x.stageKey === gameweek?.stageKey && x.matchday === md,
                  );
                  return (
                    <option key={md} value={md}>
                      {/* A customised gameweek is marked, so an admin can see at a glance
                          which weeks have been narrowed without opening each one. */}
                      {g?.isCustomised
                        ? t('live.admin.selection.gameweekOptionCustom', {
                            matchday: md,
                            selected: g.selectedCount,
                            total: g.fixtureCount,
                          })
                        : t('live.admin.selection.gameweekOption', { matchday: md })}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>

          <p className="mb-2 text-xs text-muted-foreground">
            {summary?.isCustomised
              ? t('live.admin.selection.stateCustom', {
                  selected: selectedIds.size,
                  total: shown.length,
                })
              : t('live.admin.selection.stateDefault', { total: shown.length })}
          </p>

          <ul className="mb-4 grid gap-1">
            {shown.map(fixture => {
              const label = fixtureLabel(fixture, t);
              // Read through the helper: a fixture fetched before the column existed has
              // no multiplier at all, and "undefined" must not end up in the field.
              const saved = liveFixtureMultiplier(fixture.multiplier);
              return (
                <li key={fixture.id}>
                  {/* The multiplier field sits outside the label: a click meant for it
                      would otherwise be forwarded to the checkbox and toggle the match. */}
                  <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
                    <label className="-my-2 flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(fixture.id)}
                        onChange={() => toggle(fixture.id)}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </label>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {fixture.kickoffAt
                        ? new Date(fixture.kickoffAt).toLocaleString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : t('live.kickoffTbd')}
                    </span>
                    <span
                      className={`shrink-0 text-xs ${
                        saved > 1
                          ? 'font-semibold text-amber-600 dark:text-amber-400'
                          : 'text-muted-foreground'
                      }`}
                      aria-hidden
                    >
                      ×
                    </span>
                    <input
                      type="number"
                      min={LIVE_MIN_MULTIPLIER}
                      max={LIVE_MAX_MULTIPLIER}
                      step={1}
                      inputMode="numeric"
                      value={multiplierDrafts[fixture.id] ?? String(saved)}
                      onChange={e =>
                        setMultiplierDrafts(prev => ({ ...prev, [fixture.id]: e.target.value }))
                      }
                      onBlur={() => commitMultiplier(fixture)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') clearDraft(fixture.id);
                      }}
                      disabled={multiplierMutation.isPending}
                      aria-label={t('live.admin.multiplier.field', { match: label })}
                      className={`h-8 w-14 shrink-0 rounded-md border bg-background text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${
                        saved > 1 ? 'border-amber-400/70 font-semibold' : ''
                      }`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => saveMutation.mutate([...selectedIds])}
              disabled={saveMutation.isPending || !gameweek}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saveMutation.isPending ? t('common.saving') : t('live.admin.selection.save')}
            </button>
            <button
              onClick={() => {
                setChecked(new Set(shown.map(f => f.id)));
                setMessage('');
              }}
              disabled={saveMutation.isPending}
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t('live.admin.selection.selectAll')}
            </button>
            <button
              onClick={() => {
                setChecked(new Set());
                setMessage('');
              }}
              disabled={saveMutation.isPending}
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t('live.admin.selection.clear')}
            </button>
          </div>

          {/* Spelled out because an empty save looks like it might do nothing at all. */}
          {selectedIds.size === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('live.admin.selection.emptyMeansNone')}
            </p>
          )}
          {message && <p className="mt-3 text-sm text-green-600 dark:text-green-400">{message}</p>}
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}

function fixtureLabel(fixture: LiveFixtureView, t: (key: string) => string): string {
  const home = fixture.homeTeam?.shortName ?? fixture.homeTeam?.name ?? t('live.tbd');
  const away = fixture.awayTeam?.shortName ?? fixture.awayTeam?.name ?? t('live.tbd');
  return `${home} – ${away}`;
}
