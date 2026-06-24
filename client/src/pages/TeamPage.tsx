import { useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import { useTeamName } from '@/lib/teamTranslations';
import BackButton from '@/components/BackButton';
import type { Competition, Prediction, MatchStage, BracketPredictions } from '@tournament-predictor/shared';

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
  progressingTeamId: string | null;
  groupName: string | null;
}

export default function TeamPage() {
  const { id, teamId } = useParams<{ id: string; teamId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { t, language } = useT();
  const { tn } = useTeamName();
  const dateLocale = { no: 'nb-NO', en: 'en-GB', de: 'de-DE' }[language];

  const effectiveUserId = searchParams.get('userId') ?? user?.id ?? '';

  function stageLabel(stage: MatchStage, groupName?: string | null): string {
    if (stage === 'group' && groupName) return `${t('common.group')} ${groupName}`;
    const map: Record<MatchStage, string> = {
      group: t('stages.group'),
      round_of_32: t('stages.round_of_32'),
      round_of_16: t('stages.round_of_16'),
      quarter_final: t('stages.quarter_final'),
      semi_final: t('stages.semi_final'),
      bronze_final: t('stages.bronze_final'),
      final: t('stages.final'),
    };
    return map[stage] ?? stage;
  }

  const { data: competition, isLoading: competitionLoading } = useQuery({
    queryKey: ['competitions', id],
    queryFn: () => api.get<Competition>(`/competitions/${id}`),
    enabled: !!id,
  });

  const { data: matchList = [], isLoading: matchListLoading } = useQuery({
    queryKey: ['tournaments', competition?.tournamentId, 'matches'],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${competition!.tournamentId}/matches`),
    enabled: !!competition,
  });

  const { data: userPreds, isLoading: predsLoading } = useQuery({
    queryKey: ['competitions', id, 'predictions', effectiveUserId],
    queryFn: () => api.get<{ predictions: Prediction[]; username: string; imageUrl: string | null; iconColor: string | null }>(`/competitions/${id}/predictions/${effectiveUserId}`),
    enabled: !!id && !!effectiveUserId,
    select: (data: { predictions: Prediction[]; username: string; imageUrl: string | null; iconColor: string | null } | Prediction[]) =>
      Array.isArray(data)
        ? { predictions: data, username: '', imageUrl: null, iconColor: null }
        : data,
  });

  const { data: bracketPreds } = useQuery({
    queryKey: ['competitions', id, 'bracket-predictions', effectiveUserId],
    queryFn: () => api.get<BracketPredictions>(`/competitions/${id}/bracket-predictions/${effectiveUserId}`),
    enabled: !!id && !!effectiveUserId,
  });

  const predictions = userPreds?.predictions ?? [];
  const viewUsername = userPreds?.username ?? '';

  const predMap = useMemo(
    () => Object.fromEntries(predictions.map(p => [p.matchId, p])),
    [predictions]
  );

  // Build matchId → predKey map for knockout matches (mirrors KnockoutStageContent logic)
  const matchIdToPredKey = useMemo(() => {
    const koStages = new Set(['round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'bronze_final', 'final']);
    const byStage = new Map<string, MatchWithTeams[]>();
    for (const m of matchList) {
      if (!koStages.has(m.stage)) continue;
      if (!byStage.has(m.stage)) byStage.set(m.stage, []);
      byStage.get(m.stage)!.push(m);
    }
    for (const ms of byStage.values()) {
      ms.sort((a, b) => {
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      });
    }
    const result = new Map<string, string>();
    for (const [stage, ms] of byStage) {
      ms.forEach((m, i) => result.set(m.id, `${stage}_${i}`));
    }
    return result;
  }, [matchList]);

  const teamInfo = useMemo(() => {
    for (const m of matchList) {
      if (m.homeTeamId === teamId) return { name: m.homeTeamName, imageUrl: m.homeTeamImageUrl };
      if (m.awayTeamId === teamId) return { name: m.awayTeamName, imageUrl: m.awayTeamImageUrl };
    }
    return { name: null, imageUrl: null };
  }, [matchList, teamId]);

  const teamMatches = useMemo(() => {
    return matchList
      .filter(m => m.homeTeamId === teamId || m.awayTeamId === teamId)
      .sort((a, b) => {
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      });
  }, [matchList, teamId]);

  if (competitionLoading || matchListLoading || predsLoading) {
    return <LoadingSpinner />;
  }
  if (!competition) return null;

  const isViewingOtherUser = effectiveUserId !== user?.id;

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <BackButton onClick={() => navigate(-1)} />

      <div className="flex items-center gap-3 mb-4">
        {teamInfo.imageUrl ? (
          <img src={teamInfo.imageUrl} alt="" className="h-10 w-10 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="h-10 w-10 rounded-full bg-muted flex-shrink-0" />
        )}
        <h1 className="text-xl font-bold">{tn(teamInfo.name) || '—'}</h1>
      </div>

      {isViewingOtherUser && viewUsername && (
        <p className="text-sm text-muted-foreground mb-6">
          {viewUsername}'s predictions
        </p>
      )}

      {teamMatches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches found for this team.</p>
      ) : (
        <div className="space-y-4">
          {teamMatches.map(match => {
            const isGroup = match.stage === 'group';
            const hasActual = match.status === 'completed' && match.homeScore !== null && match.awayScore !== null;

            let displayHomeScore: number | null = null;
            let displayAwayScore: number | null = null;
            let hasPred = false;
            let isCorrectResult = false;
            let isExactScore = false;
            let groupPoints: number | null = null;

            if (isGroup) {
              const pred = predMap[match.id];
              if (pred) {
                hasPred = true;
                displayHomeScore = pred.homeScore;
                displayAwayScore = pred.awayScore;
                if (hasActual) {
                  isCorrectResult = Math.sign(pred.homeScore - pred.awayScore) === Math.sign(match.homeScore! - match.awayScore!);
                  isExactScore = pred.homeScore === match.homeScore && pred.awayScore === match.awayScore;
                  const exactPts = isExactScore ? competition.scoringConfig.exact_score : 0;
                  const correctPts = isCorrectResult ? competition.scoringConfig.correct_result : 0;
                  groupPoints = exactPts + correctPts;
                }
              }
            } else {
              const predKey = matchIdToPredKey.get(match.id);
              const bracketPred = predKey ? bracketPreds?.[predKey] : undefined;
              if (bracketPred) {
                hasPred = true;
                const flipped = bracketPred.flipped ?? false;
                displayHomeScore = flipped ? bracketPred.awayScore : bracketPred.homeScore;
                displayAwayScore = flipped ? bracketPred.homeScore : bracketPred.awayScore;
                if (hasActual) {
                  isCorrectResult = Math.sign(displayHomeScore - displayAwayScore) === Math.sign(match.homeScore! - match.awayScore!);
                  isExactScore = displayHomeScore === match.homeScore && displayAwayScore === match.awayScore;
                }
              }
            }

            return (
              <div key={match.id} className="rounded-xl border bg-muted/20 p-5">
                <div className="text-center mb-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {stageLabel(match.stage, match.groupName)}
                  </p>
                  {match.scheduledAt && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(match.scheduledAt).toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short' })}
                      {' · '}
                      {new Date(match.scheduledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  )}
                </div>

                <div className={`rounded-xl border-2 shadow-sm overflow-hidden w-full max-w-xs mx-auto ${isCorrectResult ? 'border-green-400 bg-green-50/60 dark:bg-green-950/25' : 'bg-card'}`}>
                  {/* Home row */}
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    {match.homeTeamImageUrl ? (
                      <img src={match.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                    )}
                    <span className="flex-1 text-sm font-medium truncate">{tn(match.homeTeamName) || 'TBD'}</span>
                    <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>
                      {hasPred && displayHomeScore !== null ? displayHomeScore : '—'}
                    </span>
                  </div>
                  <div className="h-px bg-border" />
                  {/* Away row */}
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    {match.awayTeamImageUrl ? (
                      <img src={match.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                    )}
                    <span className="flex-1 text-sm font-medium truncate">{tn(match.awayTeamName) || 'TBD'}</span>
                    <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>
                      {hasPred && displayAwayScore !== null ? displayAwayScore : '—'}
                    </span>
                  </div>
                </div>

                <div className="mt-2 text-center space-y-0.5">
                  {hasActual && (
                    <p className="text-xs text-muted-foreground">
                      {t('competitionDetail.predictions.actualResult')}: {match.homeScore}–{match.awayScore}
                    </p>
                  )}
                  {hasActual && hasPred && isGroup && groupPoints !== null && (
                    <span className={`text-xs font-semibold ${groupPoints > 0 ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                      {groupPoints > 0 ? `+${groupPoints} pts` : '0 pts'}
                    </span>
                  )}
                  {!hasPred && !hasActual && (
                    <p className="text-xs text-muted-foreground italic">No prediction</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
