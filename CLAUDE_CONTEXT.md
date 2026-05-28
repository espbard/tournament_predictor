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

[UPDATE AS YOU BUILD — paste output of `tree /F` here]
.gitignore
CLAUDE_CONTEXT.md
README.md

```
/
├── client/                  # React + Vite frontend
│   ├── src/
│   │   ├── components/      # Shared UI components
│   │   ├── pages/           # Route-level page components
│   │   ├── lib/             # API client, query hooks, utils
│   │   ├── store/           # Zustand stores
│   │   └── main.tsx
│   ├── index.html
│   └── vite.config.ts
├── server/                  # Express backend
│   ├── src/
│   │   ├── db/              # Drizzle schema, migrations, client
│   │   ├── routes/          # Express routers (one file per domain)
│   │   ├── middleware/      # Auth, error handling, validation
│   │   ├── lib/             # Scoring engine, helpers
│   │   └── index.ts         # Express entry point
│   └── tsconfig.json
├── shared/                  # Shared TypeScript types and Zod schemas
│   └── src/
│       ├── types.ts
│       └── schemas.ts
├── CLAUDE_CONTEXT.md        # This file
├── TODO.md                  # Current task list (see below)
├── package.json             # Root — npm workspaces
├── railway.toml             # Railway deploy config
└── .env.example
```

---

## Database Schema

[UPDATE AS YOU BUILD — paste your current Drizzle schema file(s) here]

```typescript
// server/src/db/schema.ts — paste current schema here after first session
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

GET    /api/competitions/:id/predictions
POST   /api/competitions/:id/predictions
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
- [ ] Nothing yet — project not started

### In Progress
- [ ] Initial scaffold

### Known Issues / Tech Debt
- None yet

---

## TODO

[UPDATE AS YOU BUILD — or keep this in a separate TODO.md and paste it here]

### Next Session
1. Generate full project scaffold (see "First Prompt" below)

### Backlog (in order)
1. Project scaffold — folder structure, configs, Railway setup
2. DB schema + Drizzle migrations
3. Auth — register, login, session middleware
4. Tournament CRUD — create tournament, add teams and matches (admin only)
5. Competitions — create, join via link, member list
6. Predictions UI — match score form, deadline enforcement
7. Scoring engine — pure function + Vitest unit tests
8. Score calculation trigger — admin marks match complete → points calculated
9. Leaderboard — ranked view per competition
10. Group stage predictions
11. Knockout bracket predictions
12. Polish — UI improvements, mobile layout

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