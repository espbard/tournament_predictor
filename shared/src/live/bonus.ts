import type { LiveBonusAnswerType } from './types';

// ── Bonus question constraints ────────────────────────────────────────────────
//
// What an admin may narrow about a question, and the rules that follow from it. Kept
// pure and in one place because three callers have to agree: the answer input (what it
// offers), the save route (what it accepts), and scoring (what counts as right).
//
//   * a number question may have a range, and answers outside it are refused;
//   * a number question may have a leeway, and an answer within ±leeway of the correct
//     one scores in full — there is no partial credit, a bonus question is all or nothing;
//   * a player, team or country question may list the options to choose from, and an
//     answer off the list is refused. No list means every option is available.

/** UEFA's member associations — "the countries in Europe" as a football app means it. */
export const EUROPEAN_COUNTRIES: readonly string[] = [
  'Albania', 'Andorra', 'Armenia', 'Austria', 'Azerbaijan', 'Belarus', 'Belgium',
  'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark',
  'England', 'Estonia', 'Faroe Islands', 'Finland', 'France', 'Georgia', 'Germany',
  'Gibraltar', 'Greece', 'Hungary', 'Iceland', 'Israel', 'Italy', 'Kazakhstan', 'Kosovo',
  'Latvia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Malta', 'Moldova', 'Montenegro',
  'Netherlands', 'North Macedonia', 'Northern Ireland', 'Norway', 'Poland', 'Portugal',
  'Republic of Ireland', 'Romania', 'Russia', 'San Marino', 'Scotland', 'Serbia',
  'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Türkiye', 'Ukraine', 'Wales',
];

/** The parts of a question these rules read. */
export interface LiveBonusConstraints {
  answerType: LiveBonusAnswerType;
  /** Inclusive bounds on a number answer. Null on either side leaves that side open. */
  minValue?: number | null;
  maxValue?: number | null;
  /** A number answer within ±leeway of the correct one is correct. */
  leeway?: number | null;
  /** The only answers allowed, for a player, team or country question. */
  options?: string[] | null;
}

function trimmedLower(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The answers a question accepts, or null when it accepts anything.
 *
 * `teamNames` and `countries` are the fallbacks for an unrestricted team or country
 * question — the tournament's teams and the European countries respectively. A player
 * question with no list stays open: there is no roster to check a name against.
 */
export function liveBonusOptions(
  question: LiveBonusConstraints,
  teamNames: readonly string[] = [],
): string[] | null {
  if (question.options && question.options.length > 0) return [...question.options];
  switch (question.answerType) {
    case 'country':
      return [...EUROPEAN_COUNTRIES];
    case 'team':
      return teamNames.length > 0 ? [...teamNames] : null;
    case 'yes_no':
      return ['Yes', 'No'];
    default:
      return null;
  }
}

export type LiveBonusAnswerRejection =
  | 'not_a_number'
  | 'below_minimum'
  | 'above_maximum'
  | 'not_an_option';

export type LiveBonusAnswerCheck =
  | { ok: true; /** The answer as it should be stored — an option in its canonical spelling. */ value: string }
  | { ok: false; reason: LiveBonusAnswerRejection };

/**
 * Check an answer against the question's constraints, and canonicalise it.
 *
 * An answer that only differs from an option by case or spacing is accepted and stored as
 * the option spells it, so scoring never turns on how somebody typed it.
 */
export function checkLiveBonusAnswer(
  question: LiveBonusConstraints,
  answer: string,
  teamNames: readonly string[] = [],
): LiveBonusAnswerCheck {
  const value = answer.trim();

  if (question.answerType === 'number') {
    const parsed = Number(value);
    if (value === '' || !Number.isFinite(parsed)) return { ok: false, reason: 'not_a_number' };
    if (question.minValue != null && parsed < question.minValue) {
      return { ok: false, reason: 'below_minimum' };
    }
    if (question.maxValue != null && parsed > question.maxValue) {
      return { ok: false, reason: 'above_maximum' };
    }
    return { ok: true, value: String(parsed) };
  }

  const options = liveBonusOptions(question, teamNames);
  if (!options) return { ok: true, value };

  const match = options.find(option => trimmedLower(option) === trimmedLower(value));
  if (!match) return { ok: false, reason: 'not_an_option' };
  return { ok: true, value: match };
}

/**
 * Whether a given answer counts as the correct one.
 *
 * Text matches ignore case and surrounding space. A number question with a leeway matches
 * anything within ±leeway — so "25, give or take 5" accepts 20 through 30, at full points.
 */
export function liveBonusAnswerMatches(
  question: LiveBonusConstraints,
  correctAnswer: string,
  givenAnswer: string,
): boolean {
  if (question.answerType === 'number' && question.leeway != null && question.leeway > 0) {
    const correct = Number(correctAnswer);
    const given = Number(givenAnswer);
    if (Number.isFinite(correct) && Number.isFinite(given)) {
      return Math.abs(correct - given) <= question.leeway;
    }
  }
  return trimmedLower(correctAnswer) === trimmedLower(givenAnswer);
}
