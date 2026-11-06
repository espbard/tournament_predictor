import { describe, it, expect } from 'vitest';
import { redactBonusAnswerPoints, redactBonusQuestions } from './bonusVisibility';
import { redactLiveBonusAnswerPoints, redactLiveBonusQuestions } from '../live/bonusVisibility';

// ── Bonus question visibility: the per-question `finalized` flag ──────────────
//
// A correct answer is hidden from regular members until the admin finalizes the question.
// Admins and test accounts see it earlier; points for an unfinalized question are shown
// to nobody but admins. The manual and live helpers share the rule, so both run the same
// cases.

const questions = [
  { id: 'open', correctAnswer: 'Haaland', finalized: false },
  { id: 'final', correctAnswer: 'Salah', finalized: true },
  { id: 'unset', correctAnswer: null, finalized: false },
];

const answers = [
  { questionId: 'open', points: 5 },
  { questionId: 'final', points: 3 },
  { questionId: 'unset', points: null },
];
const finalizedIds = new Set(['final']);

for (const [name, redactQuestions, redactPoints] of [
  ['manual', redactBonusQuestions, redactBonusAnswerPoints],
  ['live', redactLiveBonusQuestions, redactLiveBonusAnswerPoints],
] as const) {
  describe(`${name}: correct answers`, () => {
    it('hides an unfinalized answer from a regular member', () => {
      const out = redactQuestions(questions, false);
      expect(out.map(q => q.correctAnswer)).toEqual([null, 'Salah', null]);
    });

    it('shows every recorded answer to admins and test accounts', () => {
      const out = redactQuestions(questions, true);
      expect(out.map(q => q.correctAnswer)).toEqual(['Haaland', 'Salah', null]);
    });
  });

  describe(`${name}: answer points`, () => {
    it('withholds points on an unfinalized question from non-admins, test accounts included', () => {
      const out = redactPoints(answers, finalizedIds, false);
      expect(out.map(a => a.points)).toEqual([null, 3, null]);
    });

    it('leaves admins every stored point', () => {
      const out = redactPoints(answers, finalizedIds, true);
      expect(out.map(a => a.points)).toEqual([5, 3, null]);
    });
  });
}
