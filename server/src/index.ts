import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from './db/client';
import { tournaments, players } from './db/schema';
import { generateId } from 'lucia';
import { authRouter } from './routes/auth';
import { tournamentsRouter, matchesRouter, teamsRouter } from './routes/tournaments';
import { uploadRouter } from './routes/upload';
import { imagesRouter } from './routes/images';
import { competitionsRouter } from './routes/competitions';
import { settingsRouter } from './routes/settings';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// CORS only needed in dev — in production React is served from the same origin
if (process.env.NODE_ENV !== 'production') {
  app.use(
    cors({
      origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
      credentials: true,
    })
  );
}

app.use(express.json());

// API routes
app.use('/api/auth', authRouter);
app.use('/api/tournaments', tournamentsRouter);
app.use('/api/matches', matchesRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/images', imagesRouter);
app.use('/api/competitions', competitionsRouter);
app.use('/api/settings', settingsRouter);

// Serve built React app in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function start() {
  console.log('Running migrations…');
  await migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  // Defensive: ensure is_leaderboard_user column exists regardless of migration state
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS "is_leaderboard_user" boolean NOT NULL DEFAULT false`);
  console.log('Migrations complete.');

  // Seed initial Haaland player if no players exist
  const existingPlayers = await db.select().from(players).limit(1);
  if (existingPlayers.length === 0) {
    const [firstTournament] = await db.select().from(tournaments).limit(1);
    if (firstTournament) {
      await db.insert(players).values({
        id: generateId(15),
        tournamentId: firstTournament.id,
        name: 'Erling Haaland',
        gamesPlayed: 1,
        goalsScored: 2,
      });
      console.log('Seeded initial player: Erling Haaland');
    }
  }
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
