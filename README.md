# Tournament Predictor

A web app for predicting sports tournament outcomes. Small private groups (up to ~20 people) compete to see who can best predict match results and earn leaderboard points.

## Features

- **Tournament management** — Admins create tournaments with groups, teams, and matches
- **Private prediction groups** — Users join competitions via invite code
- **Match predictions** — Predict scores for group stage and knockout matches
- **Bracket predictions** — Predict the full knockout bracket using resolved group standings
- **Group position predictions** — Predict which teams finish where in each group
- **Bonus questions** — Custom Q&A (text, number, player, team, or yes/no)
- **Flexible scoring** — Per-competition point values for exact scores, correct results, group positions, bracket picks, and more
- **Live leaderboard** — Real-time updates via Server-Sent Events (SSE)
- **Group stage tiebreakers** — Head-to-head, goal difference, and user-configurable lucky loser choices
- **Maintenance mode** — Admins can pause the app for non-admin users
- **Image uploads** — Profile pictures, tournament and team branding (stored on Cloudflare R2)
- **Multi-language UI** — i18n translations in the frontend
- **Dark / light theme** — Toggleable in the navbar

---

## Tech stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query v5, Zustand, React Router v7, dnd-kit |
| **Backend** | Node.js 20+, Express, TypeScript, Drizzle ORM |
| **Database** | PostgreSQL |
| **Auth** | Lucia v3 (username + password, session cookie) |
| **Storage** | Cloudflare R2 (images proxied through Express) |
| **Deployment** | Railway — single Express service serving the built React app |

---

## Prerequisites

- Node.js 20+
- A PostgreSQL database (local or Railway)
- (Optional) Cloudflare R2 credentials for image uploads

---

## Local development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/tournament_predictor
NODE_ENV=development
PORT=3000
CLIENT_URL=http://localhost:5173
SESSION_SECRET=change-me

# Optional — required only for image uploads
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=tournament-predictor-assets
```

### 3. Run database migrations

Generate SQL from the Drizzle schema, then apply it:

```bash
npm run db:generate   # writes migration files to server/drizzle/
npm run db:migrate    # applies migrations to the database
```

Re-run both commands whenever you change `server/src/db/schema.ts`.

### 4. Start the dev servers

```bash
npm run dev
```

This starts two processes in parallel:

| Process | URL |
|---|---|
| Vite (React) | http://localhost:5173 |
| Express (API) | http://localhost:3000 |

Vite proxies all `/api` requests to Express, so you only ever open `localhost:5173` in the browser.

---

## Other commands

```bash
# Run only the backend (with hot reload)
npm run dev -w server

# Run only the frontend
npm run dev -w client

# Type-check without building
cd client && npx tsc --noEmit
cd server && npx tsc --noEmit

# Run scoring engine tests
npm run test -w server
```

---

## Production build

```bash
npm run build    # builds client (Vite → client/dist/) then server (tsup → server/dist/)
npm run start    # starts Express, applies pending migrations, serves client/dist/ as static files
```

The server reads `PORT` from the environment (Railway sets this automatically).

---

## Project structure

```
├── client/                  # React + Vite frontend
│   └── src/
│       ├── pages/           # 15 route-level page components
│       ├── components/      # Shared UI components (Navbar, bracket, leaderboard, etc.)
│       ├── lib/             # api.ts fetch wrapper, tiebreaker logic, i18n
│       └── store/           # Zustand stores (auth, theme, language)
├── server/                  # Express backend
│   └── src/
│       ├── db/              # Drizzle schema, client, migration runner
│       ├── routes/          # Express routers (auth, tournaments, competitions, upload, images, settings)
│       ├── middleware/       # requireAuth / requireAdmin guards (Lucia v3)
│       └── lib/             # Scoring engine, scoring trigger, SSE leaderboard events, R2 helpers
│   └── drizzle/             # Generated SQL migration files
├── shared/                  # Zod schemas and TypeScript types shared by client and server
└── package.json             # npm workspaces root
```

### Key server files

| File | Purpose |
|---|---|
| `server/src/db/schema.ts` | All Drizzle table definitions and relations |
| `server/src/routes/tournaments.ts` | Tournament, group, team, match, and bonus question CRUD |
| `server/src/routes/competitions.ts` | Competition CRUD, predictions, bracket, leaderboard, SSE |
| `server/src/lib/scoring.ts` | Core scoring logic (match points, group standings, knockout) |
| `server/src/lib/scoringTrigger.ts` | Recalculates all member scores when a match result is saved |
| `server/src/lib/leaderboardEvents.ts` | SSE broadcaster for live leaderboard updates |

---

## Database schema

16 tables managed by Drizzle ORM:

- **users / sessions** — Lucia auth
- **tournaments / groups / teams / matches** — Tournament structure
- **competitions / competitionMembers** — Private prediction groups and per-member score breakdowns
- **predictions** — Per-match score predictions
- **bracketPredictions** — Full knockout bracket predictions (JSON)
- **bonusQuestions / bonusAnswers** — Flexible Q&A scoring
- **appConfig** — Single-row app-wide settings (maintenance mode)

---

## Scoring

Scoring is configurable per competition. Default point values:

| Event | Points |
|---|---|
| Exact score | 3 |
| Correct result (win/draw/loss) | 1 |
| Correct group position | 2 |
| Correct team progresses (knockout) | 2 |
| Correct team in knockout tiebreak | 1 |
| Correct team in final | 5 |
| Correct tournament winner | 10 |

Scores are recalculated automatically each time an admin marks a match as complete.

---

## Adding shadcn/ui components

```bash
cd client
npx shadcn-ui@latest add button
npx shadcn-ui@latest add input
# etc.
```
