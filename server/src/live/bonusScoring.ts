import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  liveBonusAnswers,
  liveBonusQuestions,
  liveCompetitions,
  liveTournaments,
} from '../db/liveSchema';

// ── Live bonus question scoring ───────────────────────────────────────────────
//
// Season-long side bets. Two rules, both inherited from the manual type because they are
// what make a bonus question fair:
//
//   * points are withheld until the tournament is marked completed, so nobody can watch
//     their bonus total move — and infer a correct answer — while the season runs;
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

/** Pure scoring rule: all-or-nothing per question. */
export function computeLiveBonusPoints(
  question: { correctAnswer: string | null; points: number },
  answerText: string,
): number {
  const correct = parseLiveCorrectAnswers(question.correctAnswer);
  if (correct.length === 0) return 0;
  const given = answerText.trim().toLowerCase();
  return correct.some(c => c.trim().toLowerCase() === given) ? question.points : 0;
}

async function isTournamentCompleted(liveTournamentId: string): Promise<boolean> {
  const [tournament] = await db
    .select({ status: liveTournaments.status })
    .from(liveTournaments)
    .where(eq(liveTournaments.id, liveTournamentId));
  return tournament?.status === 'completed';
}

/**
 * Score every answer to one question, unconditionally.
 *
 * Callers are responsible for only reaching here once the tournament is completed —
 * `scoreLiveBonusQuestion` and `scoreAllLiveBonusQuestions` are the gated entry points.
 */
async function applyQuestionScores(question: {
  id: string;
  correctAnswer: string | null;
  points: number;
}): Promise<number> {
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
  /** Answers whose points were written. Zero while the tournament is not completed. */
  scoredAnswers: number;
  affectedCompetitionIds: string[];
}

/**
 * Score one question — called when an admin sets or clears its correct answer.
 *
 * A no-op while the tournament is not completed: the correct answer is stored, but the
 * points it implies are deferred to `scoreAllLiveBonusQuestions`.
 */
export async function scoreLiveBonusQuestion(questionId: string): Promise<LiveBonusScoringResult> {
  const [question] = await db
    .select()
    .from(liveBonusQuestions)
    .where(eq(liveBonusQuestions.id, questionId));
  if (!question) return { scoredAnswers: 0, affectedCompetitionIds: [] };
  if (!(await isTournamentCompleted(question.liveTournamentId))) {
    return { scoredAnswers: 0, affectedCompetitionIds: [] };
  }

  const scoredAnswers = await applyQuestionScores(question);
  return {
    scoredAnswers,
    affectedCompetitionIds: await competitionIdsFor(question.liveTournamentId),
  };
}

/**
 * Score every bonus question on a tournament.
 *
 * Called when a tournament is marked completed — which is the moment the withheld points
 * are actually awarded — and again from a full recalculation. Answers to a question with
 * no correct answer recorded are cleared back to null rather than stored as zero, so the
 * UI can tell "not scored" from "scored, nothing earned".
 */
export async function scoreAllLiveBonusQuestions(
  liveTournamentId: string,
): Promise<LiveBonusScoringResult> {
  const competitionIds = await competitionIdsFor(liveTournamentId);
  const questions = await db
    .select()
    .from(liveBonusQuestions)
    .where(eq(liveBonusQuestions.liveTournamentId, liveTournamentId));

  if (!(await isTournamentCompleted(liveTournamentId))) {
    // Not completed: nothing is awarded yet, and anything scored by an earlier run — say
    // the admin moved the tournament back to active — is taken away again.
    if (questions.length > 0) {
      await db
        .update(liveBonusAnswers)
        .set({ points: null, updatedAt: new Date() })
        .where(
          inArray(
            liveBonusAnswers.questionId,
            questions.map(q => q.id),
          ),
        );
    }
    return { scoredAnswers: 0, affectedCompetitionIds: competitionIds };
  }

  let scoredAnswers = 0;
  for (const question of questions) {
    if (question.correctAnswer === null) {
      await db
        .update(liveBonusAnswers)
        .set({ points: null, updatedAt: new Date() })
        .where(eq(liveBonusAnswers.questionId, question.id));
      continue;
    }
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
