import { describe, it, expect } from 'vitest';
import { bonusQuestionLockAt, isBonusQuestionLocked } from '@tournament-predictor/shared';
import { computeLiveBonusPoints, parseLiveCorrectAnswers } from './bonusScoring';

// ── Live bonus questions ──────────────────────────────────────────────────────
//
// Two rules with teeth: what counts as a correct answer, and when a question closes.

describe('parseLiveCorrectAnswers', () => {
  it('reads a plain single answer', () => {
    expect(parseLiveCorrectAnswers('Haaland')).toEqual(['Haaland']);
  });

  it('reads a JSON array when several answers count', () => {
    expect(parseLiveCorrectAnswers('["Arsenal","Liverpool"]')).toEqual(['Arsenal', 'Liverpool']);
  });

  it('treats an unparseable string as the answer itself rather than throwing', () => {
    expect(parseLiveCorrectAnswers('{not json')).toEqual(['{not json']);
  });

  it('has no answers when none is recorded', () => {
    expect(parseLiveCorrectAnswers(null)).toEqual([]);
  });
});

describe('computeLiveBonusPoints', () => {
  const question = { correctAnswer: 'Haaland', points: 5 };

  it('awards the full points for a match', () => {
    expect(computeLiveBonusPoints(question, 'Haaland')).toBe(5);
  });

  it('ignores case and surrounding space', () => {
    expect(computeLiveBonusPoints(question, '  haaland ')).toBe(5);
  });

  it('awards nothing for a miss', () => {
    expect(computeLiveBonusPoints(question, 'Salah')).toBe(0);
  });

  it('awards nothing while no correct answer is recorded', () => {
    expect(computeLiveBonusPoints({ correctAnswer: null, points: 5 }, 'Haaland')).toBe(0);
  });

  it('accepts any of several correct answers', () => {
    const multi = { correctAnswer: '["Arsenal","Liverpool"]', points: 3 };
    expect(computeLiveBonusPoints(multi, 'Liverpool')).toBe(3);
    expect(computeLiveBonusPoints(multi, 'Arsenal')).toBe(3);
    expect(computeLiveBonusPoints(multi, 'Chelsea')).toBe(0);
  });

  // All-or-nothing: a numeric answer one off is simply wrong.
  it('does not award partial credit on a number', () => {
    expect(computeLiveBonusPoints({ correctAnswer: '24', points: 10 }, '23')).toBe(0);
  });
});

describe('bonusQuestionLockAt', () => {
  const kickoffs = ['2026-09-16T19:00:00.000Z', '2026-09-17T19:00:00.000Z'];

  it('defaults to an hour before the first match of the stage', () => {
    expect(bonusQuestionLockAt(null, kickoffs)?.toISOString()).toBe('2026-09-16T18:00:00.000Z');
  });

  it("prefers the question's own deadline when an admin set one", () => {
    const own = '2026-10-01T12:00:00.000Z';
    expect(bonusQuestionLockAt(own, kickoffs)?.toISOString()).toBe(own);
  });

  // A question added mid-season would otherwise be born locked.
  it('lets an override reopen a question after the season has started', () => {
    const now = new Date('2026-10-05T12:00:00.000Z');
    expect(isBonusQuestionLocked(null, kickoffs, now)).toBe(true);
    expect(isBonusQuestionLocked('2026-12-01T12:00:00.000Z', kickoffs, now)).toBe(false);
  });

  it('stays open while no fixture has a date yet', () => {
    expect(bonusQuestionLockAt(null, [null, null])).toBeNull();
    expect(isBonusQuestionLocked(null, [])).toBe(false);
  });

  it('locks exactly at the deadline, not a moment later', () => {
    const at = new Date('2026-09-16T18:00:00.000Z');
    expect(isBonusQuestionLocked(null, kickoffs, at)).toBe(true);
    expect(isBonusQuestionLocked(null, kickoffs, new Date(at.getTime() - 1))).toBe(false);
  });
});
