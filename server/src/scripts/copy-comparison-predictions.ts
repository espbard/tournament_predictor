import 'dotenv/config';
import { eq, and, inArray } from 'drizzle-orm';
import { generateId } from 'lucia';
import { db } from '../db/client';
import {
  users,
  competitions,
  competitionMembers,
  predictions,
  bracketPredictions,
  bonusAnswers,
  bonusQuestions,
} from '../db/schema';
import { recalculateAllScoresForTournament } from '../lib/scoringTrigger';

async function main() {
  const comparisonUsers = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.isComparisonUser, true));

  if (comparisonUsers.length === 0) {
    console.log('No comparison users found.');
    process.exit(0);
  }
  console.log(`Found ${comparisonUsers.length} comparison user(s)`);

  const affectedTournamentIds = new Set<string>();

  for (const compUser of comparisonUsers) {
    console.log(`\n── ${compUser.username} ──`);

    // Find competitions where this user already has predictions (potential sources)
    const sourceCandidates = await db
      .select({
        competitionId: predictions.competitionId,
        competitionName: competitions.name,
        tournamentId: competitions.tournamentId,
      })
      .from(predictions)
      .innerJoin(competitions, eq(competitions.id, predictions.competitionId))
      .where(eq(predictions.userId, compUser.id));

    if (sourceCandidates.length === 0) {
      console.log('  No predictions found in any competition, skipping');
      continue;
    }

    // Group by tournament, pick the competition with the most predictions as source
    const byTournament = new Map<string, { competitionId: string; competitionName: string; count: number }>();
    for (const row of sourceCandidates) {
      const existing = byTournament.get(row.tournamentId);
      if (!existing) {
        byTournament.set(row.tournamentId, { competitionId: row.competitionId, competitionName: row.competitionName, count: 1 });
      } else {
        existing.count += 1;
      }
    }

    for (const [tournamentId, source] of byTournament) {
      // Find ALL competitions for this tournament (not just ones the user is a member of)
      const allCompsForTournament = await db
        .select({ id: competitions.id, name: competitions.name })
        .from(competitions)
        .where(eq(competitions.tournamentId, tournamentId));

      const targets = allCompsForTournament.filter(c => c.id !== source.competitionId);
      if (targets.length === 0) {
        console.log(`  Tournament ${tournamentId}: only 1 competition, skipping`);
        continue;
      }

      console.log(`  Tournament ${tournamentId}: source = "${source.competitionName}" → ${targets.length} target(s)`);

      const [sourceMembership] = await db
        .select({ groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices, luckyLoserChoices: competitionMembers.luckyLoserChoices })
        .from(competitionMembers)
        .where(and(eq(competitionMembers.competitionId, source.competitionId), eq(competitionMembers.userId, compUser.id)));

      const sourcePreds = await db
        .select()
        .from(predictions)
        .where(and(eq(predictions.competitionId, source.competitionId), eq(predictions.userId, compUser.id)));

      const [sourceBracket] = await db
        .select()
        .from(bracketPredictions)
        .where(and(
          eq(bracketPredictions.competitionId, source.competitionId),
          eq(bracketPredictions.userId, compUser.id),
        ));

      const sourceAnswers = await db
        .select()
        .from(bonusAnswers)
        .where(and(
          eq(bonusAnswers.competitionId, source.competitionId),
          eq(bonusAnswers.userId, compUser.id),
        ));

      for (const target of targets) {
        console.log(`    → copying to "${target.name}"`);

        // Ensure membership (add if missing)
        const [existingMembership] = await db
          .select()
          .from(competitionMembers)
          .where(and(eq(competitionMembers.competitionId, target.id), eq(competitionMembers.userId, compUser.id)));

        if (!existingMembership) {
          await db.insert(competitionMembers).values({ competitionId: target.id, userId: compUser.id });
          console.log(`      (added as member)`);
        }

        if (sourcePreds.length > 0) {
          await db.delete(predictions).where(and(
            eq(predictions.competitionId, target.id),
            eq(predictions.userId, compUser.id),
          ));
          await db.insert(predictions).values(
            sourcePreds.map(p => ({
              id: generateId(15),
              competitionId: target.id,
              userId: compUser.id,
              matchId: p.matchId,
              homeScore: p.homeScore,
              awayScore: p.awayScore,
              progressingTeamId: p.progressingTeamId,
              points: null,
            })),
          );
          console.log(`      ${sourcePreds.length} match predictions copied`);
        }

        if (sourceBracket) {
          await db.insert(bracketPredictions)
            .values({
              competitionId: target.id,
              userId: compUser.id,
              predictions: sourceBracket.predictions,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [bracketPredictions.competitionId, bracketPredictions.userId],
              set: { predictions: sourceBracket.predictions, updatedAt: new Date() },
            });
          console.log(`      bracket predictions copied`);
        }

        if (sourceAnswers.length > 0) {
          const questionIds = [...new Set(sourceAnswers.map(a => a.questionId))];
          const validQuestions = await db
            .select({ id: bonusQuestions.id })
            .from(bonusQuestions)
            .where(and(eq(bonusQuestions.tournamentId, tournamentId), inArray(bonusQuestions.id, questionIds)));
          const validQuestionIds = new Set(validQuestions.map(q => q.id));
          const answersToInsert = sourceAnswers.filter(a => validQuestionIds.has(a.questionId));
          if (answersToInsert.length > 0) {
            await db.delete(bonusAnswers).where(and(
              eq(bonusAnswers.competitionId, target.id),
              eq(bonusAnswers.userId, compUser.id),
            ));
            await db.insert(bonusAnswers).values(
              answersToInsert.map(a => ({
                id: generateId(15),
                questionId: a.questionId,
                competitionId: target.id,
                userId: compUser.id,
                answer: a.answer,
                points: null,
              })),
            );
            console.log(`      ${answersToInsert.length} bonus answers copied`);
          }
        }

        if (sourceMembership?.groupDisciplinaryChoices || sourceMembership?.luckyLoserChoices) {
          await db.update(competitionMembers)
            .set({
              groupDisciplinaryChoices: sourceMembership.groupDisciplinaryChoices,
              luckyLoserChoices: sourceMembership.luckyLoserChoices,
            })
            .where(and(
              eq(competitionMembers.competitionId, target.id),
              eq(competitionMembers.userId, compUser.id),
            ));
          console.log(`      tiebreaker choices copied`);
        }

        affectedTournamentIds.add(tournamentId);
      }
    }
  }

  if (affectedTournamentIds.size === 0) {
    console.log('\nNothing to recalculate.');
    process.exit(0);
  }

  console.log(`\nRecalculating scores for ${affectedTournamentIds.size} tournament(s)…`);
  await Promise.all([...affectedTournamentIds].map(tid => recalculateAllScoresForTournament(tid)));
  console.log('Done.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
