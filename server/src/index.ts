import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from './db/client';
import { authRouter } from './routes/auth';
import { tournamentsRouter, matchesRouter, teamsRouter } from './routes/tournaments';
import { uploadRouter } from './routes/upload';
import { imagesRouter } from './routes/images';
import { competitionsRouter } from './routes/competitions';

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
  console.log('Migrations complete.');
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
