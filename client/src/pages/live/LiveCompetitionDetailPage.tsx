import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import LiveBonusQuestionsTab from '@/components/live/LiveBonusQuestionsTab';
import LiveTablePredictionGate from '@/components/live/LiveTablePredictionGate';
import LiveBonusQuestionsGate from '@/components/live/LiveBonusQuestionsGate';
import InviteButton from '@/components/InviteButton';
import { useAuthStore } from '@/store/authStore';
import type { Team } from '@tournament-predictor/shared';

// ── Live competition ──────────────────────────────────────────────────────────
//
// Fixtures, the table prediction, bonus questions, standings and the leaderboard. No
// knockout bracket and no group-position tab — this tournament type predicts real
// scheduled fixtures, plus the two season-long side bets.
//
// The page renders one section at a time, chosen by ?tab=. There is no tab bar here:
// navigation lives in the navbar's Predictions / Results dropdowns, same as the manual
// type. See client/src/components/Navbar.tsx.
//
// The fixtures tab is driven by the tournament's format rather than a hardcoded stage
// list, so a new competition shape needs no client change.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §11.

const TABS = ['fixtures', 'table', 'bonus', 'standings', 'leaderboard'] as const;
type TabId = (typeof TABS)[number];

const LIVE_STATUSES = new Set(['in_play', 'paused']);

export default function LiveCompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

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

  // Fetched on every tab rather than only its own: whether a table prediction exists
  // decides whether the rest of the page is reachable at all.
  const { data: tableView, isLoading: loadingTable } = useQuery({
    queryKey: liveKeys.tablePrediction(id!),
    queryFn: () => liveApi.tablePrediction(id!),
    enabled: !!id,
  });

  // Also fetched on every tab: the bonus questions are the second step of the first-run
  // flow, so whether any are unanswered decides whether the competition is reachable.
  const { data: bonusQuestions = [], isLoading: loadingBonusQuestions } = useQuery({
    queryKey: liveKeys.bonusQuestions(id!),
    queryFn: () => liveApi.bonusQuestions(id!),
    enabled: !!id,
  });

  const { data: bonusAnswers = [], isLoading: loadingBonusAnswers } = useQuery({
    queryKey: liveKeys.bonusAnswers(id!),
    queryFn: () => liveApi.bonusAnswers(id!),
    enabled: !!id,
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
  // A match left out of its gameweek's selected matches is not part of the game, so it is
  // not shown at all — no card, no inputs, nothing to explain.
  const stageFixtures = useMemo(
    () => fixtures.filter(f => f.stageKey === stageKey && f.isSelected),
    [fixtures, stageKey],
  );

  const matchdays = useMemo(
    () =>
      [...new Set(stageFixtures.map(f => f.matchday).filter((m): m is number => m != null))].sort(
        (a, b) => a - b,
      ),
    [stageFixtures],
  );

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

  const leaveMutation = useMutation({
    mutationFn: () => liveApi.leave(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: liveKeys.competitions });
      navigate('/');
    },
  });

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

  // ── The table-prediction gate ───────────────────────────────────────────────
  //
  // A member who has not submitted a table prediction sees only that, full screen, until
  // they do. Three groups are deliberately let through instead of being trapped:
  // anyone who can no longer submit (the table locks at the first kickoff and never
  // reopens), accounts that are not allowed to predict at all, and admins, who need to be
  // able to look at a competition without playing it.
  // A team answer is picked from the tournament's teams, and the picker knows only the
  // manual Team shape — the live crest is mapped onto it, as in the bonus tab.
  const bonusTeams: Team[] = teams.map(
    team =>
      ({
        id: team.id,
        tournamentId: tournamentId ?? '',
        name: team.name,
        imageUrl: team.crestUrl,
      }) as Team,
  );

  const canBeGated = !user?.isAdmin && !user?.isLeaderboardUser;

  // The same group the gates apply to: an admin is a member of every competition
  // implicitly and has nothing to leave, and a leaderboard viewer is not playing.
  const canLeave = canBeGated;

  const mustPredictTable =
    canBeGated &&
    !!tableView?.available &&
    !tableView.isLocked &&
    !tableView.prediction &&
    tableView.teams.length > 0;

  // Step two: the bonus questions that are still open and still unanswered. A closed one
  // can never be answered, so requiring it would trap the member out of the competition.
  const answeredQuestionIds = new Set(bonusAnswers.map(a => a.questionId));
  const unansweredBonusQuestions = bonusQuestions.filter(
    q => !q.isLocked && !answeredQuestionIds.has(q.id),
  );
  const mustAnswerBonus = canBeGated && !mustPredictTable && unansweredBonusQuestions.length > 0;

  if (loadingCompetition || loadingTable || loadingBonusQuestions || loadingBonusAnswers) {
    return <LoadingSpinner />;
  }
  if (!competition) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <p className="text-center text-sm text-muted-foreground">{t('live.competitionNotFound')}</p>
      </main>
    );
  }

  // The first-run flow, in order: the table, then the bonus questions, then the
  // competition itself.
  if (mustPredictTable && tableView?.available) {
    return (
      <LiveTablePredictionGate
        competitionName={competition.name}
        view={tableView}
        onSave={orderedTeamIds => saveTableMutation.mutate(orderedTeamIds)}
        isSaving={saveTableMutation.isPending}
        error={tableError}
      />
    );
  }

  if (mustAnswerBonus) {
    return (
      <LiveBonusQuestionsGate
        competitionName={competition.name}
        questions={unansweredBonusQuestions}
        teams={bonusTeams}
        onSave={(questionId, answer) => liveApi.saveBonusAnswer(id!, { questionId, answer })}
        onFinished={() => {
          queryClient.invalidateQueries({ queryKey: liveKeys.bonusAnswers(id!) });
          queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(id!) });
        }}
      />
    );
  }

  return (
    <main className="mx-auto max-w-2xl md:max-w-4xl lg:max-w-[80%] px-4 pt-2.5 pb-12 sm:pt-8">
      <header className="mb-6 flex items-start gap-4">
        {competition.imageUrl ? (
          <img src={competition.imageUrl} alt="" aria-hidden className="h-12 w-12 rounded-lg object-cover" />
        ) : (
          <div className="h-12 w-12 rounded-lg bg-muted" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold">{competition.name}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {competition.tournament?.name ?? ''}
          </p>
          <p className="mt-0.5 font-mono text-xs tracking-wider text-muted-foreground">
            {t('competitionDetail.inviteCodeLabel')}: {competition.inviteCode}
          </p>
        </div>
        {/* Leave with Invite stacked underneath, same as the manual competition page. */}
        <div className="flex flex-col items-stretch gap-2 flex-shrink-0">
          {canLeave && (
            <button
              onClick={() => setShowLeaveConfirm(true)}
              className="rounded-md border border-red-600 bg-red-600 px-3 py-1.5 text-sm text-white transition-colors hover:border-red-700 hover:bg-red-700"
            >
              {t('competitionDetail.leave')}
            </button>
          )}
          <InviteButton
            kind="live"
            competitionId={competition.id}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          />
        </div>
      </header>

      {showLeaveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-xl">
            <p className="mb-1 font-semibold">{t('competitionDetail.leaveConfirm.title')}</p>
            <p className="mb-6 text-sm text-muted-foreground">
              {t('competitionDetail.leaveConfirm.body', { name: competition.name })}
            </p>
            {leaveMutation.isError && (
              <p className="mb-4 text-sm text-destructive">
                {leaveMutation.error instanceof ApiError
                  ? leaveMutation.error.message
                  : t('competitionDetail.failedToLeave')}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                disabled={leaveMutation.isPending}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => leaveMutation.mutate()}
                disabled={leaveMutation.isPending}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {leaveMutation.isPending
                  ? t('competitionDetail.leaveConfirm.leaving')
                  : t('competitionDetail.leaveConfirm.leave')}
              </button>
            </div>
          </div>
        </div>
      )}

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
        (!tableView?.available ? (
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

      {activeTab === 'bonus' &&
        (competition.tournament ? (
          <LiveBonusQuestionsTab
            competitionId={id!}
            liveTournamentId={competition.tournament.id}
          />
        ) : (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('live.bonus.unavailable')}
          </p>
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

  return (
    <div className="grid gap-2">
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
