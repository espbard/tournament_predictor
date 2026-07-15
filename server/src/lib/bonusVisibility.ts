import type { bonusQuestions } from '../db/schema';

// Correct answers must stay hidden from non-admins until the tournament they
// belong to is marked completed — otherwise users could see (and infer
// points for) bonus answers before the tournament is actually decided.
export function redactBonusQuestions<T extends Pick<typeof bonusQuestions.$inferSelect, 'correctAnswer'>>(
  questions: T[],
  isAdmin: boolean,
  tournamentCompleted: boolean,
): T[] {
  if (isAdmin || tournamentCompleted) return questions;
  return questions.map(q => (q.correctAnswer === null ? q : { ...q, correctAnswer: null }));
}

// Bonus points must stay invisible (as well as unawarded) until the
// tournament is completed, even against any answers that were already
// scored before that point.
export function redactBonusAnswerPoints<T extends { points: number | null }>(
  answers: T[],
  isAdmin: boolean,
  tournamentCompleted: boolean,
): T[] {
  if (isAdmin || tournamentCompleted) return answers;
  return answers.map(a => (a.points === null ? a : { ...a, points: null }));
}
