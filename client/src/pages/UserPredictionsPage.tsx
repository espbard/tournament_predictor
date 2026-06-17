import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import KnockoutStageContent from '@/components/KnockoutStageContent';
import BonusQuestionsTab from '@/pages/BonusQuestionsTab';
import { useT } from '@/lib/useT';
import type { Competition, Prediction, MatchStage } from '@tournament-predictor/shared';

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

  const [activeTab, setActiveTab] = useState<'group' | 'knockout' | 'bonus'>(
    searchParams.get('tab') === 'bonus' ? 'bonus' : 'group'
  );
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const lastResultInitialized = useRef(false);

  const { data: competition, isLoading, error } = useQuery({
    queryKey: ['competitions', id],
    queryFn: () => api.get<Competition>(`/competitions/${id}`),
    enabled: !!id,
  });

  const { data: matchList = [] } = useQuery({
    queryKey: ['tournaments', competition?.tournamentId, 'matches'],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${competition!.tournamentId}/matches`),
    enabled: !!competition,
  });

  const { data: userPreds, isLoading: predsLoading, error: predsError } = useQuery({
    queryKey: ['competitions', id, 'predictions', userId],
    queryFn: () => api.get<{ predictions: Prediction[]; username: string; imageUrl: string | null }>(`/competitions/${id}/predictions/${userId}`),
    enabled: !!id && !!userId,
  });

  const username = userPreds?.username ?? '';
  const imageUrl = userPreds?.imageUrl ?? null;
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

  if (isLoading || predsLoading) {
    return <p className="p-8 text-sm text-muted-foreground">{t('common.loading')}</p>;
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
        <img
          src={imageUrl ?? '/default-avatar.png'}
          alt={username}
          className="h-10 w-10 rounded-full object-cover border"
        />
        <div>
          <h1 className="text-xl font-bold">{username}</h1>
          <p className="text-xs text-muted-foreground">{t('competitionDetail.leaderboard.player')}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mb-6 border-b">
        {([
          ['group', t('competitionDetail.tabs.groupStage')],
          ...(showKnockoutTab ? [['knockout', t('competitionDetail.tabs.knockoutStage')] as const] : []),
          ['bonus', t('competitionDetail.tabs.bonusQuestions')],
        ] as ['group' | 'knockout' | 'bonus', string][]).map(([tab, label]) => (
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
                    const hasPred = m.status === 'completed' || !!pred;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setCurrentMatchIdx(idx)}
                        className={`rounded-full transition-all duration-200 ${
                          isCurrent
                            ? 'w-5 h-2.5 bg-primary'
                            : hasPred
                            ? 'w-2.5 h-2.5 bg-green-500'
                            : 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                        }`}
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
                            <span className="flex-1 text-sm font-medium truncate">{match.homeTeamName ?? 'TBD'}</span>
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
                            <span className="flex-1 text-sm font-medium truncate">{match.awayTeamName ?? 'TBD'}</span>
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
