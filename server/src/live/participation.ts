import { and, eq } from 'drizzle-orm';
import { isLiveFixtureSelected } from '@tournament-predictor/shared';
import { db } from '../db/client';
import {
  liveBonusAnswers,
  liveFixtures,
  livePredictions,
  liveScorerPredictions,
  liveTablePredictions,
} from '../db/liveSchema';
import { loadSelectionIndex } from './selections';

// ── Who is playing ────────────────────────────────────────────────────────────
//
// A live competition collects members long before it collects predictions, and some of
// them never get round to predicting at all. While the tournament is still ahead of
// everybody that is fine — a leaderboard of zeros is the roster, and seeing your name on
// it is half of why you joined. Once matches have actually been played it stops being
// the roster and becomes a tail of people who are not in the game, pushing everyone who
// is off the bottom of a phone screen and drawing a flat line along the foot of the
// points chart.
//
// So from the first completed match, a member who has not submitted anything is left out
// of the leaderboard and the progression chart. Two deliberate choices in that rule:
//
//   * "Submitted anything" means any prediction — a fixture, the league table, the
//     top-scorer ranking, a bonus answer — not only a fixture prediction. Hiding a member
//     who ranked the table but has not reached the fixtures yet would take their table
//     points off the leaderboard with them, and a leaderboard that omits points somebody
//     has actually scored is wrong in a way that a slightly long list is not.
//   * A completed match means one that counts: finished, and selected for its gameweek.
//     A tournament whose finished fixtures were all left out of their gameweeks has not
//     started as far as this competition is concerned.
//
// The filter never empties the view. A competition opened mid-season, where matches are
// already behind but nobody has predicted yet, would otherwise show no members at all
// and read as broken; there the roster is still the most useful thing to print.

export interface LiveParticipation {
  /** True once at least one fixture that counts towards this competition has been played. */
  hasCompletedFixtures: boolean;
  /** Members who have submitted a prediction of any kind. */
  participantIds: Set<string>;
}

export async function loadLiveParticipation(
  competitionId: string,
  liveTournamentId: string,
): Promise<LiveParticipation> {
  const [
    finishedFixtures,
    selections,
    fixturePredictors,
    tablePredictors,
    scorerPredictors,
    bonusPredictors,
  ] = await Promise.all([
    db
      .select({
        id: liveFixtures.id,
        stageKey: liveFixtures.stageKey,
        matchday: liveFixtures.matchday,
      })
      .from(liveFixtures)
      .where(
        and(
          eq(liveFixtures.liveTournamentId, liveTournamentId),
          eq(liveFixtures.status, 'finished'),
        ),
      ),
    loadSelectionIndex(liveTournamentId),
    db
      .selectDistinct({ userId: livePredictions.userId })
      .from(livePredictions)
      .where(eq(livePredictions.liveCompetitionId, competitionId)),
    db
      .selectDistinct({ userId: liveTablePredictions.userId })
      .from(liveTablePredictions)
      .where(eq(liveTablePredictions.liveCompetitionId, competitionId)),
    db
      .selectDistinct({ userId: liveScorerPredictions.userId })
      .from(liveScorerPredictions)
      .where(eq(liveScorerPredictions.liveCompetitionId, competitionId)),
    db
      .selectDistinct({ userId: liveBonusAnswers.userId })
      .from(liveBonusAnswers)
      .where(eq(liveBonusAnswers.liveCompetitionId, competitionId)),
  ]);

  return {
    hasCompletedFixtures: finishedFixtures.some(f => isLiveFixtureSelected(f, selections)),
    participantIds: new Set(
      [...fixturePredictors, ...tablePredictors, ...scorerPredictors, ...bonusPredictors].map(
        r => r.userId,
      ),
    ),
  };
}

/**
 * Drop the members who have not predicted, once there is anything to have predicted for.
 *
 * Order is preserved, so a caller that has already sorted and ranked keeps its order —
 * though ranking after filtering is what the leaderboard does, so that a hidden member
 * cannot leave a gap in the numbers.
 */
export function filterLiveParticipants<T extends { userId: string }>(
  members: T[],
  participation: LiveParticipation,
): T[] {
  if (!participation.hasCompletedFixtures) return members;
  const participants = members.filter(m => participation.participantIds.has(m.userId));
  return participants.length > 0 ? participants : members;
}
