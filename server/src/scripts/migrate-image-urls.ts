import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

const BUCKET = process.env.R2_BUCKET_NAME ?? 'tournament-predictor-assets';
// Matches both pub-xxx.r2.dev and any custom domain that includes the bucket name
const R2_PATTERN = `%r2.dev%${BUCKET}/%`;

async function migrateImageUrls() {
  const tables = ['users', 'tournaments', 'teams', 'competitions'];

  for (const table of tables) {
    const result = await db.execute(
      sql.raw(`
        UPDATE ${table}
        SET image_url = '/api/images/' || split_part(image_url, '${BUCKET}/', 2)
        WHERE image_url LIKE '${R2_PATTERN}'
        RETURNING id, image_url
      `)
    );
    console.log(`${table}: updated ${result.length} row(s)`);
  }

  console.log('Done.');
  process.exit(0);
}

migrateImageUrls().catch((err) => {
  console.error(err);
  process.exit(1);
});
