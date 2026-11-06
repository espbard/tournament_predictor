import { and, eq } from 'drizzle-orm';
import { liveBonusAnswerMatches, type LiveBonusConstraints } from '@tournament-predictor/shared';
import { db } from '../db/client';
import {
  liveBonusAnswers,
  liveBonusQuestions,
  liveCompetitions,
} from '../db/liveSchema';

// ── Live bonus question scoring ───────────────────────────────────────────────
//
// Season-long side bets. Two rules:
//
//   * points are only awarded once an admin marks the question finalized, so nobody can
//     watch their bonus total move — and infer a correct answer — before it is settled;
//   * an answer matches case-insensitively after trimming, and a question may accept
//     several correct answers (stored as a JSON array).
//
// Scoring writes points onto the answers only. The rollup onto
// live_competition_members.bonusPoints — and into totalPoints — is left to
// recomputeLiveMemberTotals() in scoringTrigger.ts, which is the single place that sums
// every point source; callers run it with the competition ids returned here.

/**
 * A stored correct answer, as the list of answers that count.
 *
 * Several answers are stored as a JSON array — "which team wins the group?" can have a
 * tie. Anything that is not JSON is the answer itself, which is also how single answers
 * are stored.
 */
export function parseLiveCorrectAnswers(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch {
    // Not JSON — a plain single answer.
  }
  return [raw];
}

/**
 * Pure scoring rule: all-or-nothing per question.
 *
 * The comparison itself lives in shared/src/live/bonus.ts, so what counts as right here is
 * exactly what the answer input allowed — including a number question's leeway, where
 * anything within ±leeway of the correct answer scores in full.
 */
export function computeLiveBonusPoints(
  question: { correctAnswer: string | null; points: number } & Partial<LiveBonusConstraints>,
  answerText: string,
): number {
  const correct = parseLiveCorrectAnswers(question.correctAnswer);
  if (correct.length === 0) return 0;
  const constraints: LiveBonusConstraints = {
    answerType: question.answerType ?? 'number',
    leeway: question.leeway ?? null,
  };
  return correct.some(c => liveBonusAnswerMatches(constraints, c, answerText))
    ? question.points
    : 0;
}

type ScorableQuestion = {
  id: string;
  correctAnswer: string | null;
  points: number;
  finalized: boolean;
} & Partial<LiveBonusConstraints>;

/**
 * Score every answer to one question.
 *
 * A finalized question with a correct answer awards its points; any other question has
 * its answers cleared back to null rather than stored as zero, so the UI can tell "not
 * scored" from "scored, nothing earned" — and un-finalizing a question takes its points
 * away again.
 */
async function applyQuestionScores(question: ScorableQuestion): Promise<number> {
  if (!question.finalized || question.correctAnswer === null) {
    await db
      .update(liveBonusAnswers)
      .set({ points: null, updatedAt: new Date() })
      .where(eq(liveBonusAnswers.questionId, question.id));
    return 0;
  }

  const answers = await db
    .select({ id: liveBonusAnswers.id, answer: liveBonusAnswers.answer })
    .from(liveBonusAnswers)
    .where(eq(liveBonusAnswers.questionId, question.id));

  for (const answer of answers) {
    await db
      .update(liveBonusAnswers)
      .set({ points: computeLiveBonusPoints(question, answer.answer), updatedAt: new Date() })
      .where(eq(liveBonusAnswers.id, answer.id));
  }
  return answers.length;
}

async function competitionIdsFor(liveTournamentId: string): Promise<string[]> {
  const rows = await db
    .select({ id: liveCompetitions.id })
    .from(liveCompetitions)
    .where(eq(liveCompetitions.liveTournamentId, liveTournamentId));
  return rows.map(r => r.id);
}

export interface LiveBonusScoringResult {
  /** Answers whose points were written. Zero for a question that is not finalized. */
  scoredAnswers: number;
  affectedCompetitionIds: string[];
}

/**
 * Score one question — called when an admin changes its correct answer, its finalized
 * flag, or anything else that decides what an answer is worth.
 */
export async function scoreLiveBonusQuestion(questionId: string): Promise<LiveBonusScoringResult> {
  const [question] = await db
    .select()
    .from(liveBonusQuestions)
    .where(eq(liveBonusQuestions.id, questionId));
  if (!question) return { scoredAnswers: 0, affectedCompetitionIds: [] };

  const scoredAnswers = await applyQuestionScores(question);
  return {
    scoredAnswers,
    affectedCompetitionIds: await competitionIdsFor(question.liveTournamentId),
  };
}

/**
 * Score every bonus question on a tournament. Run from a full recalculation and when the
 * tournament's status changes, as a consistency pass — it is each question's own
 * finalized flag that decides whether points are awarded.
 */
export async function scoreAllLiveBonusQuestions(
  liveTournamentId: string,
): Promise<LiveBonusScoringResult> {
  const competitionIds = await competitionIdsFor(liveTournamentId);
  const questions = await db
    .select()
    .from(liveBonusQuestions)
    .where(eq(liveBonusQuestions.liveTournamentId, liveTournamentId));

  let scoredAnswers = 0;
  for (const question of questions) {
    scoredAnswers += await applyQuestionScores(question);
  }

  return { scoredAnswers, affectedCompetitionIds: competitionIds };
}

/** Answers a member has given in one competition, for the rollup and the read models. */
export async function loadLiveBonusAnswers(
  liveCompetitionId: string,
  userId: string,
): Promise<Array<typeof liveBonusAnswers.$inferSelect>> {
  return db
    .select()
    .from(liveBonusAnswers)
    .where(
      and(
        eq(liveBonusAnswers.liveCompetitionId, liveCompetitionId),
        eq(liveBonusAnswers.userId, userId),
      ),
    );
}
