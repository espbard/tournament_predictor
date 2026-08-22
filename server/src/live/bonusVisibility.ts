// ── Live bonus question visibility ────────────────────────────────────────────
//
// Correct answers and awarded points stay hidden from members until the tournament is
// marked completed. Same rule as the manual type's lib/bonusVisibility.ts, kept separate
// so the live namespace does not depend on it — but deliberately without the manual
// version's test-account preview, which exists only for the Final Results page the live
// type does not have.

export function redactLiveBonusQuestions<T extends { correctAnswer: string | null }>(
  questions: T[],
  isAdmin: boolean,
  tournamentCompleted: boolean,
): T[] {
  if (isAdmin || tournamentCompleted) return questions;
  return questions.map(q => (q.correctAnswer === null ? q : { ...q, correctAnswer: null }));
}

/**
 * Points are withheld as well as unawarded: scoring does not run before completion, but a
 * tournament moved back out of `completed` could leave scored rows behind, and a member
 * must not be able to infer a correct answer from them.
 */
export function redactLiveBonusAnswerPoints<T extends { points: number | null }>(
  answers: T[],
  isAdmin: boolean,
  tournamentCompleted: boolean,
): T[] {
  if (isAdmin || tournamentCompleted) return answers;
  return answers.map(a => (a.points === null ? a : { ...a, points: null }));
}
