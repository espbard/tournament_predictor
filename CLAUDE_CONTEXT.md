# Claude Project Context — Sports Tournament Prediction App

> **HOW TO USE THIS FILE**
> Paste the entire contents of this file at the start of every new Claude conversation.
> Keep it updated as the project grows. Sections marked [UPDATE AS YOU BUILD] should be
> revised after each session.

---

## Project Overview

A web application for predicting sports tournament outcomes. Used by a small private group
(max ~20 people) for fun — not commercial. Development speed is the priority over security.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript |
| Styling | Tailwind CSS, shadcn/ui |
| Client state | Zustand |
| Server state / fetching | TanStack Query v5 |
| Routing | React Router v7 |
| Backend | Node.js, Express, TypeScript |
| ORM | Drizzle ORM |
| Database | PostgreSQL (hosted on Railway) |
| Auth | Lucia Auth (username + password, no email verification) |
| Validation | Zod (shared between client and server) |
| Testing | Vitest |
| Deployment | Railway (single service: Express serves built React as static files) |

---

## Repository Structure

[UPDATE AS YOU BUILD — paste output of `eza --tree --git-ignore -L 4` here]

```
.
├── CLAUDE_CONTEXT.md
├── client
│   ├── components.json
│   ├── index.html
│   ├── package.json
│   ├── postcss.config.js
│   ├── src
│   │   ├── App.tsx
│   │   ├── components
│   │   │   ├── AppLayout.tsx
│   │   │   ├── ImageUpload.tsx
│   │   │   └── Navbar.tsx
│   │   ├── index.css
│   │   ├── lib
│   │   │   ├── api.ts
│   │   │   └── utils.ts
│   │   ├── main.tsx
│   │   ├── pages
│   │   │   ├── AdminHomePage.tsx
│   │   │   ├── CompetitionDetailPage.tsx
│   │   │   ├── CompetitionsPage.tsx
│   │   │   ├── EditTeamPage.tsx
│   │   │   ├── EditTournamentPage.tsx
│   │   │   ├── EditUserPage.tsx
│   │   │   ├── HomePage.tsx
│   │   │   ├── KnockoutStagePredictionsPage.tsx
│   │   │   ├── LoginPage.tsx
│   │   │   ├── RegisterPage.tsx
│   │   │   ├── TournamentDetailPage.tsx
│   │   │   ├── TournamentKnockoutPage.tsx
│   │   │   └── TournamentsPage.tsx
│   │   └── store
│   │       └── authStore.ts
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── vite.config.ts
├── package-lock.json
├── package.json
├── railway.toml
├── README.md
├── server
│   ├── drizzle
│   │   ├── 0000_amazing_killmonger.sql
│   │   ├── 0001_little_blizzard.sql
│   │   ├── 0002_easy_terrax.sql
│   │   ├── 0003_puzzling_white_tiger.sql
│   │   ├── 0004_eminent_silver_centurion.sql
│   │   ├── 0005_knockout_config.sql
│   │   ├── 0006_bracket_predictions.sql
│   │   └── meta
│   │       ├── 0000_snapshot.json
│   │       ├── 0001_snapshot.json
│   │       ├── 0002_snapshot.json
│   │       ├── 0003_snapshot.json
│   │       └── 0004_snapshot.json
│   ├── drizzle.config.ts
│   ├── package.json
│   ├── src
│   │   ├── db
│   │   │   ├── client.ts
│   │   │   ├── migrate.ts
│   │   │   └── schema.ts
│   │   ├── index.ts
│   │   ├── lib
│   │   │   ├── r2.ts
│   │   │   └── scoring.ts
│   │   ├── middleware
│   │   │   └── auth.ts
│   │   └── routes
│   │       ├── auth.ts
│   │       ├── competitions.ts
│   │       ├── tournaments.ts
│   │       └── upload.ts
│   └── tsconfig.json
└── shared
    ├── package.json
    └── src
        ├── index.ts
        ├── schemas.ts
        └── types.ts

```

---

## Database Schema

[UPDATE AS YOU BUILD — paste your current Drizzle schema file(s) here]

```typescript
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  integer,
  json,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type { ScoringConfig } from '@tournament-predictor/shared';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const tournamentStatusEnum = pgEnum('tournament_status', [
  'upcoming',
  'active',
  'completed',
]);

export const matchStageEnum = pgEnum('match_stage', [
  'group',
  'round_of_16',
  'quarter_final',
  'semi_final',
  'final',
]);

export const matchStatusEnum = pgEnum('match_status', ['scheduled', 'completed']);

// ── Tables ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  hashedPassword: text('hashed_password').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Lucia v3 sessions table
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
});

export const tournaments = pgTable('tournaments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: tournamentStatusEnum('status').notNull().default('upcoming'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  group: text('group'),
});

export const matches = pgTable('matches', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  homeTeamId: text('home_team_id').references(() => teams.id),
  awayTeamId: text('away_team_id').references(() => teams.id),
  stage: matchStageEnum('stage').notNull(),
  scheduledAt: timestamp('scheduled_at'),
  status: matchStatusEnum('status').notNull().default('scheduled'),
  homeScore: integer('home_score'),
  awayScore: integer('away_score'),
});

export const competitions = pgTable('competitions', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  inviteCode: text('invite_code').notNull().unique(),
  scoringConfig: json('scoring_config').notNull().$type<ScoringConfig>(),
  predictionDeadline: timestamp('prediction_deadline'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const competitionMembers = pgTable('competition_members', {
  competitionId: text('competition_id')
    .notNull()
    .references(() => competitions.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
});

export const predictions = pgTable('predictions', {
  id: text('id').primaryKey(),
  competitionId: text('competition_id')
    .notNull()
    .references(() => competitions.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  matchId: text('match_id')
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  homeScore: integer('home_score').notNull(),
  awayScore: integer('away_score').notNull(),
  // For knockout draws: which team the user thinks will progress from ET/pens
  progressingTeamId: text('progressing_team_id').references(() => teams.id),
  points: integer('points'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ── Relations ─────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  competitionMembers: many(competitionMembers),
  predictions: many(predictions),
}));

export const tournamentsRelations = relations(tournaments, ({ many }) => ({
  teams: many(teams),
  matches: many(matches),
  competitions: many(competitions),
}));

export const matchesRelations = relations(matches, ({ one }) => ({
  tournament: one(tournaments, {
    fields: [matches.tournamentId],
    references: [tournaments.id],
  }),
  homeTeam: one(teams, {
    fields: [matches.homeTeamId],
    references: [teams.id],
  }),
  awayTeam: one(teams, {
    fields: [matches.awayTeamId],
    references: [teams.id],
  }),
}));

export const competitionsRelations = relations(competitions, ({ one, many }) => ({
  tournament: one(tournaments, {
    fields: [competitions.tournamentId],
    references: [tournaments.id],
  }),
  members: many(competitionMembers),
  predictions: many(predictions),
}));
```

Key tables:
- `users` — registered players
- `tournaments` — e.g. "2026 FIFA World Cup"
- `teams` — teams participating in a tournament
- `matches` — scheduled/completed games within a tournament
- `competitions` — a prediction competition tied to a tournament
- `competition_members` — which users are in which competition
- `predictions` — per-user, per-match score predictions
- `group_predictions` — predicted group stage standings
- `knockout_predictions` — predicted team for each knockout round

---

## API Conventions

- Base path: `/api`
- Auth: session cookie (Lucia), checked via `requireAuth` middleware
- Error format: `{ error: string, details?: any }`
- Success format: direct object or array (no wrapper)
- All endpoints are REST (no GraphQL, no tRPC)

### Endpoint Map

[UPDATE AS YOU BUILD — add new endpoints as they are created]

```
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/tournaments
POST   /api/tournaments
GET    /api/tournaments/:id
PATCH  /api/tournaments/:id

GET    /api/tournaments/:id/teams
POST   /api/tournaments/:id/teams

GET    /api/tournaments/:id/matches
POST   /api/tournaments/:id/matches
PATCH  /api/matches/:id

GET    /api/competitions
POST   /api/competitions
GET    /api/competitions/:id
GET    /api/competitions/:id/leaderboard
POST   /api/competitions/:id/join

GET    /api/competitions/:id/predictions   — returns current user's predictions
POST   /api/competitions/:id/predictions   — upsert a prediction (checks deadline)
```

---

## Scoring System

Points are awarded per competition based on a `scoring_config` JSON object stored with the
competition. The scoring engine lives in `server/src/lib/scoring.ts` as a pure function.

### Default scoring config

```json
{
  "exact_score": 3, // After 90 minutes, extra time and penalties are not counted.
  "correct_result": 1, // Correct on which team wins/draws
  "correct_group_position": 2, // Exact end position of a team in their group (based on guessed results)
  "correct_team_progresses": 3, // Points if the user guesses that the correct team win the tie (user can guess draw and select which team they believe will progress from extra time/penalties)
  "correct_team_in_knockout_tie": 2, // Points if the predictions the user has made up to this point results in the correct team' being in the specific knockout tie.
  "correct_team_in_final": 5, // Replaces "correct_team_in_knockout_tie" for the final game 
  "correct_winner": 10 // Bonus if user guesses correct tournament winner
  // More score sources will be added later. Bonus questions that can have different scores based on difficulty of question will be one of them
}
```

Points are calculated and written to the `predictions` table when an admin marks a match
as completed with its final score.

---

## Auth Model

- Sessions managed by Lucia Auth, stored in the database
- Session cookie: `http-only`, no `secure` flag needed (dev speed priority)
- No email verification, no password reset flow (out of scope)
- Admin role: a boolean `is_admin` column on the `users` table
- Only admins can: create tournaments, add teams/matches, enter results, trigger scoring, add bonus questions

---

## Environment Variables

```env
# .env (never commit — see .env.example for keys)
DATABASE_URL=postgresql://postgres:lkKgPHqyNYbfpwIGkxsrPzuFGUdKfHoL@postgres.railway.internal:5432/railway
SESSION_SECRET=7H$=hkACX8fwuJFbxyln{(pB}5yU8cl&
NODE_ENV=development
PORT=5432
CLIENT_URL=http://localhost:5173   # Only used in dev for CORS
```

---

## Deployment (Railway)

- Single Railway service
- Build command: `npm run build` (builds both client and server)
- Start command: `npm run start` (Express serves the built React app from `client/dist/`)
- PostgreSQL is a separate Railway plugin (same project)
- All env vars set in Railway dashboard

---

## Current Build Status

[UPDATE AS YOU BUILD]

### Completed
- [x] Initial scaffold
- [x] DB schema + Drizzle migrations
- [x] Auth — register, login, session middleware
- [x] Tournament CRUD — create tournament, add teams and matches (admin only)
- [x] Image uploads — profile pictures (users), logos (tournaments), icons (teams) via Cloudflare R2
- [x] Added landing pages with navigation and logout
- [x] Implement Group CRUD. It is now possible to create, edit and delete groups
- [x] Add Competition CRUD, limit non-admin users to only see competitions they are part of
- [x] Added basic color scheme
- [x] Predictions UI — per-match score inputs in CompetitionDetailPage, deadline enforcement, save per match, show actual result vs prediction for completed matches
- [x] Add round of 32 and bronze final as possible stages
- [x] Add live predicted tables
- [x] Add full tournament knockout creation


### In Progress
- [ ] Create knockout predictions page, seems to be working, except for bronze final not being filled.

### Known Issues / Tech Debt
-
---

## Image Upload Architecture

- **Storage:** Cloudflare R2 (S3-compatible), bucket `tournament-predictor-assets`
- **Upload flow:** client → `POST /api/upload` (multer + @aws-sdk/client-s3) → R2 → returns public URL → URL stored in DB
- **File limits:** 5 MB, image types only (jpeg/png/gif/webp)
- **Keys:** `{users|tournaments|teams}/{uuid}{ext}`
- **Public URL base:** set via `R2_PUBLIC_URL` env var (R2 dev domain or custom domain)
- **Reusable component:** `client/src/components/ImageUpload.tsx` — handles preview, upload, and error display
- **Edit pages:** `/settings` (user profile pic), `/tournaments/:id/edit` (admin), `/teams/:teamId/edit` (admin)

---

## TODO

[UPDATE AS YOU BUILD — or keep this in a separate TODO.md and paste it here]

### Next Session
1. Scoring engine — pure function + Vitest unit tests, triggered when admin marks match complete

### Backlog (in order)
1. Score calculation trigger — admin marks match complete → points calculated
2. Leaderboard — ranked view per competition
3. Group stage predictions
4. Knockout bracket predictions
5. Polish — UI improvements, mobile layout

---

## Key Decisions & Constraints

- **No security hardening needed** — small trusted group, dev speed is priority
- **No email/SMTP** — auth is username + password only, no verification
- **No external auth providers** — Lucia with local credentials only
- **Single Railway service** — Express serves React build as static files to minimize cost
- **Open source only** — no paid services beyond Railway
- **No React Native / mobile app** — responsive web only
- **TypeScript everywhere** — client, server, and shared types

---

## How to Give Claude Tasks

Use this template at the start of each task block:

```
[paste this entire CLAUDE_CONTEXT.md first]

---

## Current Task

[describe exactly what you want built]

## Relevant existing files

[paste the content of any files Claude needs to read or modify]

## Expected output

[list the files Claude should create or modify, with their paths]
```

---

## First Prompt (Run This Next)

After pasting this context file, use the following to kick off the scaffold:

> **Task:** Generate the complete project scaffold. Output every file with its full path and
> complete contents. Do not skip or abbreviate any file.
>
> Files to generate:
> - `package.json` (root, npm workspaces for `client/`, `server/`, `shared/`)
> - `server/package.json`, `server/tsconfig.json`
> - `server/src/index.ts` — Express entry, serves `client/dist` as static in production
> - `server/src/db/client.ts` — Drizzle + postgres connection
> - `server/src/db/schema.ts` — full initial schema (users, tournaments, teams, matches, competitions, competition_members, predictions, sessions)
> - `server/src/db/migrate.ts` — migration runner script
> - `server/src/middleware/auth.ts` — Lucia session middleware, `requireAuth`, `requireAdmin`
> - `server/src/routes/auth.ts` — register, login, logout, me
> - `server/src/lib/scoring.ts` — stub scoring function with full signature
> - `client/package.json`, `client/tsconfig.json`, `client/index.html`
> - `client/vite.config.ts` — with proxy to Express API in dev
> - `client/src/main.tsx`, `client/src/App.tsx` — React Router setup with placeholder pages
> - `client/src/lib/api.ts` — fetch wrapper pointed at `/api`
> - `client/src/store/authStore.ts` — Zustand store for current user
> - `shared/package.json`, `shared/src/types.ts`, `shared/src/schemas.ts`
> - `.env.example`
> - `railway.toml`
> - `.gitignore`