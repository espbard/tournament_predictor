import { sql } from 'drizzle-orm';
import { db } from '../db/client';

async function resetPoints() {
  await db.execute(sql`UPDATE predictions SET points = NULL`);
  console.log('Cleared predictions.points');

  await db.execute(sql`UPDATE bonus_answers SET points = NULL`);
  console.log('Cleared bonus_answers.points');

  await db.execute(sql`
    UPDATE competition_members SET
      exact_score_points = 0,
      correct_result_points = 0,
      correct_team_progresses_points = 0,
      correct_group_position_points = 0,
      correct_team_in_knockout_tie_points = 0,
      correct_team_in_final_points = 0,
      correct_winner_points = 0,
      bonus_question_points = 0
  `);
  console.log('Cleared competition_members breakdown columns');

  process.exit(0);
}

resetPoints().catch((err) => {
  console.error(err);
  process.exit(1);
});
