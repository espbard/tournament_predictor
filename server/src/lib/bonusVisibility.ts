import type { bonusQuestions } from '../db/schema';

// A bonus question's correct answer stays hidden from regular members until an admin marks
// the question finalized — the same moment its points are awarded, so nobody can see (or
// infer from a moving leaderboard) an answer that is not settled yet.
//
// `canSeeAnswers` is true for admins and test accounts: test accounts get an early look at
// the answer, but never at points for a question that is not finalized.
export function redactBonusQuestions<
  T extends Pick<typeof bonusQuestions.$inferSelect, 'correctAnswer' | 'finalized'>,
>(questions: T[], canSeeAnswers: boolean): T[] {
  if (canSeeAnswers) return questions;
  return questions.map(q =>
    q.finalized || q.correctAnswer === null ? q : { ...q, correctAnswer: null },
  );
}

// Points on an answer are only shown once its question is finalized. Scoring never writes
// points before then, but an admin un-finalizing a question must not leave an earlier score
// visible to anyone but admins.
export function redactBonusAnswerPoints<T extends { questionId: string; points: number | null }>(
  answers: T[],
  finalizedQuestionIds: ReadonlySet<string>,
  isAdmin: boolean,
): T[] {
  if (isAdmin) return answers;
  return answers.map(a =>
    a.points === null || finalizedQuestionIds.has(a.questionId) ? a : { ...a, points: null },
  );
}
