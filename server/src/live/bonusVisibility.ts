// ── Live bonus question visibility ────────────────────────────────────────────
//
// A question's correct answer stays hidden from regular members until an admin marks it
// finalized — the same moment its points are awarded. Admins and test accounts may see the
// answer earlier, but nobody except admins sees points on a question that is not finalized.
// Same rule as the manual type's lib/bonusVisibility.ts, kept separate so the live
// namespace does not depend on it.

export function redactLiveBonusQuestions<T extends { correctAnswer: string | null; finalized: boolean }>(
  questions: T[],
  canSeeAnswers: boolean,
): T[] {
  if (canSeeAnswers) return questions;
  return questions.map(q =>
    q.finalized || q.correctAnswer === null ? q : { ...q, correctAnswer: null },
  );
}

/**
 * Points are withheld as well as unawarded: scoring does not write points for a question
 * that is not finalized, but one an admin un-finalized could leave scored rows behind, and
 * a member must not be able to infer a correct answer from them.
 */
export function redactLiveBonusAnswerPoints<T extends { questionId: string; points: number | null }>(
  answers: T[],
  finalizedQuestionIds: ReadonlySet<string>,
  isAdmin: boolean,
): T[] {
  if (isAdmin) return answers;
  return answers.map(a =>
    a.points === null || finalizedQuestionIds.has(a.questionId) ? a : { ...a, points: null },
  );
}
