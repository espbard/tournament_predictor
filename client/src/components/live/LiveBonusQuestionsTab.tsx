import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { liveApi, liveKeys } from '@/lib/liveApi';
import BonusQuestionsPanel from '@/components/bonus/BonusQuestionsPanel';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/lib/useT';
import type { BonusAnswerType, Team } from '@tournament-predictor/shared';

// ── Bonus questions: live tournaments ─────────────────────────────────────────
//
// The data half of the live bonus tab. The UI is the same panel the manual type renders;
// what differs is where a question comes from and when it closes.
//
// A live competition has no competition-wide deadline, so each question carries its own
// lock state from the server — its `lockAt` if an admin set one, otherwise an hour before
// the first match of the tournament's starting stage, the same instant the table
// prediction locks. `deadlinePassed` is therefore never the thing that decides here.

interface Props {
  competitionId: string;
  liveTournamentId: string;
  /** Set when viewing another member's answers, which makes the panel read-only. */
  viewUserId?: string;
}

export default function LiveBonusQuestionsTab({
  competitionId,
  liveTournamentId,
  viewUserId,
}: Props) {
  const { user } = useAuthStore();
  const { t } = useT();
  const queryClient = useQueryClient();

  const { data: questions = [], isLoading } = useQuery({
    queryKey: liveKeys.bonusQuestions(competitionId),
    queryFn: () => liveApi.bonusQuestions(competitionId),
  });

  const { data: answers = [] } = useQuery({
    queryKey: liveKeys.bonusAnswers(competitionId, viewUserId),
    queryFn: () =>
      viewUserId
        ? liveApi.otherUserBonusAnswers(competitionId, viewUserId)
        : liveApi.bonusAnswers(competitionId),
  });

  const { data: liveTeams = [] } = useQuery({
    queryKey: liveKeys.tournamentTeams(liveTournamentId),
    queryFn: () => liveApi.tournamentTeams(liveTournamentId),
    enabled: questions.some(q => q.answerType === 'team'),
  });

  // The panel renders a team answer with its badge and knows only the manual Team shape,
  // so the live crest is mapped onto it. Nothing else of a Team is read.
  const teams = useMemo(
    () =>
      liveTeams.map(
        team =>
          ({
            id: team.id,
            tournamentId: liveTournamentId,
            name: team.name,
            imageUrl: team.crestUrl,
          }) as Team,
      ),
    [liveTeams, liveTournamentId],
  );

  return (
    <BonusQuestionsPanel
      questions={questions.map(q => ({
        id: q.id,
        question: q.question,
        answerType: q.answerType as BonusAnswerType,
        points: q.points,
        correctAnswer: q.correctAnswer,
        isLocked: q.isLocked,
        // The competition has no deadline of its own to show this next to, so each
        // question says when it closes.
        deadlineLabel: q.isLocked
          ? t('live.bonus.closed')
          : q.lockedAt
            ? t('live.bonus.deadline', { when: new Date(q.lockedAt).toLocaleString() })
            : null,
      }))}
      answers={answers}
      teams={teams}
      isLoading={isLoading}
      // Every live question carries its own lock, so this is only the fallback.
      deadlinePassed={false}
      canManage={!!user?.isAdmin}
      viewUserId={viewUserId}
      api={{
        createQuestion: body => liveApi.createBonusQuestion(liveTournamentId, body),
        updateQuestion: (questionId, body) =>
          liveApi.updateBonusQuestion(liveTournamentId, questionId, body),
        deleteQuestion: questionId => liveApi.deleteBonusQuestion(liveTournamentId, questionId),
        saveAnswer: (questionId, answer) =>
          liveApi.saveBonusAnswer(competitionId, { questionId, answer }),
      }}
      onQuestionsChanged={() => {
        queryClient.invalidateQueries({ queryKey: liveKeys.bonusQuestions(competitionId) });
        queryClient.invalidateQueries({
          queryKey: liveKeys.tournamentBonusQuestions(liveTournamentId),
        });
        // A correct answer can award points the moment the tournament is completed.
        queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(competitionId) });
      }}
      onAnswersChanged={() =>
        queryClient.invalidateQueries({ queryKey: liveKeys.bonusAnswers(competitionId, viewUserId) })
      }
    />
  );
}
