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

## Tournament types

There are two kinds of tournament. **They share nothing but the `users` / `sessions` tables,
the auth middleware, image handling, and generic UI plumbing.** Treat them as two separate
products living in one repo, and do not refactor one into the other.

| | **Manual** (built, in production) | **Live / API-linked** (all 6 phases + table predictions built; not yet driven end to end in a browser) |
|---|---|---|
| Source of data | Admin types in teams, fixtures and every result | Pulled from an external football API |
| Prediction deadline | One competition-wide `prediction_deadline` | Per fixture: **kickoff − 60 minutes** |
| Predicted matchups | Yes — users predict the whole knockout bracket | **No** — users only predict real fixtures with real teams |
| Scoring | 8 sources (exact score, group position, bracket picks, bonus …) | Per fixture, 3 stacking tiers: outcome +1, goal difference +1, exact score +2. Plus a once-a-season league table prediction |
| Stages | Hardcoded `match_stage` enum | Data-driven format definitions per competition |
| Tables | `tournaments`, `teams`, `matches`, `competitions`, `predictions`, `bracket_predictions`, … | `live_tournaments`, `live_teams`, `live_fixtures`, `live_standings`, `live_competitions`, `live_predictions`, … |
| API base | `/api/tournaments`, `/api/competitions` | `/api/live/*` |
| Server code | `server/src/routes/`, `server/src/lib/` | `server/src/live/` |
| Client code | `client/src/pages/*.tsx` | `client/src/pages/live/`, `client/src/components/live/` |
| Shared code | `shared/src/types.ts`, `schemas.ts` | `shared/src/live/` |

**The full design and step-by-step build order for the live type lives in
[`docs/LIVE_TOURNAMENTS_PLAN.md`](docs/LIVE_TOURNAMENTS_PLAN.md).** Read it before touching
anything under a `live` prefix. A summary is in the "Live tournaments" section below.

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

```
.
├── CLAUDE_CONTEXT.md
├── README.md
├── package.json
├── package-lock.json
├── railway.toml
├── .env.example
├── .gitignore
├── docs
│   └── LIVE_TOURNAMENTS_PLAN.md    # design + build order for the live tournament type
├── client
│   ├── components.json, index.html, package.json, tailwind.config.js, vite.config.ts, …
│   ├── public/                     # favicons, flags, mascot images
│   └── src
│       ├── App.tsx                 # all React Router routes + PrivateRoute / AdminRoute guards
│       ├── main.tsx, index.css
│       ├── components/             # AppLayout, Navbar, KnockoutStageContent (2156 lines),
│       │                           # FinalResultsView, LeaderboardLineGraph, UserStatCard,
│       │                           # ImageUpload, UserAvatar, LoadingSpinner, FeedbackButton, …
│       │   └── live/               # LiveFixtureCard, LiveTieCard, LiveCountdown,
│       │                           # LiveStandingsTable, LiveLeaderboard,
│       │                           # LiveQualifiedTeamsPanel, LiveTablePrediction
│       ├── lib/                    # api.ts (fetch wrapper), translations.ts (no/en/de), useT.ts,
│       │                           # tiebreakers.ts, pointSources.ts, teamTranslations.ts, utils.ts
│       │   ├── liveApi.ts          # typed wrappers + query keys for /api/live/*
│       │   └── liveTableOrder.ts    # pure ordering helpers for the table prediction
│       ├── pages/                  # HomePage, AdminHomePage, Login/Register, CompetitionsPage,
│       │                           # CompetitionDetailPage (2990 lines), UserPredictionsPage,
│       │                           # TournamentsPage, TournamentDetailPage, TournamentKnockoutPage,
│       │                           # BonusQuestionsTab, TeamPage, Edit*Page, AdminFeedbackPage
│       │   └── live/               # LiveCompetitionDetailPage, AdminLiveTournamentsPage,
│       │                           # AdminLiveTournamentDetailPage, AdminLiveCompetitionsPage
│       └── store/                  # authStore, languageStore, themeStore (Zustand)
├── server
│   ├── drizzle.config.ts, package.json, tsconfig.json
│   ├── drizzle/                    # 0000 … 0022_*.sql  (see "Migrations" caveat below)
│   └── src
│       ├── index.ts                # Express entry: routers, boot migrations, defensive DDL, seeds
│       ├── db/
│       │   ├── client.ts           # merges schema + liveSchema; connects at module import
│       │   │                       # time — do not import in tests
│       │   ├── migrate.ts
│       │   ├── schema.ts           # manual-type tables
│       │   └── liveSchema.ts       # live-type tables (imports `users` from schema.ts)
│       ├── lib/                    # scoring.ts, scoringTrigger.ts, leaderboardEvents.ts (SSE),
│       │                           # bonusVisibility.ts, r2.ts, *.test.ts
│       ├── live/                   # the entire live tournament type
│       │   ├── ensureSchema.ts     # idempotent boot-time DDL for the live_* tables
│       │   ├── lock.test.ts        # covers shared/src/live/{lock,formats,presets}.ts
│       │   ├── providers/          # football-data adapter: types.ts, footballData.ts,
│       │   │                       # rateLimiter.ts, index.ts (getProvider registry),
│       │   │                       # __fixtures__/ real captured payloads + tests
│       │   ├── routes/             # tournaments.ts, competitions.ts
│       │   ├── sync.ts             # structure + live-window sync, provider-id upserts
│       │   ├── scheduler.ts        # advisory-locked tick, hot/warm/cold request budgeting
│       │   ├── scoring.ts          # pure calculateLivePoints — three stacking tiers
│       │   ├── tableScoring.ts      # league table prediction: exact positions + bands
│       │   ├── scoringTrigger.ts   # scoreFixtures, recalculate*, denormalised totals
│       │   ├── liveEvents.ts       # SSE registry, fixtures-updated / leaderboard-updated
│       │   ├── crests.ts           # mirrors team crests into R2
│       │   ├── sync.test.ts, scheduler.test.ts, scoring.test.ts,
│       │   │                       # tableScoring.test.ts, crests.test.ts
│       ├── middleware/auth.ts      # Lucia v3 — requireAuth / requireAdmin
│       ├── routes/                 # auth, tournaments (1812), competitions (5448), upload,
│       │                           # images, settings, feedback
│       └── scripts/                # one-off maintenance scripts, run by hand with tsx
└── shared
    ├── package.json
    └── src
        ├── index.ts                # re-exports everything, including ./live
        ├── types.ts, schemas.ts, bracketSlots.ts
        └── live/                   # types.ts, formats.ts (stages + table bands),
                                    # presets.ts, lock.ts, schemas.ts, index.ts
```

Tests live in the `server` workspace only (`npm run test -w server`) — that is where Vitest is
configured, so shared-package specs go under `server/src/` too. Existing examples:
`server/src/lib/bracketSlots.test.ts` and `server/src/live/lock.test.ts`.

---

## Database Schema

> **`server/src/db/schema.ts` is the single source of truth.** The summary below is a map, not a
> copy — read the file for exact column definitions.

### Manual tournament type (current, in production)

| Table | Purpose | Notes worth knowing |
|---|---|---|
| `users` | Registered players | Flags: `isAdmin`, `isTestAccount`, `isLeaderboardUser` (view-only), `isComparisonUser` (AI bot accounts), `isLateAddition`. Plus `imageUrl`, generated `iconColor` |
| `sessions` | Lucia v3 | |
| `app_config` | Single-row app settings | `maintenanceMode` |
| `tournaments` | e.g. "Fotball-VM 2026" | `status`, `imageUrl`, `knockoutConfig` JSON |
| `groups` | Named groups in a tournament | |
| `teams` | Participating teams | `groupId` FK, `imageUrl` |
| `matches` | Fixtures | `stage` enum, `scheduledAt`, `homeScore`/`awayScore`, `progressingTeamId`, `bracketIndex`, self-referencing `nextMatchId` |
| `competitions` | A private prediction league on one tournament | `inviteCode`, `scoringConfig` JSON, `predictionDeadline`, `allowLateAdditions` |
| `competition_members` | Membership **and** the per-user score aggregate | 8 denormalised `*_points` columns, `groupStageLocked`, tiebreak choice JSON, late-addition fields. **Has no primary key** |
| `predictions` | Per-match score predictions | **No unique constraint** on (competition, user, match) — enforced only in app code |
| `bracket_predictions` | Whole knockout bracket as one JSON blob | PK `(competitionId, userId)`; keys are `${stage}_${index}` |
| `bonus_questions` / `bonus_answers` | Custom Q&A scoring | Question is tournament-scoped, answer is competition-scoped |
| `players` | Named players, for `player`-type bonus answers | |
| `feedback` | In-app feedback inbox | |

Enums: `tournament_status`, `match_stage` (`group`, `round_of_32`, `round_of_16`,
`quarter_final`, `semi_final`, `bronze_final`, `final`), `match_status`, `bonus_answer_type`,
`feedback_type`, `feedback_status`.

Architectural facts that trip people up:
- Group-stage predictions live in `predictions` rows keyed by `matchId`; **knockout predictions
  do not** — they live entirely in the `bracket_predictions` JSON blob.
- The bracket key index is derived by sorting knockout matches by `bracketIndex` (nulls last)
  then `scheduledAt`. That sort is duplicated in `scoringTrigger.ts`, `competitions.ts` and
  `TournamentKnockoutPage.tsx` and **must stay in sync** or every bracket key shifts.
- Knockout scoring logic exists in three places that must agree: `lib/scoring.ts`, the
  `all-match-predictions` handler in `routes/competitions.ts`, and `KnockoutStageContent.tsx`.
  Several past bugfixes were divergence between them.
- `computeGroupStandings` / `sortGroupTeamsWithH2H` are duplicated verbatim between
  `lib/scoring.ts` and `routes/tournaments.ts`.

### Live tournament type (built in Phases 1–2)

`server/src/db/liveSchema.ts` — 8 tables, all with real primary keys and the unique constraints
the data requires, unlike their manual counterparts:

| Table | Notes |
|---|---|
| `live_tournaments` | Provider binding (`provider` + `provider_competition_id` + `season`, unique together), `format`, `start_stage_key`, sync state |
| `live_teams` | Unique on `(tournament, provider_team_id)`; `qualification_status` derived by the sync engine |
| `live_fixtures` | Unique on `(tournament, provider_fixture_id)`. Nullable team FKs — knockout fixtures exist before the draw. Scores split into `normal_time_*` (the only score that awards points), `half_time_*`, `extra_time_*`, `penalties_*`, `final_*` |
| `live_standings` | Stored verbatim from the provider, never recomputed. Unique on `(tournament, stage_key, team_id)` — `group_name` is excluded on purpose, being nullable |
| `live_competitions` | **No `prediction_deadline` column** — the live type locks per fixture only |
| `live_competition_members` | Membership + denormalised 3-source score aggregate |
| `live_predictions` | Unique on `(competition, user, fixture)` — the constraint the manual `predictions` table lacks |
| `live_table_predictions` | One row per user per table stage; the predicted order is a single `json` array of team ids, top first. No FK on those ids on purpose — a removed team degrades to a stale id that scores nothing rather than cascading the prediction away |

`liveSchema.ts` imports `users` from `schema.ts`, so `schema.ts` deliberately does **not**
re-export it. They are merged in `db/client.ts` and listed as an array in `drizzle.config.ts`.

Shared code in `shared/src/live/`: `types.ts`, `formats.ts` (stage definitions per competition
format + `resolveStageKey` / `isStageAtOrAfter` / `predictableStages`), `presets.ts` (the
ready-made connections dropdown), `lock.ts` (the kickoff − 60 min rule, used by both client and
server), `schemas.ts` (Zod).

`server/src/live/providers/` — the football-data.org v4 adapter behind a provider-neutral
interface, so nothing above it knows which API supplies the data. `getProvider(id)` is the only
entry point. Three things to know before touching it:

- **Only `score.regularTime` may be scored**, never `fullTime`. For a penalty shootout
  football-data reports `fullTime` as regular time *plus the shootout tally* — a 0-1 tie won 4-1
  on penalties comes back as `1-5`. `normalTimeFromScore` returns nulls rather than guessing when
  the normal-time score is unavailable, and the fixture goes unscored.
- **The free tier allows 10 requests/minute, per account.** Every call queues through
  `RateLimiter`, which serialises requests and backs the whole queue off on a `429`.
- **A 404 is often not an error.** A season the provider has not published yet (the Champions
  League 2026/27, until the draw) surfaces as `ProviderError.isSeasonUnavailable`.

Mapping is pinned by `footballData.test.ts` against real payloads committed under
`providers/__fixtures__/`; no test touches the network. To re-check the provider against live
data, run `npx tsx --env-file=../.env src/scripts/live-provider-smoke.ts` from `server/`.

### Migrations — read this before adding a column

`server/drizzle/meta/_journal.json` is **out of sync** with the SQL files on disk: several
migrations (`0011`, `0012`, `0015_maintenance_mode`, `0018`) exist but are not journaled, and
meta snapshots stop at `0004`.

**`npm run db:generate` is unsafe in this repo.** It would diff the current schema against the
`0004` snapshot and emit a migration recreating half the database. Every migration from `0005`
onward is hand-written, including `0023_live_tournaments.sql`.

**Convention: any new schema change needs both** a hand-written migration file (plus its
`_journal.json` entry) *and* an idempotent defensive statement that runs on boot — either in
`start()` in `server/src/index.ts`, or in `server/src/live/ensureSchema.ts` for live tables.

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

> This map is **partial**. `routes/competitions.ts` alone exposes ~40 endpoints (bracket
> predictions, leaderboard progression, user stats, tiebreak choices, bonus answers, an SSE
> stream at `GET /api/competitions/:id/leaderboard/events`, and a set of admin-only bracket
> repair endpoints), and `routes/tournaments.ts` adds a dozen knockout generation/simulation
> operations. Grep the route files rather than trusting this list.

### Live tournament endpoints

All under `/api/live` — see [`docs/LIVE_TOURNAMENTS_PLAN.md`](docs/LIVE_TOURNAMENTS_PLAN.md) §10
for the full table with guards and payloads. Reads require auth; everything that creates,
changes or triggers work is admin-only.

Built (`server/src/live/routes/tournaments.ts`, mounted in `index.ts`):

```
GET    /api/live/presets                          — the "ready-made connections" dropdown (admin)
GET    /api/live/formats                          — stage definitions per format
GET    /api/live/tournaments
POST   /api/live/tournaments                      — {presetKey}; syncs inline, returns populated
GET    /api/live/tournaments/:id                  — + sync state, unmapped stages, qualified count
PATCH  /api/live/tournaments/:id
DELETE /api/live/tournaments/:id
POST   /api/live/tournaments/:id/sync             — {full?} — window or full structure sync
GET    /api/live/tournaments/:id/teams
GET    /api/live/tournaments/:id/fixtures         — ?stageKey&matchday&from&to&status
GET    /api/live/tournaments/:id/standings        — ?stageKey
```

```
POST   /api/live/tournaments/:id/recalculate      — rebuild every competition's scores
```

Built (`server/src/live/routes/competitions.ts`):

```
GET    /api/live/competitions                     — the caller's leagues (all, for admins)
POST   /api/live/competitions                     — admin
POST   /api/live/competitions/join                — {inviteCode}
GET    /api/live/competitions/:id                 — + tournament, stages, tableScope
PATCH  /api/live/competitions/:id                 — admin; a scoringConfig change recalculates
DELETE /api/live/competitions/:id                 — admin
POST   /api/live/competitions/:id/recalculate     — admin
DELETE /api/live/competitions/:id/leave
GET    /api/live/competitions/:id/members
GET    /api/live/competitions/:id/leaderboard     — denormalised columns, ties share a rank
GET    /api/live/competitions/:id/events          — SSE: fixtures-updated, leaderboard-updated
GET    /api/live/competitions/:id/fixtures        — MAIN READ MODEL, see below
PUT    /api/live/competitions/:id/predictions     — upsert one; enforces kickoff − 60 min
GET    /api/live/competitions/:id/predictions/:userId  — locked fixtures only
GET    /api/live/competitions/:id/table-prediction     — teams, my order, deadline, result
PUT    /api/live/competitions/:id/table-prediction     — {stageKey, orderedTeamIds}
GET    /api/live/competitions/:id/table-prediction/:userId  — only after the deadline
```

`GET /competitions/:id/fixtures` is what the client should build the fixtures tab from: it
returns each fixture with its teams, the caller's own prediction, `lockedAt`, `isLocked`,
`isPredictable` and any points awarded, in one call. No client-side joining needed.

---

## Scoring System

### Manual tournaments

Points are awarded per competition based on a `scoring_config` JSON object stored with the
competition. The scoring engine lives in `server/src/lib/scoring.ts` as a pure function;
persistence and orchestration live in `server/src/lib/scoringTrigger.ts`.

```json
{
  "exact_score": 3,                    // After 90 minutes; extra time and penalties are not counted
  "correct_result": 1,                 // Correct on which team wins/draws
  "correct_group_position": 1,         // Exact end position of a team in their group
  "correct_team_progresses": 2,        // Correct team wins the tie (incl. via ET/pens)
  "correct_team_in_knockout_tie": 1,   // User's chain of predictions put the right team in this tie
  "correct_team_in_final": 5,          // Replaces correct_team_in_knockout_tie for the final
  "correct_winner": 7                  // Additive bonus for the correct tournament winner
}
```

Bonus question points are configured per question, not in this object. Points are recalculated
and written to `competition_members` when an admin marks a match completed — inline, inside the
`PATCH /api/matches/:id` request. There is **no API to edit `scoring_config`**; changes are made
by SQL migration plus a startup fixup in `index.ts`.

### Live tournaments

`server/src/live/scoring.ts` (pure) and `scoringTrigger.ts` (persistence). Three **stacking**
tiers per fixture, scored on the **end-of-normal-time** score (90 minutes plus stoppage time —
extra time and penalties never score, in any stage, though they are stored and displayed):

| Tier | Points |
|---|---|
| Correct outcome (home win / draw / away win) | +1 |
| Correct goal difference | +1 |
| Exact scoreline | +2 |
| **Maximum per fixture** | **4** |

Nested, so they add: actual 2–1 → predicted 2–1 scores 4, predicted 3–2 scores 2, predicted 3–1
scores 1, predicted 1–1 scores 0.

**League table prediction** (`server/src/live/tableScoring.ts`) — a fourth source, scored once
per season. Users order every team in the table stage; each team in exactly the right final
position scores `table_exact_position` (1), and in a format with **bands** each team in the right
band scores `table_correct_band` (1) on top. Champions League bands are 1–8 automatic, 9–24
play-off, 25+ eliminated; the Premier League defines none, so only exact positions score there.
Bands are format data on `LiveStageDef.bands` — adding them to another competition is a data
change, not a code one.

Three things to know:

- **Read a stored config through `withLiveScoringDefaults()`.** Competitions created before a
  tier existed lack the key, and arithmetic on `undefined` silently gives `NaN`.
- The table locks at the **first** fixture of the stage (kickoff − 60 min), not per fixture, and
  is scored only once every fixture in the stage is `finished` or `cancelled` — a *postponed*
  fixture keeps it open, since it could still move the table.
- Positions come from `live_standings` verbatim, never recomputed locally.

Scoring runs from the background sync tick when a fixture transitions to `finished`, not from a
request handler.

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
DATABASE_URL=
NODE_ENV=development
PORT=3000
CLIENT_URL=http://localhost:5173   # Only used in dev for CORS

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=tournament-predictor-assets

# Live tournaments
FOOTBALL_DATA_API_KEY=          # football-data.org key; free tier is 10 req/min per account
LIVE_SYNC_ENABLED=true          # defaults to OFF — a dev server would spend the shared budget
LIVE_SYNC_TICK_SECONDS=30       # scheduler interval
LIVE_SYNC_TICK_BUDGET=6         # provider requests one tick may spend (structure 3, window 1)
FOOTBALL_DATA_RATE_LIMIT=10     # requests per minute the limiter allows
```

Read with bare `process.env` — there is no config module or validation layer. Note
`SESSION_SECRET` appears in `.env.example` but is **never actually read** by any code.

---

## Deployment (Railway)

- Single Railway service (`railway.toml`), NIXPACKS builder
- Build command: `npm run build` (builds both client and server)
- Start command: `npm run start` (Express serves the built React app from `client/dist/`)
- Healthcheck: `GET /api/health`
- PostgreSQL is a separate Railway plugin (same project)
- All env vars set in Railway dashboard
- Migrations run automatically on boot, so a deploy applies pending schema changes

**Implication for background work:** there is no cron, no job queue, no worker process and no
`.github/workflows`. The only durable place to run periodic work is an in-process `setInterval`
started from `start()` in `server/src/index.ts`. The live-tournament sync
(`server/src/live/scheduler.ts`) does exactly that, guarded by a Postgres advisory lock so it
stays correct if the service is ever scaled past one replica.

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
- [x] Add full knockout predictions page
- [x] Improve tournament creation and qualification logic
- [x] Fully implement knockout results
- [x] Finalize prediction layout
- [x] Live score calculations


### In Progress
1. **Live (API-linked) tournament type** — see
   [`docs/LIVE_TOURNAMENTS_PLAN.md`](docs/LIVE_TOURNAMENTS_PLAN.md).
   Phase 0 (documentation) and Phase 1 (formats, presets, shared types, `live_*` schema) done.
   Phases 2–6 pending. Nothing is wired to a provider or exposed over HTTP yet, so the feature
   is invisible to users — the tables simply exist.
2. Add multiple language support
3. General improvements

### Known Issues / Tech Debt
- `server/drizzle/meta/_journal.json` is out of sync with the SQL files on disk; the boot-time
  defensive DDL in `index.ts` compensates. Any new column needs both a migration and a
  defensive statement.
- `competition_members` has no primary key; `predictions` has no unique constraint on
  (competition, user, match) — uniqueness is enforced only in app code.
- Knockout scoring logic is duplicated in three places (`lib/scoring.ts`, the
  `all-match-predictions` handler, `KnockoutStageContent.tsx`) and has diverged before.
- `computeGroupStandings` / `sortGroupTeamsWithH2H` duplicated between `lib/scoring.ts` and
  `routes/tournaments.ts`; `computeLuckyLoserLabels` exists in `shared/` and twice in the client.
- `routes/competitions.ts` is 5448 lines with no service layer.
- No integration tests — only pure-function Vitest specs. `db/client.ts` connects at module
  import time, so route files cannot be imported in tests.

---

## Image Upload Architecture

- **Storage:** Cloudflare R2 (S3-compatible), bucket `tournament-predictor-assets`
- **Upload flow:** client → `POST /api/upload` (multer + @aws-sdk/client-s3) → R2 → returns a
  `/api/images/...` URL → stored in DB
- **File limits:** 5 MB, image types only (jpeg/png/gif/webp)
- **Keys:** `{users|tournaments|teams|competitions|live-teams}/{uuid}{ext}` — the folder set is
  `VALID_FOLDERS` in `routes/images.ts` and the `R2Folder` union in `lib/r2.ts`; keep them in sync
- **Serving:** images are **proxied through `GET /api/images/:folder/:filename`**
  (`server/src/routes/images.ts`, optional `?w=` resize via `sharp`) rather than served from a
  public R2 URL — deliberately, to avoid corporate firewalls that block direct Cloudflare
  requests. `R2_PUBLIC_URL` is no longer used.
- **Reusable component:** `client/src/components/ImageUpload.tsx`
- **Edit pages:** `/settings` (user profile pic), `/admin/tournaments/:id/edit`,
  `/admin/teams/:teamId/edit`
- **Live team crests** (`server/src/live/crests.ts`) are downloaded from
  `crests.football-data.org` during a structure sync, stored in R2 under `live-teams/`, and the
  team row rewritten to the resulting `/api/images/` URL so they serve through the same proxy.
  Three things to know: it is **best-effort** and never fails a sync; the team upsert in `sync.ts`
  deliberately does **not** overwrite an already-mirrored URL, which is what stops every sync
  re-downloading all of them; and because a mirrored URL is indistinguishable from a current one,
  a crest the provider *changes* is never picked up — force it by clearing
  `live_teams.crest_url` and re-syncing. Without R2 configured, mirroring is skipped and crests
  load straight from the provider.

---

## TODO

### Next Session

**Read [`docs/LIVE_TOURNAMENTS_PLAN.md`](docs/LIVE_TOURNAMENTS_PLAN.md) §0 "Start here — handoff
state" first.** It records exactly where the work stands, which branch and commits hold it, the
environment gotchas (dependencies are not pre-installed; `npm run db:generate` is unsafe here;
two type errors in `routes/competitions.ts` are pre-existing), and a recipe for spinning up a
throwaway Postgres 16 to verify schema work for real.

The next task is **Phase 2** — the football-data provider adapter, and the go/no-go on the
provider choice. It is **blocked on two things from the user**:

1. `*.football-data.org` allowlisted in the cloud environment's network policy. The default
   **Trusted** policy rejects it (`403 Host not in allowlist: api.football-data.org`). Steps are
   in §0 and §6 of the plan, and in `.env.example`.
2. `FOOTBALL_DATA_API_KEY` set.

If either is missing, don't start the adapter — ask the user to run
`server/src/scripts/live-provider-smoke.ts` locally and paste the output. It answers all four
go/no-go questions without the key leaving their machine.

The answer that could change the design: **does `score.regularTime` exist on a finished
extra-time match?** The agreed rule scores on the end of normal time, so if the provider only
reports the after-extra-time score, the adapter should target API-Football instead.

### Backlog (in order)

1. Live tournaments Phases 2–6
2. Admin UI for editing scoring config (both tournament types)
3. Bonus questions for live tournaments (deliberately out of scope for v1)

---

## Key Decisions & Constraints

- **No security hardening needed** — small trusted group, dev speed is priority
- **No email/SMTP** — auth is username + password only, no verification
- **No external auth providers** — Lucia with local credentials only
- **Single Railway service** — Express serves React build as static files to minimize cost
- **Open source only** — no paid services beyond Railway (football-data.org's free tier is the
  first choice for live data for this reason; a paid provider is a deliberate decision, not a
  default)
- **No React Native / mobile app** — responsive web only
- **TypeScript everywhere** — client, server, and shared types
- **The two tournament types stay separate** — the live type does not reuse the manual type's
  tables, scoring, routes or pages, and vice versa. Shared surface is limited to
  `users`/`sessions`, the auth middleware, R2 image handling, the `api.ts` fetch wrapper and
  generic UI plumbing. Resist "unifying" them: the manual type's bracket/group-position model
  and the live type's per-fixture model have almost nothing in common, and a shared abstraction
  would have to carry both.

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

## Next Prompt (Run This Next)

The scaffold prompt that used to live here is long obsolete. The current next step is Phase 1 of
the live tournament plan:

> **Task:** Implement Phase 1 of `docs/LIVE_TOURNAMENTS_PLAN.md` — formats, presets, shared
> types and the `live_*` database schema. Read §4 and §5 of that document first; they contain the
> agreed table definitions and the `ucl_swiss` / `domestic_league` stage mappings.
>
> Files to create:
> - `shared/src/live/formats.ts`, `presets.ts`, `types.ts`, `schemas.ts`, `lock.ts`
> - `shared/src/live/lock.test.ts`
> - `server/src/db/liveSchema.ts`
>
> Files to modify:
> - `shared/src/index.ts` — re-export the new `live/` modules
> - `server/src/db/schema.ts` — `export * from './liveSchema'`
> - `server/src/index.ts` — defensive `CREATE TYPE` / `CREATE TABLE IF NOT EXISTS` in `start()`
> - `.env.example` — `FOOTBALL_DATA_API_KEY`, `LIVE_SYNC_ENABLED`, `LIVE_SYNC_TICK_SECONDS`
>
> Then run `npm run db:generate` and commit the resulting migration.
>
> Do not touch any existing table, route, or page. The two tournament types stay separate.