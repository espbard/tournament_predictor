# Tournament Predictor

A web app for predicting sports tournament outcomes. Small private groups (up to ~20 people) compete to see who can best predict match results and earn leaderboard points.

## Tournament types

The app supports two independent kinds of tournament. They share only authentication, image
handling and generic UI plumbing — everything else (tables, routes, scoring, pages) is separate
by design.

| | **Manual** | **Live / API-linked** |
|---|---|---|
| Status | In production | Built, not yet run end to end in a browser. See [`docs/LIVE_TOURNAMENTS_PLAN.md`](docs/LIVE_TOURNAMENTS_PLAN.md) |
| Data | Admin enters teams, fixtures and results by hand | Pulled from an external football API |
| Deadline | One competition-wide deadline | Per fixture: kickoff − 60 minutes |
| Predicted matchups | Yes — full knockout bracket | No — only real fixtures with real teams |
| Scoring | 8 sources incl. group positions and bracket picks | Outcome +1, goal difference +1, exact score +2 |

The first live tournaments are the UEFA Champions League 2026/27 (from the league phase
onwards) and the Premier League 2026/27, both available as ready-made presets.

### Running a live tournament

1. Set `FOOTBALL_DATA_API_KEY` (free key from [football-data.org](https://www.football-data.org/client/register))
   and `LIVE_SYNC_ENABLED=true`.
2. As an admin, go to **/admin/live-tournaments**, pick a preset and create it. Teams, fixtures
   and the table are pulled in immediately.
3. Create a prediction league at **/admin/live-competitions** and share its invite code.

A background scheduler then keeps everything current on its own — polling roughly every minute
while a match is being played, every 15 minutes when one is due within a day, and every 6 hours
otherwise. Results are scored as fixtures finish, and connected clients are updated over SSE.

The free API tier allows **10 requests per minute, counted per account**, so a running dev server
shares that budget with anything else using the same key. `LIVE_SYNC_TICK_BUDGET` caps what a
single tick may spend.

> A tournament created before its draw is a supported, expected state. The provider does not
> publish a season until it exists — every request for it returns 404 — so the competition shows
> a "fixtures not published yet" panel and fills itself in automatically once the draw happens.

---

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
├── docs/                    # Design documents (see LIVE_TOURNAMENTS_PLAN.md)
├── client/                  # React + Vite frontend
│   └── src/
│       ├── pages/           # Route-level page components
│       ├── components/      # Shared UI components (Navbar, bracket, leaderboard, etc.)
│       ├── lib/             # api.ts fetch wrapper, tiebreaker logic, i18n
│       └── store/           # Zustand stores (auth, theme, language)
├── server/                  # Express backend
│   └── src/
│       ├── db/              # Drizzle schema, client, migration runner
│       ├── routes/          # Express routers (auth, tournaments, competitions, upload,
│       │                    # images, settings, feedback)
│       ├── middleware/      # requireAuth / requireAdmin guards (Lucia v3)
│       ├── lib/             # Scoring engine, scoring trigger, SSE leaderboard events, R2 helpers
│       └── scripts/         # One-off maintenance scripts, run by hand with tsx
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

Everything for the live tournament type lives under `server/src/live/` and `client/src/**/live/`:

| File | Purpose |
|---|---|
| `server/src/live/providers/` | football-data.org adapter behind a provider-neutral interface, plus the rate limiter |
| `server/src/live/sync.ts` | Pulls teams, fixtures and standings; maps stages, groups two-legged ties |
| `server/src/live/scheduler.ts` | Advisory-locked interval that decides what to poll and how often |
| `server/src/live/scoring.ts` | Pure per-fixture points, on the 90-minute score only |
| `server/src/live/scoringTrigger.ts` | Applies scoring, keeps denormalised member totals in step |
| `server/src/live/crests.ts` | Mirrors team crests into R2 so they serve through `/api/images/*` |
| `server/src/live/routes/` | `/api/live/*` — tournaments and prediction leagues |
| `client/src/lib/liveApi.ts` | Typed client wrappers and query keys |

---

## Database schema

15 tables managed by Drizzle ORM, defined in `server/src/db/schema.ts`:

- **users / sessions** — Lucia auth
- **tournaments / groups / teams / matches** — Tournament structure
- **competitions / competitionMembers** — Private prediction groups and per-member score breakdowns
- **predictions** — Per-match score predictions
- **bracketPredictions** — Full knockout bracket predictions (JSON)
- **bonusQuestions / bonusAnswers** — Flexible Q&A scoring
- **players** — Named players, used by `player`-type bonus answers
- **feedback** — In-app feedback inbox
- **appConfig** — Single-row app-wide settings (maintenance mode)

The live tournament type adds seven `live_*` tables in `server/src/db/liveSchema.ts` — see
[`docs/LIVE_TOURNAMENTS_PLAN.md`](docs/LIVE_TOURNAMENTS_PLAN.md).

> **Migrations caveat:** `server/drizzle/meta/_journal.json` is out of sync with the SQL files on
> disk and holds no snapshots past `0004`, so **`npm run db:generate` is unsafe here** — it would
> emit a migration recreating half the database. Every migration from `0005` on is hand-written.
> The server also runs idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`
> statements on every boot to compensate. Any new schema change needs **both** a hand-written
> migration (plus its `_journal.json` entry) and a defensive statement — in `server/src/index.ts`
> for manual tables, or `server/src/live/ensureSchema.ts` for live ones.

---

## Scoring

### Manual tournaments

Configurable per competition (`competitions.scoring_config`). Default point values:

| Event | Points |
|---|---|
| Exact score | 3 |
| Correct result (win/draw/loss) | 1 |
| Correct group position | 1 |
| Correct team progresses (knockout) | 2 |
| Correct team in knockout tie | 1 |
| Correct team in final | 5 |
| Correct tournament winner | 7 |

Scores are recalculated automatically each time an admin marks a match as complete. Bonus
question points are set per question.

### Live tournaments

Three stacking tiers per fixture, scored on the end-of-normal-time result (90 minutes plus
stoppage time; extra time and penalties are displayed but never score):

| Event | Points |
|---|---|
| Correct outcome (win/draw/loss) | 1 |
| Correct goal difference | 1 |
| Exact score | 2 |
| **Maximum per fixture** | **4** |

The tiers are nested, so they add: against an actual 2–1, predicting 2–1 scores 4, 3–2 scores 2,
3–1 scores 1, and 1–1 scores nothing.

Only the 90-minute score ever counts, in every stage. This matters more than it sounds: for a
penalty shootout the provider reports full time as regular time *plus* the shootout tally, so a
0–1 tie won 4–1 on penalties comes back as `1–5`. Scoring that would award points for a scoreline
that never happened, so a fixture whose 90-minute result cannot be determined is left unscored
and flagged in the admin UI rather than guessed at.

---

## Adding shadcn/ui components

```bash
cd client
npx shadcn-ui@latest add button
npx shadcn-ui@latest add input
# etc.
```
