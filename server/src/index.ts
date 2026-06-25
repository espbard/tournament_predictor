import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import bcrypt from 'bcryptjs';
import { db } from './db/client';
import { tournaments, players, users, competitions, competitionMembers } from './db/schema';
import { generateId } from 'lucia';
import { authRouter } from './routes/auth';
import { tournamentsRouter, matchesRouter, teamsRouter } from './routes/tournaments';
import { uploadRouter } from './routes/upload';
import { imagesRouter } from './routes/images';
import { competitionsRouter } from './routes/competitions';
import { settingsRouter } from './routes/settings';
import { feedbackRouter } from './routes/feedback';
import { recalculateAllScoresForTournament } from './lib/scoringTrigger';

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
app.use('/api/feedback', feedbackRouter);

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
  // Defensive: ensure is_comparison_user column exists regardless of migration state
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS "is_comparison_user" boolean NOT NULL DEFAULT false`);
  // Defensive: ensure is_late_addition column exists regardless of migration state
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS "is_late_addition" boolean NOT NULL DEFAULT false`);
  // Defensive: ensure late_addition_points column exists regardless of migration state
  await db.execute(sql`ALTER TABLE competition_members ADD COLUMN IF NOT EXISTS "late_addition_points" integer NOT NULL DEFAULT 0`);
  // Defensive: ensure late_addition_window_ends_at column exists regardless of migration state
  await db.execute(sql`ALTER TABLE competition_members ADD COLUMN IF NOT EXISTS "late_addition_window_ends_at" timestamp`);
  // Defensive: ensure is_replacement column exists regardless of migration state
  await db.execute(sql`ALTER TABLE predictions ADD COLUMN IF NOT EXISTS "is_replacement" boolean NOT NULL DEFAULT false`);
  // Defensive: ensure allow_late_additions column exists regardless of migration state
  await db.execute(sql`ALTER TABLE competitions ADD COLUMN IF NOT EXISTS "allow_late_additions" boolean NOT NULL DEFAULT true`);
  // Defensive: ensure icon_color column exists regardless of migration state
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS "icon_color" text`);
  // Defensive: ensure feedback table and enums exist regardless of migration state
  await db.execute(sql`DO $$ BEGIN CREATE TYPE "feedback_type" AS ENUM ('feature_request', 'improvement', 'bug'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await db.execute(sql`DO $$ BEGIN CREATE TYPE "feedback_status" AS ENUM ('pending', 'will_do', 'implemented', 'fixed', 'wont_do'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "feedback" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "type" "feedback_type" NOT NULL,
      "message" text NOT NULL,
      "status" "feedback_status" NOT NULL DEFAULT 'pending',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  // Defensive: ensure players table exists regardless of migration state
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "players" (
      "id" text PRIMARY KEY NOT NULL,
      "tournament_id" text NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "games_played" integer NOT NULL DEFAULT 0,
      "goals_scored" integer NOT NULL DEFAULT 0
    )
  `);
  console.log('Migrations complete.');

  // Defensive: fix any competitions still using correct_group_position=2 (old default).
  // Updates the stored config to 1 and triggers a full recalculation so scores are
  // recomputed from scratch with the correct value rather than relying on a halving approximation.
  try {
    const staleComps = await db
      .select({ id: competitions.id, tournamentId: competitions.tournamentId })
      .from(competitions)
      .where(sql`(${competitions.scoringConfig}->>'correct_group_position')::int = 2`);
    if (staleComps.length > 0) {
      await db.execute(sql`
        UPDATE competitions
        SET scoring_config = (scoring_config::jsonb || '{"correct_group_position": 1}'::jsonb)::json
        WHERE (scoring_config->>'correct_group_position')::int = 2
      `);
      const tournamentIds = [...new Set(staleComps.map(c => c.tournamentId))];
      for (const tid of tournamentIds) {
        await recalculateAllScoresForTournament(tid);
      }
      console.log(`Fixed correct_group_position (2→1) and recalculated scores for ${tournamentIds.length} tournament(s).`);
    }
  } catch (err) {
    console.warn('correct_group_position fix skipped:', err);
  }

  // Seed icon colors for any users that don't have one yet
  try {
    const usersWithoutColor = await db.select({ id: users.id }).from(users).where(isNull(users.iconColor));
    for (const u of usersWithoutColor) {
      const h = Math.floor(Math.random() * 360);
      const s = (55 + Math.floor(Math.random() * 30)) / 100;
      const l = (30 + Math.floor(Math.random() * 15)) / 100;
      const k = (n: number) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => {
        const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        return Math.round(255 * c).toString(16).padStart(2, '0');
      };
      const color = `#${f(0)}${f(8)}${f(4)}`;
      await db.update(users).set({ iconColor: color }).where(eq(users.id, u.id));
    }
    if (usersWithoutColor.length > 0) {
      console.log(`Seeded icon colors for ${usersWithoutColor.length} user(s).`);
    }
  } catch (err) {
    console.warn('Icon color seeding skipped:', err);
  }

  // Seed initial Haaland player if no players exist
  try {
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
  } catch (err) {
    console.warn('Player seed skipped:', err);
  }

  // Seed comparison users for Fotball-VM 2026
  try {
    const comparisonUsernames = ['1-1 bot', 'ChatGPT', 'Claude'];
    const hashedPassword = await bcrypt.hash('Test123', 10);

    for (const username of comparisonUsernames) {
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
      if (!existing) {
        await db.insert(users).values({
          id: crypto.randomUUID(),
          username,
          hashedPassword,
          isAdmin: false,
          isTestAccount: false,
          isLeaderboardUser: false,
          isComparisonUser: true,
        });
        console.log(`Seeded comparison user: ${username}`);
      }
    }

    // Add comparison users to all existing Fotball-VM 2026 competitions
    const [vm2026] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.name, 'Fotball-VM 2026')).limit(1);
    if (vm2026) {
      const vm2026Comps = await db.select({ id: competitions.id }).from(competitions).where(eq(competitions.tournamentId, vm2026.id));
      const comparisonUsers = await db.select({ id: users.id }).from(users).where(eq(users.isComparisonUser, true));
      for (const comp of vm2026Comps) {
        for (const cu of comparisonUsers) {
          const [existing] = await db.select().from(competitionMembers).where(and(eq(competitionMembers.competitionId, comp.id), eq(competitionMembers.userId, cu.id))).limit(1);
          if (!existing) {
            await db.insert(competitionMembers).values({ competitionId: comp.id, userId: cu.id });
          }
        }
      }
    }
  } catch (err) {
    console.warn('Comparison user seed skipped:', err);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
