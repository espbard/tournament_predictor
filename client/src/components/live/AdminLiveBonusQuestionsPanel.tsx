import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { liveApi, liveKeys } from '@/lib/liveApi';
import BonusQuestionsPanel from '@/components/bonus/BonusQuestionsPanel';
import { useT } from '@/lib/useT';
import type { Team } from '@tournament-predictor/shared';
import type { PanelAnswerType } from '@/components/bonus/BonusQuestionsPanel';

// Only live questions offer a country answer.
const LIVE_ANSWER_TYPES: PanelAnswerType[] = ['number', 'yes_no', 'player', 'team', 'country'];

// ── Admin: bonus questions on a live tournament ───────────────────────────────
//
// Questions belong to the tournament, so this is where they are written — the same place
// the manual type authors them from its tournament page. Members answer them inside a
// competition; there is nothing to answer here.

interface Props {
  tournamentId: string;
}

export default function AdminLiveBonusQuestionsPanel({ tournamentId }: Props) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const { data: questions = [], isLoading } = useQuery({
    queryKey: liveKeys.tournamentBonusQuestions(tournamentId),
    queryFn: () => liveApi.tournamentBonusQuestions(tournamentId),
  });

  const { data: liveTeams = [] } = useQuery({
    queryKey: liveKeys.tournamentTeams(tournamentId),
    queryFn: () => liveApi.tournamentTeams(tournamentId),
    enabled: questions.some(q => q.answerType === 'team'),
  });

  const teams = useMemo(
    () =>
      liveTeams.map(
        team =>
          ({
            id: team.id,
            tournamentId,
            name: team.name,
            imageUrl: team.crestUrl,
          }) as Team,
      ),
    [liveTeams, tournamentId],
  );

  return (
    <div className="mb-6 rounded-lg border p-5">
      <h2 className="mb-1 font-semibold">{t('live.admin.bonus.title')}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('live.admin.bonus.explainer')}</p>
      <BonusQuestionsPanel
        questions={questions.map(q => ({
          id: q.id,
          question: q.question,
          answerType: q.answerType as PanelAnswerType,
          points: q.points,
          correctAnswer: q.correctAnswer,
        minValue: q.minValue,
        maxValue: q.maxValue,
        leeway: q.leeway,
        options: q.options,
        }))}
        answers={[]}
        teams={teams}
        isLoading={isLoading}
        // Authoring only: an admin never answers, so nothing here is deadline-driven.
        deadlinePassed={false}
        canManage
        api={{
          createQuestion: body => liveApi.createBonusQuestion(tournamentId, body),
          updateQuestion: (questionId, body) =>
            liveApi.updateBonusQuestion(tournamentId, questionId, body),
          deleteQuestion: questionId => liveApi.deleteBonusQuestion(tournamentId, questionId),
          saveAnswer: () => Promise.resolve(),
        }}
        onQuestionsChanged={() =>
          queryClient.invalidateQueries({ queryKey: liveKeys.tournamentBonusQuestions(tournamentId) })
        }
        // Live questions can be narrowed, and only they offer a country answer.
      answerTypes={LIVE_ANSWER_TYPES}
      supportsConstraints
      onAnswersChanged={() => {}}
      />
    </div>
  );
}
