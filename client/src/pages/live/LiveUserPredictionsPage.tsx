import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  liveApi,
  liveKeys,
  type LiveFixtureView,
  type LiveTablePredictionView,
} from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import BackButton from '@/components/BackButton';
import { UserAvatar } from '@/components/UserAvatar';
import { useT } from '@/lib/useT';
import { useAuthStore } from '@/store/authStore';
import LiveFixtureList from '@/components/live/LiveFixtureList';
import LiveGameweekProgress, {
  type LiveGameweekProgressItem,
} from '@/components/live/LiveGameweekProgress';
import LiveTablePrediction from '@/components/live/LiveTablePrediction';
import LiveBonusQuestionsTab from '@/components/live/LiveBonusQuestionsTab';

// ── One member's predictions, read-only ───────────────────────────────────────
//
// Reached by clicking a name on the leaderboard or in a match's predictions dropdown.
// The same three prediction sections the member sees themselves — fixtures, the table
// prediction, bonus questions — rendered from their answers instead of the viewer's, with
// every control inert.
//
// Nothing is hidden client-side; what is visible is decided by the endpoints behind it. The
// two season-long calls — the table and the bonus questions — are open to the league from
// the moment they are given, because arguing about them before the season is the point.
// Per-fixture predictions are not: those stay closed until their own kickoff, so a member's
// fixtures tab legitimately shows nothing for a gameweek still to be played.
//
// Looking at yourself is the one case that reads none of that, since the competition's own
// queries already hold your predictions.

const TABS = ['fixtures', 'table', 'bonus'] as const;
type TabId = (typeof TABS)[number];

export default function LiveUserPredictionsPage() {
  const { id, userId } = useParams<{ id: string; userId: string }>();
  const { t } = useT();
  const { user } = useAuthStore();
  const [searchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') as TabId | null;
  const [activeTab, setActiveTab] = useState<TabId>(
    tabParam && TABS.includes(tabParam) ? tabParam : 'fixtures',
  );

  const [stageKey, setStageKey] = useState<string | null>(null);
  const [matchday, setMatchday] = useState<number | null>(null);

  const isSelf = !!userId && userId === user?.id;

  const { data: competition, isLoading: loadingCompetition } = useQuery({
    queryKey: liveKeys.competition(id!),
    queryFn: () => liveApi.competition(id!),
    enabled: !!id,
  });

  const { data: members = [] } = useQuery({
    queryKey: liveKeys.members(id!),
    queryFn: () => liveApi.members(id!),
    enabled: !!id,
  });

  const { data: allFixtures = [], isLoading: loadingFixtures } = useQuery({
    queryKey: liveKeys.fixtures(id!),
    queryFn: () => liveApi.fixtures(id!),
    enabled: !!id,
  });

  // Their predictions, which the server has already narrowed to fixtures that have locked.
  const { data: theirPredictions = [] } = useQuery({
    queryKey: liveKeys.userPredictions(id!, userId!),
    queryFn: () => liveApi.otherUserPredictions(id!, userId!),
    enabled: !!id && !!userId && !isSelf,
  });

  const { data: tableView } = useQuery({
    queryKey: liveKeys.tablePrediction(id!),
    queryFn: () => liveApi.tablePrediction(id!),
    enabled: !!id,
  });

  const { data: theirTable } = useQuery({
    queryKey: liveKeys.userTablePrediction(id!, userId!),
    queryFn: () => liveApi.otherUserTablePrediction(id!, userId!),
    enabled: !!id && !!userId && !isSelf,
  });

  // Who is being looked at. The membership row is the whole answer where there is one — a
  // member with no picture of their own has a null imageUrl, and falling through that to
  // the viewer's own would put the wrong face beside their name. The auth store only
  // stands in for an admin looking at themselves, who is in no competition's member list.
  const member = members.find(m => m.userId === userId) ?? null;
  const subject = member ?? (isSelf && user ? user : null);

  // Their prediction replaces the viewer's own on every fixture. A fixture they never
  // predicted — or one that has not locked, which the server leaves out — shows as blank.
  const fixtures: LiveFixtureView[] = useMemo(() => {
    if (isSelf) return allFixtures;
    const byFixtureId = new Map(theirPredictions.map(p => [p.liveFixtureId, p]));
    return allFixtures.map(fixture => {
      const prediction = byFixtureId.get(fixture.id);
      return {
        ...fixture,
        prediction: prediction
          ? {
              homeScore: prediction.homeScore,
              awayScore: prediction.awayScore,
              points: prediction.points,
              correctOutcomePoints: prediction.correctOutcomePoints,
              correctGoalDifferencePoints: prediction.correctGoalDifferencePoints,
              exactScorePoints: prediction.exactScorePoints,
            }
          : null,
      };
    });
  }, [allFixtures, theirPredictions, isSelf]);

  // Stages that actually have fixtures, in the format's chronological order.
  const stages = useMemo(() => {
    const present = new Set(fixtures.map(f => f.stageKey).filter((s): s is string => !!s));
    return (competition?.stages ?? []).filter(s => present.has(s.key));
  }, [competition?.stages, fixtures]);

  // Open on the last gameweek that has been played — the one whose predictions can
  // actually be looked at — rather than on the fixtures still to come.
  useEffect(() => {
    if (stageKey !== null || fixtures.length === 0) return;

    const played = [...fixtures]
      .filter(f => f.status === 'finished')
      .sort((a, b) => (b.kickoffAt ?? '').localeCompare(a.kickoffAt ?? ''))[0];
    const fallback = [...fixtures].sort((a, b) =>
      (a.kickoffAt ?? '').localeCompare(b.kickoffAt ?? ''),
    )[0];
    const chosen = played ?? fallback;

    if (chosen?.stageKey) setStageKey(chosen.stageKey);
    if (chosen?.matchday != null) setMatchday(chosen.matchday);
  }, [fixtures, stageKey]);

  const stageDef = stages.find(s => s.key === stageKey) ?? null;

  const stageAllFixtures = useMemo(
    () => fixtures.filter(f => f.stageKey === stageKey),
    [fixtures, stageKey],
  );

  const stageFixtures = useMemo(
    () => stageAllFixtures.filter(f => f.isSelected),
    [stageAllFixtures],
  );

  const matchdays = useMemo(
    () =>
      [
        ...new Set(stageAllFixtures.map(f => f.matchday).filter((m): m is number => m != null)),
      ].sort((a, b) => a - b),
    [stageAllFixtures],
  );

  // The same dots as the member's own page, reading their predictions: a green week is one
  // they filled in completely, a yellow one a week they left holes in.
  const gameweekProgress = useMemo<LiveGameweekProgressItem[]>(
    () =>
      matchdays.map(matchday => {
        const selected = stageFixtures.filter(f => f.matchday === matchday);
        const predicted = selected.filter(f => f.prediction !== null).length;
        return {
          matchday,
          selected: selected.length,
          predicted,
          state:
            selected.length === 0
              ? 'empty'
              : predicted === selected.length
                ? 'complete'
                : 'partial',
        };
      }),
    [matchdays, stageFixtures],
  );

  const shownMatchday = matchday ?? matchdays[0] ?? null;

  if (loadingCompetition) return <LoadingSpinner />;
  if (!competition) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <p className="text-center text-sm text-muted-foreground">{t('live.competitionNotFound')}</p>
      </main>
    );
  }

  const username = subject?.username ?? '';

  // The table as they submitted it. Everything else about the view — the teams, the bands,
  // the scoring — is the competition's, and the list itself is rendered read-only.
  const availableTable: Extract<LiveTablePredictionView, { available: true }> | null =
    tableView && tableView.available ? tableView : null;
  const theirTableView = availableTable
    ? { ...availableTable, prediction: isSelf ? availableTable.prediction : theirTable ?? null }
    : null;

  return (
    <main className="mx-auto max-w-2xl md:max-w-4xl lg:max-w-[80%] px-4 pt-2.5 pb-12 sm:pt-8">
      <BackButton href={`/live/competitions/${id}?tab=leaderboard`} />

      <div className="mb-6 flex items-center gap-3">
        <UserAvatar
          username={username}
          imageUrl={subject?.imageUrl ?? null}
          iconColor={subject?.iconColor ?? null}
          className="h-10 w-10"
          resizeWidth={80}
        />
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold">{username}</h1>
          <p className="truncate text-xs text-muted-foreground">{competition.name}</p>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-1 border-b">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'border-primary text-primary dark:border-[hsl(231,60%,65%)] dark:text-[hsl(231,60%,65%)]'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`live.tabs.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === 'fixtures' &&
        (loadingFixtures ? (
          <LoadingSpinner />
        ) : fixtures.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('live.noFixtures')}
          </p>
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

            {stageDef?.kind === 'table' && matchdays.length > 0 && (
              <>
                <LiveGameweekProgress
                  items={gameweekProgress}
                  current={shownMatchday}
                  onSelect={setMatchday}
                />
                <h2 className="mb-3 text-lg font-semibold">
                  {t('live.gameweekHeading', { matchday: shownMatchday ?? 0 })}
                </h2>
              </>
            )}

            <LiveFixtureList
              // Remounts the cards when the page moves to another member, so no score is
              // carried over from the one before.
              key={userId}
              fixtures={stageFixtures}
              stageKind={stageDef?.kind ?? 'table'}
              legs={stageDef?.legs ?? 1}
              matchday={shownMatchday}
              emptyMessage={
                stageDef?.kind === 'table' ? t('live.gameweekNoneSelected') : undefined
              }
              onSave={() => {}}
              savingFixtureId={null}
              savedFixtures={{}}
              errors={{}}
              readOnly
              competitionId={id!}
            />
          </>
        ))}

      {activeTab === 'table' &&
        (!theirTableView || theirTableView.teams.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('live.table.unavailable')}
          </p>
        ) : !theirTableView.prediction ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('live.userPredictions.noTable', { name: username })}
          </p>
        ) : (
          <LiveTablePrediction
            view={theirTableView}
            onSave={() => {}}
            isSaving={false}
            savedAt={null}
            error={null}
            readOnly
          />
        ))}

      {activeTab === 'bonus' &&
        (competition.tournament ? (
          <LiveBonusQuestionsTab
            competitionId={id!}
            liveTournamentId={competition.tournament.id}
            viewUserId={userId}
          />
        ) : (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('live.bonus.unavailable')}
          </p>
        ))}
    </main>
  );
}
