import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys, type LiveFixtureView } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import LiveFixtureCard from '@/components/live/LiveFixtureCard';
import LiveTieCard from '@/components/live/LiveTieCard';
import LiveStandingsTable from '@/components/live/LiveStandingsTable';
import LiveLeaderboard from '@/components/live/LiveLeaderboard';
import LiveQualifiedTeamsPanel from '@/components/live/LiveQualifiedTeamsPanel';
import LiveTablePrediction from '@/components/live/LiveTablePrediction';

// ── Live competition ──────────────────────────────────────────────────────────
//
// Three tabs: Fixtures, Standings, Leaderboard. No knockout bracket, no group-position
// tab, no bonus questions — this tournament type predicts real scheduled fixtures only.
//
// The fixtures tab is driven by the tournament's format rather than a hardcoded stage
// list, so a new competition shape needs no client change.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §11.

const TABS = ['fixtures', 'table', 'standings', 'leaderboard'] as const;
type TabId = (typeof TABS)[number];

const LIVE_STATUSES = new Set(['in_play', 'paused']);

export default function LiveCompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') as TabId | null;
  const activeTab: TabId = tabParam && TABS.includes(tabParam) ? tabParam : 'fixtures';

  const [stageKey, setStageKey] = useState<string | null>(null);
  const [matchday, setMatchday] = useState<number | null>(null);
  const [savingFixtureId, setSavingFixtureId] = useState<string | null>(null);
  const [savedFixtures, setSavedFixtures] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: competition, isLoading: loadingCompetition } = useQuery({
    queryKey: liveKeys.competition(id!),
    queryFn: () => liveApi.competition(id!),
    enabled: !!id,
  });

  // Every fixture is fetched once and filtered in memory. It is one request rather than
  // one per matchday, it makes switching stages instant, and it gives the SSE handler a
  // single key to invalidate. Even the Premier League's 380 fixtures are a modest payload
  // for a ~20-person app.
  const { data: fixtures = [], isLoading: loadingFixtures } = useQuery({
    queryKey: liveKeys.fixtures(id!),
    queryFn: () => liveApi.fixtures(id!),
    enabled: !!id,
    // Only poll while something is actually being played; SSE covers the rest.
    refetchInterval: q => {
      const rows = q.state.data as LiveFixtureView[] | undefined;
      return rows?.some(f => LIVE_STATUSES.has(f.status)) ? 30_000 : false;
    },
  });

  const tournamentId = competition?.tournament?.id;

  const { data: standings = [] } = useQuery({
    queryKey: liveKeys.standings(tournamentId ?? '', stageKey ?? undefined),
    queryFn: () => liveApi.tournamentStandings(tournamentId!, stageKey ?? undefined),
    enabled: !!tournamentId && activeTab === 'standings',
  });

  const { data: leaderboard = [] } = useQuery({
    queryKey: liveKeys.leaderboard(id!),
    queryFn: () => liveApi.leaderboard(id!),
    enabled: !!id && activeTab === 'leaderboard',
  });

  const { data: teams = [] } = useQuery({
    queryKey: liveKeys.tournamentTeams(tournamentId ?? ''),
    queryFn: () => liveApi.tournamentTeams(tournamentId!),
    enabled: !!tournamentId,
  });

  const { data: tableView, isLoading: loadingTable } = useQuery({
    queryKey: liveKeys.tablePrediction(id!),
    queryFn: () => liveApi.tablePrediction(id!),
    enabled: !!id && activeTab === 'table',
  });

  // Live updates. One connection per page, same pattern as CompetitionDetailPage.
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/live/competitions/${id}/events`, { withCredentials: true });
    es.addEventListener('fixtures-updated', () => {
      queryClient.invalidateQueries({ queryKey: liveKeys.fixtures(id) });
    });
    es.addEventListener('leaderboard-updated', () => {
      queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(id) });
    });
    return () => es.close();
  }, [id, queryClient]);

  // Stages that actually have fixtures, in the format's chronological order.
  const stages = useMemo(() => {
    const present = new Set(fixtures.map(f => f.stageKey).filter((s): s is string => !!s));
    return (competition?.stages ?? []).filter(s => present.has(s.key));
  }, [competition?.stages, fixtures]);

  // Default to whatever is happening next — the stage and matchday of the earliest
  // fixture still to be played, falling back to the last one for a finished season.
  useEffect(() => {
    if (stageKey !== null || fixtures.length === 0) return;

    const upcoming = [...fixtures]
      .filter(f => f.status !== 'finished' && f.status !== 'cancelled')
      .sort((a, b) => (a.kickoffAt ?? '').localeCompare(b.kickoffAt ?? ''))[0];
    const fallback = [...fixtures].sort((a, b) => (b.kickoffAt ?? '').localeCompare(a.kickoffAt ?? ''))[0];
    const chosen = upcoming ?? fallback;

    if (chosen?.stageKey) setStageKey(chosen.stageKey);
    if (chosen?.matchday != null) setMatchday(chosen.matchday);
  }, [fixtures, stageKey]);

  const stageDef = stages.find(s => s.key === stageKey) ?? null;
  const stageFixtures = useMemo(
    () => fixtures.filter(f => f.stageKey === stageKey),
    [fixtures, stageKey],
  );

  const matchdays = useMemo(
    () =>
      [...new Set(stageFixtures.map(f => f.matchday).filter((m): m is number => m != null))].sort(
        (a, b) => a - b,
      ),
    [stageFixtures],
  );

  function setTab(tab: TabId) {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', tab);
        return next;
      },
      { replace: true },
    );
  }

  const saveMutation = useMutation({
    mutationFn: ({ fixtureId, homeScore, awayScore }: { fixtureId: string; homeScore: number; awayScore: number }) =>
      liveApi.savePrediction(id!, { fixtureId, homeScore, awayScore }),
    onMutate: ({ fixtureId }) => {
      setSavingFixtureId(fixtureId);
      setErrors(prev => {
        const next = { ...prev };
        delete next[fixtureId];
        return next;
      });
    },
    onSuccess: (_data, { fixtureId }) => {
      setSavedFixtures(prev => ({ ...prev, [fixtureId]: Date.now() }));
      queryClient.invalidateQueries({ queryKey: liveKeys.fixtures(id!) });
      // Clear the confirmation after a moment so it does not linger.
      setTimeout(() => {
        setSavedFixtures(prev => {
          const next = { ...prev };
          delete next[fixtureId];
          return next;
        });
      }, 2500);
    },
    onError: (err, { fixtureId }) => {
      setErrors(prev => ({
        ...prev,
        [fixtureId]: err instanceof ApiError ? err.message : t('live.saveFailed'),
      }));
      // A rejection is usually the deadline passing while the form was open, so refetch
      // to pick up the now-locked state rather than leaving a stale editable input.
      queryClient.invalidateQueries({ queryKey: liveKeys.fixtures(id!) });
    },
    onSettled: () => setSavingFixtureId(null),
  });

  const handleSave = (fixtureId: string, homeScore: number, awayScore: number) =>
    saveMutation.mutate({ fixtureId, homeScore, awayScore });

  const [tableSavedAt, setTableSavedAt] = useState<number | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);

  const saveTableMutation = useMutation({
    mutationFn: (orderedTeamIds: string[]) =>
      liveApi.saveTablePrediction(id!, {
        stageKey: tableView?.available ? tableView.stageKey : '',
        orderedTeamIds,
      }),
    onMutate: () => setTableError(null),
    onSuccess: () => {
      setTableSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: liveKeys.tablePrediction(id!) });
      setTimeout(() => setTableSavedAt(null), 2500);
    },
    onError: err => {
      setTableError(err instanceof ApiError ? err.message : t('live.saveFailed'));
      // Usually the deadline passing mid-edit; refetch so the UI locks itself.
      queryClient.invalidateQueries({ queryKey: liveKeys.tablePrediction(id!) });
    },
  });

  if (loadingCompetition) return <LoadingSpinner />;
  if (!competition) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <p className="text-center text-sm text-muted-foreground">{t('live.competitionNotFound')}</p>
      </main>
    );
  }

  const tabCls = (active: boolean) =>
    `px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
      active
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <main className="mx-auto max-w-2xl md:max-w-4xl lg:max-w-[80%] px-4 pt-2.5 pb-12 sm:pt-8">
      <header className="mb-6 flex items-center gap-4">
        {competition.imageUrl ? (
          <img src={competition.imageUrl} alt="" aria-hidden className="h-12 w-12 rounded-lg object-cover" />
        ) : (
          <div className="h-12 w-12 rounded-lg bg-muted" aria-hidden />
        )}
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{competition.name}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {competition.tournament?.name ?? ''}
          </p>
        </div>
      </header>

      <div className="mb-4 flex gap-1 border-b">
        {TABS.map(tab => (
          <button key={tab} onClick={() => setTab(tab)} className={tabCls(activeTab === tab)}>
            {t(`live.tabs.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === 'fixtures' && (
        <>
          {loadingFixtures ? (
            <LoadingSpinner />
          ) : fixtures.length === 0 ? (
            // Not an error: the provider has not published this season yet.
            <LiveQualifiedTeamsPanel
              teams={teams}
              expectedTeamCount={null}
              note={competition.tournament?.lastSyncError ?? null}
            />
          ) : (
            <>
              {stages.length > 1 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {stages.map(stage => (
                    <button
                      key={stage.key}
                      onClick={() => {
                        setStageKey(stage.key);
                        setMatchday(null);
                      }}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                        stage.key === stageKey
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t(stage.labelKey)}
                    </button>
                  ))}
                </div>
              )}

              {stageDef?.kind === 'table' && matchdays.length > 1 && (
                <div className="mb-3 flex items-center gap-2">
                  <label htmlFor="matchday" className="text-xs text-muted-foreground">
                    {t('live.matchday')}
                  </label>
                  <select
                    id="matchday"
                    value={matchday ?? matchdays[0]}
                    onChange={e => setMatchday(Number(e.target.value))}
                    className="rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {matchdays.map(md => (
                      <option key={md} value={md}>
                        {md}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <FixtureList
                fixtures={stageFixtures}
                stageKind={stageDef?.kind ?? 'table'}
                legs={stageDef?.legs ?? 1}
                matchday={matchday ?? matchdays[0] ?? null}
                onSave={handleSave}
                savingFixtureId={savingFixtureId}
                savedFixtures={savedFixtures}
                errors={errors}
              />
            </>
          )}
        </>
      )}

      {activeTab === 'table' &&
        (loadingTable ? (
          <LoadingSpinner />
        ) : !tableView?.available ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('live.table.unavailable')}
          </p>
        ) : tableView.teams.length === 0 ? (
          // Before the draw there are no teams to order yet.
          <LiveQualifiedTeamsPanel teams={teams} expectedTeamCount={null} note={null} />
        ) : (
          <LiveTablePrediction
            view={tableView}
            onSave={orderedTeamIds => saveTableMutation.mutate(orderedTeamIds)}
            isSaving={saveTableMutation.isPending}
            savedAt={tableSavedAt}
            error={tableError}
          />
        ))}

      {activeTab === 'standings' && (
        <LiveStandingsTable rows={standings} tableScope={competition.tableScope} />
      )}

      {activeTab === 'leaderboard' && <LiveLeaderboard rows={leaderboard} />}
    </main>
  );
}

// ── Fixture list ──────────────────────────────────────────────────────────────

interface FixtureListProps {
  fixtures: LiveFixtureView[];
  stageKind: 'table' | 'knockout';
  legs: 1 | 2;
  matchday: number | null;
  onSave: (fixtureId: string, homeScore: number, awayScore: number) => void;
  savingFixtureId: string | null;
  savedFixtures: Record<string, number>;
  errors: Record<string, string>;
}

function FixtureList({
  fixtures,
  stageKind,
  legs,
  matchday,
  onSave,
  savingFixtureId,
  savedFixtures,
  errors,
}: FixtureListProps) {
  const { t } = useT();

  // A two-legged knockout stage groups its legs into ties.
  if (stageKind === 'knockout' && legs === 2) {
    const ties = new Map<string, LiveFixtureView[]>();
    const loose: LiveFixtureView[] = [];

    for (const fixture of fixtures) {
      if (!fixture.tieKey) {
        // Undrawn, so it has no identifiable tie yet.
        loose.push(fixture);
        continue;
      }
      const bucket = ties.get(fixture.tieKey);
      if (bucket) bucket.push(fixture);
      else ties.set(fixture.tieKey, [fixture]);
    }

    return (
      <div className="grid gap-3">
        {[...ties.values()]
          .sort((a, b) => (a[0].kickoffAt ?? '').localeCompare(b[0].kickoffAt ?? ''))
          .map(tieLegs => (
            <LiveTieCard
              key={tieLegs[0].tieKey}
              legs={tieLegs}
              onSave={onSave}
              savingFixtureId={savingFixtureId}
              savedFixtures={savedFixtures}
              errors={errors}
            />
          ))}
        {loose.map(fixture => (
          <LiveFixtureCard
            key={fixture.id}
            fixture={fixture}
            onSave={onSave}
            isSaving={savingFixtureId === fixture.id}
            savedAt={savedFixtures[fixture.id] ?? null}
            error={errors[fixture.id] ?? null}
          />
        ))}
      </div>
    );
  }

  const shown =
    stageKind === 'table' && matchday !== null
      ? fixtures.filter(f => f.matchday === matchday)
      : fixtures;

  if (shown.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('live.noFixtures')}
      </p>
    );
  }

  // Said once above the list rather than repeated on every ignored card.
  const selectedCount = shown.filter(f => f.isSelected).length;
  const hasUnselected = selectedCount < shown.length;

  return (
    <div className="grid gap-2">
      {hasUnselected && (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {t('live.selectedMatchesNote', { selected: selectedCount, total: shown.length })}
        </p>
      )}
      {shown.map(fixture => (
        <LiveFixtureCard
          key={fixture.id}
          fixture={fixture}
          onSave={onSave}
          isSaving={savingFixtureId === fixture.id}
          savedAt={savedFixtures[fixture.id] ?? null}
          error={errors[fixture.id] ?? null}
        />
      ))}
    </div>
  );
}
