import { describe, it, expect } from 'vitest';
import {
  EUROPEAN_COUNTRIES,
  bonusQuestionLockAt,
  checkLiveBonusAnswer,
  isBonusQuestionLocked,
  liveBonusOptions,
} from '@tournament-predictor/shared';
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

// ── Constraints ───────────────────────────────────────────────────────────────
//
// The range, the leeway and the option list, checked through the same functions the answer
// input and the save route use.

describe('checkLiveBonusAnswer — number range', () => {
  const ranged = { answerType: 'number' as const, minValue: 0, maxValue: 5 };

  it('accepts a value inside the range, bounds included', () => {
    expect(checkLiveBonusAnswer(ranged, '0')).toEqual({ ok: true, value: '0' });
    expect(checkLiveBonusAnswer(ranged, '5')).toEqual({ ok: true, value: '5' });
    expect(checkLiveBonusAnswer(ranged, '3')).toEqual({ ok: true, value: '3' });
  });

  it('refuses a value outside it', () => {
    expect(checkLiveBonusAnswer(ranged, '-1')).toEqual({ ok: false, reason: 'below_minimum' });
    expect(checkLiveBonusAnswer(ranged, '6')).toEqual({ ok: false, reason: 'above_maximum' });
  });

  it('refuses something that is not a number at all', () => {
    expect(checkLiveBonusAnswer(ranged, 'five')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(checkLiveBonusAnswer(ranged, ' ')).toEqual({ ok: false, reason: 'not_a_number' });
  });

  it('leaves an open side open', () => {
    const openTop = { answerType: 'number' as const, minValue: 0, maxValue: null };
    expect(checkLiveBonusAnswer(openTop, '9999').ok).toBe(true);
    expect(checkLiveBonusAnswer(openTop, '-1').ok).toBe(false);
  });

  it('accepts any number when no range is set', () => {
    expect(checkLiveBonusAnswer({ answerType: 'number' }, '-40').ok).toBe(true);
  });
});

describe('checkLiveBonusAnswer — option lists', () => {
  const restricted = {
    answerType: 'team' as const,
    options: ['Arsenal', 'Real Madrid'],
  };

  it('accepts an option and stores it as the list spells it', () => {
    expect(checkLiveBonusAnswer(restricted, '  real madrid ')).toEqual({
      ok: true,
      value: 'Real Madrid',
    });
  });

  it('refuses anything off the list', () => {
    expect(checkLiveBonusAnswer(restricted, 'Chelsea')).toEqual({
      ok: false,
      reason: 'not_an_option',
    });
  });

  // No list means every option, which for a team question is the tournament's own teams.
  it('falls back to the tournament teams for an unrestricted team question', () => {
    const open = { answerType: 'team' as const };
    expect(checkLiveBonusAnswer(open, 'Inter', ['Inter', 'Benfica']).ok).toBe(true);
    expect(checkLiveBonusAnswer(open, 'Chelsea', ['Inter', 'Benfica'])).toEqual({
      ok: false,
      reason: 'not_an_option',
    });
  });

  it('leaves an unrestricted player question open — there is no roster to check', () => {
    expect(checkLiveBonusAnswer({ answerType: 'player' }, 'Anyone At All').ok).toBe(true);
  });

  it('checks a country against Europe, and narrows it when a list is set', () => {
    expect(checkLiveBonusAnswer({ answerType: 'country' }, 'norway')).toEqual({
      ok: true,
      value: 'Norway',
    });
    expect(checkLiveBonusAnswer({ answerType: 'country' }, 'Brazil')).toEqual({
      ok: false,
      reason: 'not_an_option',
    });
    const narrowed = { answerType: 'country' as const, options: ['Spain', 'Italy'] };
    expect(checkLiveBonusAnswer(narrowed, 'Norway').ok).toBe(false);
    expect(checkLiveBonusAnswer(narrowed, 'Italy').ok).toBe(true);
  });
});

describe('liveBonusOptions', () => {
  it('offers every European country when nothing is narrowed', () => {
    const options = liveBonusOptions({ answerType: 'country' });
    expect(options).toEqual([...EUROPEAN_COUNTRIES]);
    expect(options).toContain('Wales');
    expect(options).not.toContain('Brazil');
  });

  it('offers the admin list instead, when there is one', () => {
    expect(liveBonusOptions({ answerType: 'country', options: ['Spain'] })).toEqual(['Spain']);
  });

  it('has nothing to offer for a number', () => {
    expect(liveBonusOptions({ answerType: 'number' })).toBeNull();
  });
});

describe('computeLiveBonusPoints — leeway', () => {
  const question = { answerType: 'number' as const, correctAnswer: '25', points: 10, leeway: 5 };

  it('awards full points anywhere inside ±leeway', () => {
    for (const answer of ['20', '25', '30', '23']) {
      expect(computeLiveBonusPoints(question, answer)).toBe(10);
    }
  });

  // All or nothing: the leeway widens what counts as right, it does not scale the award.
  it('awards nothing outside it', () => {
    expect(computeLiveBonusPoints(question, '19')).toBe(0);
    expect(computeLiveBonusPoints(question, '31')).toBe(0);
  });

  it('is exact when no leeway is set', () => {
    const exact = { answerType: 'number' as const, correctAnswer: '25', points: 10 };
    expect(computeLiveBonusPoints(exact, '25')).toBe(10);
    expect(computeLiveBonusPoints(exact, '24')).toBe(0);
  });

  it('does not let a leeway loosen a text answer', () => {
    const text = { answerType: 'country' as const, correctAnswer: 'Norway', points: 4, leeway: 5 };
    expect(computeLiveBonusPoints(text, 'Norway')).toBe(4);
    expect(computeLiveBonusPoints(text, 'Sweden')).toBe(0);
  });
});
