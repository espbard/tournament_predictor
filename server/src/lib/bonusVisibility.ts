import type { bonusQuestions } from '../db/schema';

// Correct answers must stay hidden from regular members until the tournament
// they belong to is marked completed — otherwise users could see (and infer
// points for) bonus answers before the tournament is actually decided.
// `canSeeAll` is true for admins everywhere, and additionally for test
// accounts on the Final Results endpoints (which give test accounts an early,
// non-scoring preview of that page).
export function redactBonusQuestions<T extends Pick<typeof bonusQuestions.$inferSelect, 'correctAnswer'>>(
  questions: T[],
  canSeeAll: boolean,
  tournamentCompleted: boolean,
): T[] {
  if (canSeeAll || tournamentCompleted) return questions;
  return questions.map(q => (q.correctAnswer === null ? q : { ...q, correctAnswer: null }));
}

// Bonus points must stay invisible (as well as unawarded) until the
// tournament is completed, even against any answers that were already
// scored before that point. See `redactBonusQuestions` for what `canSeeAll` covers.
export function redactBonusAnswerPoints<T extends { points: number | null }>(
  answers: T[],
  canSeeAll: boolean,
  tournamentCompleted: boolean,
): T[] {
  if (canSeeAll || tournamentCompleted) return answers;
  return answers.map(a => (a.points === null ? a : { ...a, points: null }));
}
