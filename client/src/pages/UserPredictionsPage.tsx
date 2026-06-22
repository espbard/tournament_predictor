import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import KnockoutStageContent from '@/components/KnockoutStageContent';
import BonusQuestionsTab from '@/pages/BonusQuestionsTab';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { UserAvatar } from '@/components/UserAvatar';
import { useT } from '@/lib/useT';
import { useTeamName } from '@/lib/teamTranslations';
import { sortGroupTeams, makeDisciplinaryKey, type MatchResult, type DisciplinaryChoices } from '@/lib/tiebreakers';
import type { Competition, Tournament, Prediction, MatchStage } from '@tournament-predictor/shared';

interface MatchWithTeams {
  id: string;
  tournamentId: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamImageUrl: string | null;
  awayTeamImageUrl: string | null;
  stage: MatchStage;
  scheduledAt: string | null;
  status: 'scheduled' | 'completed';
  homeScore: number | null;
  awayScore: number | null;
  groupName: string | null;
}

function stageLabel(stage: MatchStage, groupName?: string | null): string {
  if (stage === 'group' && groupName) return `Group ${groupName}`;
  const map: Record<MatchStage, string> = {
    group: 'Group Stage',
    round_of_32: 'Round of 32',
    round_of_16: 'Round of 16',
    quarter_final: 'Quarter-final',
    semi_final: 'Semi-final',
    bronze_final: 'Bronze Final',
    final: 'Final',
  };
  return map[stage] ?? stage;
}

export default function UserPredictionsPage() {
  const { id, userId } = useParams<{ id: string; userId: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useT();
  const { tn } = useTeamName();

  const [activeTab, setActiveTab] = useState<'group' | 'tables' | 'knockout' | 'bonus'>(
    searchParams.get('tab') === 'bonus' ? 'bonus' :
    searchParams.get('tab') === 'tables' ? 'tables' :
    searchParams.get('tab') === 'knockout' ? 'knockout' : 'group'
  );
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const lastResultInitialized = useRef(false);

  const { data: competition, isLoading, error } = useQuery({
    queryKey: ['competitions', id],
    queryFn: () => api.get<Competition>(`/competitions/${id}`),
    enabled: !!id,
  });

  const { data: matchList = [], isFetching: matchListFetching } = useQuery({
    queryKey: ['tournaments', competition?.tournamentId, 'matches'],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${competition!.tournamentId}/matches`),
    enabled: !!competition,
  });

  const { data: userPreds, isLoading: predsLoading, error: predsError } = useQuery({
    queryKey: ['competitions', id, 'predictions', userId],
    queryFn: () => api.get<{ predictions: Prediction[]; username: string; imageUrl: string | null; iconColor: string | null }>(`/competitions/${id}/predictions/${userId}`),
    enabled: !!id && !!userId,
  });

  const username = userPreds?.username ?? '';
  const imageUrl = userPreds?.imageUrl ?? null;
  const iconColor = userPreds?.iconColor ?? null;
  const predictions = userPreds?.predictions ?? [];

  const predMap = useMemo(
    () => Object.fromEntries(predictions.map(p => [p.matchId, p])),
    [predictions]
  );

  const allGroupMatches = useMemo(() => {
    const groupMatches = matchList
      .filter(m => m.stage === 'group')
      .sort((a, b) => {
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      });
    return groupMatches;
  }, [matchList]);

  const hasKnockoutMatches = useMemo(
    () => matchList.some(m => m.stage !== 'group'),
    [matchList]
  );

  const { data: bracketPreds } = useQuery({
    queryKey: ['competitions', id, 'bracket-predictions', userId],
    queryFn: () => api.get<Record<string, unknown>>(`/competitions/${id}/bracket-predictions/${userId}`),
    enabled: !!id && !!userId,
  });

  const hasBracketPredictions = bracketPreds != null && Object.keys(bracketPreds).length > 0;
  const showKnockoutTab = hasKnockoutMatches || hasBracketPredictions;

  const { data: tournament } = useQuery({
    queryKey: ['tournament', competition?.tournamentId],
    queryFn: () => api.get<Tournament>(`/tournaments/${competition!.tournamentId}`),
    enabled: !!competition,
  });

  const { data: userTiebreakerChoices } = useQuery({
    queryKey: ['competitions', id, 'tiebreak-choices', userId],
    queryFn: () => api.get<{ groupChoices: DisciplinaryChoices; luckyLoserChoices: DisciplinaryChoices }>(`/competitions/${id}/tiebreak-choices/${userId}`),
    enabled: !!id && !!userId,
  });

  type TeamStat = {
    teamId: string;
    teamName: string;
    imageUrl: string | null;
    group: string;
    P: number; W: number; D: number; L: number; GF: number; GA: number;
  };

  const groupStandings = useMemo(() => {
    const groupMatches = matchList.filter(m => m.stage === 'group');
    const teamMap = new Map<string, TeamStat>();

    for (const m of groupMatches) {
      const g = m.groupName;
      if (!g) continue;
      if (m.homeTeamId && m.homeTeamName && !teamMap.has(m.homeTeamId))
        teamMap.set(m.homeTeamId, { teamId: m.homeTeamId, teamName: m.homeTeamName, imageUrl: m.homeTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
      if (m.awayTeamId && m.awayTeamName && !teamMap.has(m.awayTeamId))
        teamMap.set(m.awayTeamId, { teamId: m.awayTeamId, teamName: m.awayTeamName, imageUrl: m.awayTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
    }

    const groupResultsMap = new Map<string, MatchResult[]>();

    for (const m of groupMatches) {
      if (!m.homeTeamId || !m.awayTeamId || !m.groupName) continue;
      const pred = predMap[m.id];
      if (!pred) continue;
      const hs = pred.homeScore;
      const as_ = pred.awayScore;
      const home = teamMap.get(m.homeTeamId);
      const away = teamMap.get(m.awayTeamId);
      if (home) { home.P++; home.GF += hs; home.GA += as_; if (hs > as_) home.W++; else if (hs === as_) home.D++; else home.L++; }
      if (away) { away.P++; away.GF += as_; away.GA += hs; if (as_ > hs) away.W++; else if (hs === as_) away.D++; else away.L++; }
      if (!groupResultsMap.has(m.groupName)) groupResultsMap.set(m.groupName, []);
      groupResultsMap.get(m.groupName)!.push({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, homeScore: hs, awayScore: as_ });
    }

    const groupDisciplinaryChoices = (userTiebreakerChoices?.groupChoices ?? {}) as DisciplinaryChoices;
    const byGroup = new Map<string, TeamStat[]>();
    for (const tm of teamMap.values()) {
      if (!byGroup.has(tm.group)) byGroup.set(tm.group, []);
      byGroup.get(tm.group)!.push(tm);
    }

    for (const [groupName, teams] of byGroup) {
      const results = groupResultsMap.get(groupName) ?? [];
      const tiebreakerStats = teams.map(tm => ({ teamId: tm.teamId, points: tm.W * 3 + tm.D, gd: tm.GF - tm.GA, gf: tm.GF }));
      const sortedIds = sortGroupTeams(tiebreakerStats, results, groupDisciplinaryChoices).map(s => s.teamId);
      teams.sort((a, b) => sortedIds.indexOf(a.teamId) - sortedIds.indexOf(b.teamId));
    }

    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [matchList, predMap, userTiebreakerChoices]);

  const qualifyingThirdPlaceIds = useMemo(() => {
    const luckyLosers = tournament?.knockoutConfig?.luckyLosers ?? 0;
    if (luckyLosers <= 0) return new Set<string>();
    const luckyLoserChoices = (userTiebreakerChoices?.luckyLoserChoices ?? {}) as DisciplinaryChoices;
    const third = groupStandings
      .filter(([, teams]) => teams.length >= 3)
      .map(([, teams]) => teams[2]);

    const sorted = [...third].sort((a, b) => {
      const pa = a.W * 3 + a.D, pb = b.W * 3 + b.D;
      if (pb !== pa) return pb - pa;
      const ga = a.GF - a.GA, gb = b.GF - b.GA;
      if (gb !== ga) return gb - ga;
      return b.GF - a.GF;
    });

    const qualifying = new Set<string>();
    let filled = 0;
    let i = 0;
    while (i < sorted.length && filled < luckyLosers) {
      let j = i + 1;
      while (
        j < sorted.length &&
        sorted[j].W * 3 + sorted[j].D === sorted[i].W * 3 + sorted[i].D &&
        sorted[j].GF - sorted[j].GA === sorted[i].GF - sorted[i].GA &&
        sorted[j].GF === sorted[i].GF
      ) j++;
      const bucket = sorted.slice(i, j);
      const remaining = luckyLosers - filled;
      if (bucket.length <= remaining) {
        for (const tm of bucket) qualifying.add(tm.teamId);
        filled += bucket.length;
      } else {
        const key = makeDisciplinaryKey(bucket.map(tm => tm.teamId));
        const ranked = luckyLoserChoices[key] ?? [];
        if (ranked.length >= bucket.length) {
          for (const tid of ranked.slice(0, remaining)) qualifying.add(tid);
        }
        filled += remaining;
        break;
      }
      i = j;
    }
    return qualifying;
  }, [groupStandings, userTiebreakerChoices, tournament]);

  useEffect(() => {
    if (lastResultInitialized.current || allGroupMatches.length === 0) return;
    const lastCompletedIdx = allGroupMatches.reduce(
      (acc, m, i) => (m.status === 'completed' ? i : acc),
      -1
    );
    if (lastCompletedIdx >= 0) {
      setCurrentMatchIdx(lastCompletedIdx);
    }
    lastResultInitialized.current = true;
  }, [allGroupMatches]);

  if (isLoading || predsLoading || matchListFetching) {
    return <LoadingSpinner />;
  }
  if (error) {
    const msg = error instanceof ApiError ? error.message : t('competitionDetail.failedToLoad');
    return <p className="p-8 text-sm text-destructive">{msg}</p>;
  }
  if (predsError) {
    const msg = predsError instanceof ApiError ? predsError.message : 'Failed to load predictions';
    return <p className="p-8 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

  const match = allGroupMatches[currentMatchIdx];
  const canGoPrev = currentMatchIdx > 0;
  const canGoNext = currentMatchIdx < allGroupMatches.length - 1;

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-2 text-sm text-muted-foreground">
        <Link to={`/competitions/${id}`} className="hover:underline">
          ← {competition.name}
        </Link>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <UserAvatar username={username} imageUrl={imageUrl} iconColor={iconColor} className="h-10 w-10" />
        <div>
          <h1 className="text-xl font-bold">{username}</h1>
          <p className="text-xs text-muted-foreground">{t('competitionDetail.leaderboard.player')}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mb-6 border-b">
        {([
          ['group', t('competitionDetail.tabs.groupStage')],
          ...(groupStandings.length > 0 ? [['tables', t('competitionDetail.tabs.groupTables')] as const] : []),
          ...(showKnockoutTab ? [['knockout', t('competitionDetail.tabs.knockoutStage')] as const] : []),
          ['bonus', t('competitionDetail.tabs.bonusQuestions')],
        ] as ['group' | 'tables' | 'knockout' | 'bonus', string][]).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'group' && (
        <div>
          {allGroupMatches.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('competitionDetail.predictions.noMatches')}</p>
          ) : (
            <>
              <div className="mb-5">
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {allGroupMatches.map((m, idx) => {
                    const isCurrent = idx === currentMatchIdx;
                    const pred = predMap[m.id];
                    const hasPred = !!pred;
                    const hasActual = m.status === 'completed' && m.homeScore !== null && m.awayScore !== null;
                    const isCorrectResult = hasPred && hasActual &&
                      Math.sign(pred.homeScore - pred.awayScore) === Math.sign(m.homeScore! - m.awayScore!);
                    const isExactScore = hasPred && hasActual &&
                      pred.homeScore === m.homeScore && pred.awayScore === m.awayScore;
                    const dotClass = isCurrent
                      ? 'w-5 h-2.5 bg-primary'
                      : !hasPred
                      ? 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                      : !hasActual
                      ? 'w-2.5 h-2.5 bg-yellow-300'
                      : isExactScore
                      ? 'w-2.5 h-2.5 bg-green-500 ring-1 ring-offset-1 ring-offset-background ring-amber-400'
                      : isCorrectResult
                      ? 'w-2.5 h-2.5 bg-green-500'
                      : 'w-2.5 h-2.5 bg-red-500';
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setCurrentMatchIdx(idx)}
                        className={`rounded-full transition-all duration-200 ${dotClass}${pred?.isReplacement ? ' opacity-40' : ''}`}
                        aria-label={`Match ${idx + 1}`}
                      />
                    );
                  })}
                </div>
              </div>

              {match && (() => {
                const pred = predMap[match.id];
                const hasActual = match.status === 'completed' && match.homeScore !== null && match.awayScore !== null;
                const isCorrectResult = hasActual && pred != null &&
                  Math.sign(pred.homeScore - pred.awayScore) === Math.sign(match.homeScore! - match.awayScore!);
                const isExactScore = hasActual && pred != null &&
                  pred.homeScore === match.homeScore && pred.awayScore === match.awayScore;

                return (
                  <div className="rounded-xl border bg-muted/20 p-5">
                    <div className="text-center mb-4">
                      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                        {stageLabel(match.stage, match.groupName)}
                      </p>
                      {match.scheduledAt && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {new Date(match.scheduledAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                          {' · '}
                          {new Date(match.scheduledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {currentMatchIdx + 1} / {allGroupMatches.length}
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setCurrentMatchIdx(i => Math.max(0, i - 1))}
                        disabled={!canGoPrev}
                        className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20"
                        aria-label="Previous match"
                      >←</button>

                      <div className="flex-1">
                        <div className={`rounded-xl border-2 shadow-sm overflow-hidden w-full max-w-xs mx-auto ${isCorrectResult ? 'border-green-400 bg-green-50/60 dark:bg-green-950/25' : 'bg-card'}`}>
                          <div className="flex items-center gap-3 px-4 py-3.5">
                            {match.homeTeamImageUrl ? (
                              <img src={match.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                            )}
                            <span className="flex-1 text-sm font-medium truncate">{tn(match.homeTeamName) || 'TBD'}</span>
                            <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>
                              {pred ? pred.homeScore : '—'}
                            </span>
                          </div>
                          <div className="h-px bg-border" />
                          <div className="flex items-center gap-3 px-4 py-3.5">
                            {match.awayTeamImageUrl ? (
                              <img src={match.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                            )}
                            <span className="flex-1 text-sm font-medium truncate">{tn(match.awayTeamName) || 'TBD'}</span>
                            <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>
                              {pred ? pred.awayScore : '—'}
                            </span>
                          </div>
                        </div>

                        <div className="mt-2 text-center space-y-0.5">
                          {hasActual && (
                            <p className="text-xs text-muted-foreground">
                              {t('competitionDetail.predictions.actualResult')}: {match.homeScore}–{match.awayScore}
                            </p>
                          )}
                          {hasActual && pred && (() => {
                            const cfg = competition.scoringConfig;
                            const exactScore = isExactScore ? cfg.exact_score : 0;
                            const correctResult = isCorrectResult ? cfg.correct_result : 0;
                            const total = exactScore + correctResult;
                            return (
                              <div className="flex flex-wrap justify-center items-center gap-x-2 gap-y-0.5 text-xs">
                                <span className={`font-semibold ${total > 0 ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                                  {total > 0 ? `+${total} pts` : '0 pts'}
                                </span>
                              </div>
                            );
                          })()}
                          {!pred && !hasActual && (
                            <p className="text-xs text-muted-foreground italic">No prediction</p>
                          )}
                        </div>

                        <div className="mt-3 flex sm:hidden items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setCurrentMatchIdx(i => Math.max(0, i - 1))}
                            disabled={!canGoPrev}
                            className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
                            aria-label="Previous match"
                          >←</button>
                          <button
                            type="button"
                            onClick={() => setCurrentMatchIdx(i => Math.min(allGroupMatches.length - 1, i + 1))}
                            disabled={!canGoNext}
                            className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
                            aria-label="Next match"
                          >→</button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setCurrentMatchIdx(i => Math.min(allGroupMatches.length - 1, i + 1))}
                        disabled={!canGoNext}
                        className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20"
                        aria-label="Next match"
                      >→</button>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {activeTab === 'tables' && (
        <div className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            {groupStandings.map(([groupName, teams]) => (
              <div key={groupName} className="rounded-lg border dark:bg-white/5 p-2">
                <div className="bg-muted/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Group {groupName}
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="pl-3 py-1.5 text-left w-6">#</th>
                      <th className="py-1.5 text-left">Team</th>
                      <th className="py-1.5 text-center w-6">P</th>
                      <th className="py-1.5 text-center w-6">W</th>
                      <th className="py-1.5 text-center w-6">D</th>
                      <th className="py-1.5 text-center w-6">L</th>
                      <th className="py-1.5 text-center w-8">GF</th>
                      <th className="py-1.5 text-center w-8">GA</th>
                      <th className="py-1.5 text-center w-8 font-bold text-foreground">Pts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {teams.map((tm, i) => (
                      <tr key={tm.teamId} className={
                        i < 2
                          ? 'bg-green-50 dark:bg-green-950/30'
                          : i === 2 && qualifyingThirdPlaceIds.has(tm.teamId)
                          ? 'bg-yellow-50 dark:bg-yellow-950/30'
                          : ''
                      }>
                        <td className="pl-3 py-1.5 text-muted-foreground">{i + 1}</td>
                        <td className="py-1.5 pr-2">
                          <div className="flex items-center gap-1.5">
                            {tm.imageUrl ? (
                              <img src={tm.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="h-4 w-4 rounded-full bg-muted flex-shrink-0" />
                            )}
                            <span className="truncate">{tn(tm.teamName)}</span>
                          </div>
                        </td>
                        <td className="py-1.5 text-center text-muted-foreground">{tm.P}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{tm.W}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{tm.D}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{tm.L}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{tm.GF}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{tm.GA}</td>
                        <td className="py-1.5 text-center font-bold">{tm.W * 3 + tm.D}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-green-500/70 inline-block" /> {t('competitionDetail.tables.qualifying')}
            </span>
            {(tournament?.knockoutConfig?.luckyLosers ?? 0) > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-yellow-400/70 inline-block" /> {t('competitionDetail.tables.luckyLoser')}
              </span>
            )}
          </div>
        </div>
      )}

      {activeTab === 'knockout' && id && (
        <KnockoutStageContent
          competitionId={id}
          viewUserId={userId}
        />
      )}

      {activeTab === 'bonus' && id && competition && (
        <BonusQuestionsTab
          tournamentId={competition.tournamentId}
          competitionId={id}
          deadlinePassed={true}
          viewUserId={userId}
        />
      )}
    </main>
  );
}
