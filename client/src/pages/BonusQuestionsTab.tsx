import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import BonusQuestionsPanel from '@/components/bonus/BonusQuestionsPanel';
import type { BonusAnswerType, BonusQuestion, BonusAnswer, Team } from '@tournament-predictor/shared';

// ── Bonus questions: manual tournaments ───────────────────────────────────────
//
// The data half of the bonus tab — the endpoints, the query keys and the one deadline a
// manual competition has. The UI itself is in components/bonus/BonusQuestionsPanel.tsx,
// shared with the live tournament type.

interface Props {
  tournamentId: string;
  competitionId?: string;
  deadlinePassed: boolean;
  viewUserId?: string;
}

export default function BonusQuestionsTab({
  tournamentId,
  competitionId,
  deadlinePassed,
  viewUserId,
}: Props) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  const { data: questions = [], isLoading } = useQuery({
    queryKey: ['tournaments', tournamentId, 'bonus-questions'],
    queryFn: () => api.get<BonusQuestion[]>(`/tournaments/${tournamentId}/bonus-questions`),
  });

  const { data: answers = [] } = useQuery({
    queryKey: ['competitions', competitionId, 'bonus-answers', viewUserId ?? 'me'],
    queryFn: () =>
      viewUserId
        ? api.get<BonusAnswer[]>(`/competitions/${competitionId}/bonus-answers/${viewUserId}`)
        : api.get<BonusAnswer[]>(`/competitions/${competitionId}/bonus-answers`),
    enabled: !!competitionId,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['tournaments', tournamentId, 'teams'],
    queryFn: () => api.get<Team[]>(`/tournaments/${tournamentId}/teams`),
    enabled: questions.some(q => q.answerType === 'team'),
  });

  return (
    <BonusQuestionsPanel
      questions={questions}
      answers={answers}
      teams={teams}
      isLoading={isLoading}
      deadlinePassed={deadlinePassed}
      canManage={!!user?.isAdmin}
      viewUserId={viewUserId}
      api={{
        createQuestion: (body: { question: string; answerType: BonusAnswerType; points: number }) =>
          api.post<BonusQuestion>(`/tournaments/${tournamentId}/bonus-questions`, body),
        updateQuestion: (questionId, body) =>
          api.patch<BonusQuestion>(`/tournaments/${tournamentId}/bonus-questions/${questionId}`, body),
        deleteQuestion: (questionId) =>
          api.delete(`/tournaments/${tournamentId}/bonus-questions/${questionId}`),
        // No competition means the admin view on the tournament page, which has no
        // answers to save — the same guard the tab carried before the UI was extracted.
        saveAnswer: (questionId, answer) =>
          competitionId
            ? api.post(`/competitions/${competitionId}/bonus-answers`, { questionId, answer })
            : Promise.resolve(),
      }}
      onQuestionsChanged={() =>
        queryClient.invalidateQueries({ queryKey: ['tournaments', tournamentId, 'bonus-questions'] })
      }
      onAnswersChanged={() =>
        queryClient.invalidateQueries({ queryKey: ['competitions', competitionId, 'bonus-answers'] })
      }
    />
  );
}
