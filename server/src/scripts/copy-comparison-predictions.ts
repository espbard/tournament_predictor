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

    const memberships = await db
      .select({
        competitionId: competitionMembers.competitionId,
        tournamentId: competitions.tournamentId,
        competitionName: competitions.name,
        groupDisciplinaryChoices: competitionMembers.groupDisciplinaryChoices,
        luckyLoserChoices: competitionMembers.luckyLoserChoices,
      })
      .from(competitionMembers)
      .innerJoin(competitions, eq(competitions.id, competitionMembers.competitionId))
      .where(eq(competitionMembers.userId, compUser.id));

    // Group by tournamentId
    const byTournament = new Map<string, typeof memberships>();
    for (const m of memberships) {
      if (!byTournament.has(m.tournamentId)) byTournament.set(m.tournamentId, []);
      byTournament.get(m.tournamentId)!.push(m);
    }

    for (const [tournamentId, comps] of byTournament) {
      if (comps.length <= 1) {
        console.log(`  Tournament ${tournamentId}: only 1 competition, skipping`);
        continue;
      }

      // Pick source: competition with the most match predictions
      let sourceComp: typeof comps[number] | null = null;
      let maxPredCount = -1;

      for (const comp of comps) {
        const rows = await db
          .select({ id: predictions.id })
          .from(predictions)
          .where(and(eq(predictions.competitionId, comp.competitionId), eq(predictions.userId, compUser.id)));
        if (rows.length > maxPredCount) {
          maxPredCount = rows.length;
          sourceComp = comp;
        }
      }

      if (!sourceComp || maxPredCount === 0) {
        console.log(`  Tournament ${tournamentId}: no predictions found in any competition, skipping`);
        continue;
      }

      console.log(`  Tournament ${tournamentId}: source = "${sourceComp.competitionName}" (${maxPredCount} match predictions)`);

      // Fetch all source data
      const sourcePreds = await db
        .select()
        .from(predictions)
        .where(and(eq(predictions.competitionId, sourceComp.competitionId), eq(predictions.userId, compUser.id)));

      const [sourceBracket] = await db
        .select()
        .from(bracketPredictions)
        .where(and(
          eq(bracketPredictions.competitionId, sourceComp.competitionId),
          eq(bracketPredictions.userId, compUser.id),
        ));

      // Bonus answers: keyed by questionId so we can look them up per question
      const sourceAnswers = await db
        .select()
        .from(bonusAnswers)
        .where(and(
          eq(bonusAnswers.competitionId, sourceComp.competitionId),
          eq(bonusAnswers.userId, compUser.id),
        ));

      const targets = comps.filter(c => c.competitionId !== sourceComp!.competitionId);

      for (const target of targets) {
        console.log(`    → copying to "${target.competitionName}"`);

        // ── 1. Match predictions ──────────────────────────────────────────────
        if (sourcePreds.length > 0) {
          // Remove any existing predictions the user may have in the target competition
          await db
            .delete(predictions)
            .where(and(eq(predictions.competitionId, target.competitionId), eq(predictions.userId, compUser.id)));

          await db.insert(predictions).values(
            sourcePreds.map(p => ({
              id: generateId(15),
              competitionId: target.competitionId,
              userId: compUser.id,
              matchId: p.matchId,
              homeScore: p.homeScore,
              awayScore: p.awayScore,
              progressingTeamId: p.progressingTeamId,
              points: null, // will be recalculated
            })),
          );
          console.log(`      ${sourcePreds.length} match predictions copied`);
        }

        // ── 2. Bracket predictions ────────────────────────────────────────────
        if (sourceBracket) {
          await db
            .insert(bracketPredictions)
            .values({
              competitionId: target.competitionId,
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

        // ── 3. Bonus answers ──────────────────────────────────────────────────
        if (sourceAnswers.length > 0) {
          // Verify questions belong to this tournament (they should — same tournamentId)
          const questionIds = [...new Set(sourceAnswers.map(a => a.questionId))];
          const validQuestions = await db
            .select({ id: bonusQuestions.id })
            .from(bonusQuestions)
            .where(and(
              eq(bonusQuestions.tournamentId, tournamentId),
              inArray(bonusQuestions.id, questionIds),
            ));
          const validQuestionIds = new Set(validQuestions.map(q => q.id));
          const answersToInsert = sourceAnswers.filter(a => validQuestionIds.has(a.questionId));

          if (answersToInsert.length > 0) {
            await db
              .delete(bonusAnswers)
              .where(and(
                eq(bonusAnswers.competitionId, target.competitionId),
                eq(bonusAnswers.userId, compUser.id),
              ));

            await db.insert(bonusAnswers).values(
              answersToInsert.map(a => ({
                id: generateId(15),
                questionId: a.questionId,
                competitionId: target.competitionId,
                userId: compUser.id,
                answer: a.answer,
                points: null,
              })),
            );
            console.log(`      ${answersToInsert.length} bonus answers copied`);
          }
        }

        // ── 4. Tiebreaker choices (groupDisciplinary + luckyLoser) ────────────
        if (sourceComp.groupDisciplinaryChoices || sourceComp.luckyLoserChoices) {
          await db
            .update(competitionMembers)
            .set({
              groupDisciplinaryChoices: sourceComp.groupDisciplinaryChoices,
              luckyLoserChoices: sourceComp.luckyLoserChoices,
            })
            .where(and(
              eq(competitionMembers.competitionId, target.competitionId),
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
