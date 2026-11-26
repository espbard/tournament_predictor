import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { getLiveFormat, type LiveRoundCalendarEntry } from '@tournament-predictor/shared';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys, type LiveTournamentDetail } from '@/lib/liveApi';
import { liveRoundHeading } from '@/lib/liveRounds';
import { useT } from '@/lib/useT';

// ── Admin: knockout rounds ────────────────────────────────────────────────────
//
// The rounds a tournament declares from the published calendar — each leg of a knockout
// stage, and the final — which exist before the draw has filled them. Per round, a button
// that fetches that round's matches from the fixture provider; pressing it before the
// provider has them finds nothing and changes nothing, so it is safe at any time. Picking
// which fetched matches count is still done in the selected-matches panel below.
//
// Per stage, who sees it: test accounts and admins only, or everyone. The knockout stages
// start out test-only (the preset's default) so they can be tried before release.
//
// Under a second leg, any finished tie the app cannot settle on its own — the provider gave
// no extra-time or penalty breakdown — asks the admin who went through, since the
// team-through point depends on it. A tie an admin has settled keeps its answer on show,
// with a way to hand it back to the scores. See shared/src/live/ties.ts.
//
// See shared/src/live/rounds.ts.

interface Props {
  tournament: LiveTournamentDetail;
}

export default function AdminLiveKnockoutRoundsPanel({ tournament }: Props) {
  const { t, language } = useT();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const format = useMemo(() => getLiveFormat(tournament.format), [tournament.format]);
  const calendar = tournament.roundCalendar ?? [];

  const { data: fixtures = [] } = useQuery({
    queryKey: liveKeys.tournamentFixtures(tournament.id),
    queryFn: () => liveApi.tournamentFixtures(tournament.id),
    enabled: calendar.length > 0,
  });

  // The calendar grouped by stage, in calendar order.
  const byStage = useMemo(() => {
    const groups: Array<{ stageKey: string; rounds: LiveRoundCalendarEntry[] }> = [];
    for (const round of calendar) {
      const group = groups.find(g => g.stageKey === round.stageKey);
      if (group) group.rounds.push(round);
      else groups.push({ stageKey: round.stageKey, rounds: [round] });
    }
    return groups;
  }, [calendar]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: liveKeys.tournament(tournament.id) });
    queryClient.invalidateQueries({ queryKey: liveKeys.tournamentFixtures(tournament.id) });
    queryClient.invalidateQueries({ queryKey: liveKeys.selectedMatches(tournament.id) });
  }

  const stageDef = (stageKey: string) => format.stages.find(s => s.key === stageKey) ?? null;

  const refreshMutation = useMutation({
    mutationFn: (round: LiveRoundCalendarEntry) =>
      liveApi.refreshRound(tournament.id, { stageKey: round.stageKey, matchday: round.matchday }),
    onMutate: round => {
      setRefreshing(`${round.stageKey}#${round.matchday}`);
      setMessage('');
      setError('');
    },
    onSuccess: (result, round) => {
      setMessage(
        t('live.admin.rounds.refreshed', {
          dateFrom: result.dateFrom,
          dateTo: result.dateTo,
          round: liveRoundHeading(t, stageDef(round.stageKey), round.matchday),
          count: result.roundFixtures,
        }),
      );
      invalidate();
    },
    onError: err => {
      setError(
        err instanceof ApiError
          ? [err.message, typeof err.details === 'string' ? err.details : ''].filter(Boolean).join(': ')
          : t('live.admin.rounds.refreshFailed'),
      );
    },
    onSettled: () => setRefreshing(null),
  });

  const advanceMutation = useMutation({
    mutationFn: (vars: { fixtureId: string; teamId: string | null }) =>
      liveApi.setAdvancingTeam(tournament.id, vars.fixtureId, vars.teamId),
    onSuccess: () => {
      setError('');
      setMessage(t('live.admin.rounds.advanceSaved'));
      invalidate();
    },
    onError: err => {
      setMessage('');
      setError(err instanceof ApiError ? err.message : t('live.admin.rounds.advanceFailed'));
    },
  });

  const visibilityMutation = useMutation({
    mutationFn: (testOnlyStageKeys: string[]) =>
      liveApi.updateTournament(tournament.id, { testOnlyStageKeys }),
    onSuccess: () => {
      setError('');
      invalidate();
    },
    onError: err => {
      setMessage('');
      setError(err instanceof ApiError ? err.message : t('live.admin.rounds.visibilityFailed'));
    },
  });

  if (calendar.length === 0) return null;

  const hidden = new Set(tournament.testOnlyStageKeys ?? []);

  function setStageVisibility(stageKey: string, testOnly: boolean) {
    const next = new Set(hidden);
    if (testOnly) next.add(stageKey);
    else next.delete(stageKey);
    const def = stageDef(stageKey);
    visibilityMutation.mutate([...next], {
      onSuccess: () =>
        setMessage(
          t('live.admin.rounds.visibilitySaved', {
            stage: def ? t(def.labelKey) : stageKey,
            who: testOnly ? t('live.admin.rounds.testOnly') : t('live.admin.rounds.everyone'),
          }),
        ),
    });
  }

  // Noon UTC, so no timezone can move the calendar date to the day before or after.
  const locale = language === 'de' ? 'de-DE' : language === 'en' ? 'en-GB' : 'nb-NO';
  const formatDate = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

  return (
    <div className="mb-6 rounded-lg border p-5">
      <h2 className="mb-1 font-semibold">{t('live.admin.rounds.title')}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('live.admin.rounds.explainer')}</p>

      <div className="grid gap-4">
        {byStage.map(({ stageKey, rounds }) => {
          const def = stageDef(stageKey);
          const testOnly = hidden.has(stageKey);
          return (
            <section key={stageKey} className="rounded-md border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{def ? t(def.labelKey) : stageKey}</h3>
                <div
                  role="group"
                  aria-label={t('live.admin.rounds.visibility')}
                  className="inline-flex overflow-hidden rounded-md border text-xs"
                >
                  {[true, false].map(option => (
                    <button
                      key={String(option)}
                      type="button"
                      onClick={() => option !== testOnly && setStageVisibility(stageKey, option)}
                      disabled={visibilityMutation.isPending}
                      aria-pressed={option === testOnly}
                      className={`px-2.5 py-1 font-medium transition-colors disabled:opacity-50 ${
                        option === testOnly
                          ? option
                            ? 'bg-amber-500 text-white'
                            : 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {option ? t('live.admin.rounds.testOnly') : t('live.admin.rounds.everyone')}
                    </button>
                  ))}
                </div>
              </div>

              <ul className="grid gap-1.5">
                {rounds.map(round => {
                  const key = `${round.stageKey}#${round.matchday}`;
                  const inRound = fixtures.filter(
                    f => f.stageKey === round.stageKey && f.matchday === round.matchday,
                  );
                  const stored = inRound.length;
                  // Finished second legs nobody can score the team-through point on yet,
                  // and the ones an admin already settled.
                  const undecided = inRound.filter(
                    f =>
                      f.advance &&
                      f.status === 'finished' &&
                      (f.advance.actualTeamId === null || f.advancingTeamOverride),
                  );
                  return (
                    <li
                      key={key}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">
                          {liveRoundHeading(t, def, round.matchday)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {round.dates.map(formatDate).join(' / ')}
                          {' · '}
                          {t('live.admin.rounds.stored', { count: stored })}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => refreshMutation.mutate(round)}
                        disabled={refreshMutation.isPending}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${refreshing === key ? 'animate-spin' : ''}`}
                          aria-hidden
                        />
                        {refreshing === key
                          ? t('live.admin.rounds.refreshing')
                          : t('live.admin.rounds.refresh')}
                      </button>

                      {undecided.length > 0 && (
                        <div className="mt-1 grid w-full gap-1.5">
                          {undecided.map(f => {
                            const teams = [
                              { id: f.homeTeamId, name: f.homeTeam?.shortName ?? f.homeTeam?.name ?? '?' },
                              { id: f.awayTeamId, name: f.awayTeam?.shortName ?? f.awayTeam?.name ?? '?' },
                            ];
                            return (
                              <div
                                key={f.id}
                                className="flex flex-wrap items-center gap-2 rounded-md border border-amber-400/60 bg-background px-2.5 py-2 text-xs"
                              >
                                <span className="min-w-0 flex-1">
                                  {f.advancingTeamOverride
                                    ? t('live.admin.rounds.advanceSet', {
                                        match: `${teams[0].name} – ${teams[1].name}`,
                                      })
                                    : t('live.admin.rounds.advanceNeeded', {
                                        match: `${teams[0].name} – ${teams[1].name}`,
                                      })}
                                </span>
                                {teams.map(team => (
                                  <button
                                    key={team.id ?? team.name}
                                    type="button"
                                    disabled={advanceMutation.isPending || !team.id}
                                    aria-pressed={f.advancingTeamOverride === team.id}
                                    onClick={() =>
                                      team.id && advanceMutation.mutate({ fixtureId: f.id, teamId: team.id })
                                    }
                                    className={`rounded-md border px-2 py-1 font-medium disabled:opacity-50 ${
                                      f.advancingTeamOverride === team.id
                                        ? 'border-primary bg-primary text-primary-foreground'
                                        : 'hover:bg-muted'
                                    }`}
                                  >
                                    {team.name}
                                  </button>
                                ))}
                                {f.advancingTeamOverride && (
                                  <button
                                    type="button"
                                    disabled={advanceMutation.isPending}
                                    onClick={() => advanceMutation.mutate({ fixtureId: f.id, teamId: null })}
                                    className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
                                  >
                                    {t('live.admin.rounds.advanceClear')}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {message && <p className="mt-3 text-sm text-green-600 dark:text-green-400">{message}</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
