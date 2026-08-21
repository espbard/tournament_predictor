# Live (API-linked) tournaments — implementation plan

> **Status:** Phase 1 of 6 landed. Formats, presets, shared types and the `live_*` schema exist;
> nothing is wired to a provider or exposed over HTTP yet, so the feature is invisible to users.
> This document is the agreed design and the build order. Update the phase checkboxes in §13 as
> work lands, and record any deviation in §15.

---

## 0. Start here — handoff state

**Read this section first if you are picking the work up in a new session.** Everything below
it is design; this is where things actually stand.

### Where the code is

Branch **`claude/live-api-tournament-type-l8e6hy`**, pushed. Run `git log --oneline origin/main..HEAD`
for the current list; the substantive commits so far are:

| Commit | What |
|---|---|
| `7e33318` | This document, plus `CLAUDE_CONTEXT.md` / `README.md` refresh |
| `2229514` | Phase 1 — formats, presets, shared types, `live_*` schema, migration `0023` |
| `0435bbe` | `server/src/scripts/live-provider-smoke.ts`, the Phase 2 go/no-go check |

Later commits on the branch are documentation only unless a phase box in §13 says otherwise.

No pull request has been opened. The manual tournament type is untouched — the only edits to
existing files are additive (`shared/src/index.ts` re-export, `db/client.ts` schema merge,
`drizzle.config.ts` array, one `ensureLiveSchema()` call in `server/src/index.ts`).

### What Phase 1 delivered

- `shared/src/live/` — `types.ts`, `formats.ts`, `presets.ts`, `lock.ts`, `schemas.ts`, `index.ts`
- `server/src/db/liveSchema.ts` — the seven `live_*` tables
- `server/drizzle/0023_live_tournaments.sql` + its `_journal.json` entry
- `server/src/live/ensureSchema.ts` — idempotent boot-time DDL
- `server/src/live/lock.test.ts` — 39 passing specs
- `.env.example` — the three new keys

### Environment gotchas that cost time

1. **Dependencies are not pre-installed** in a fresh cloud session. Run `npm install` at the
   repo root before anything else, or every `tsc` run drowns in "Cannot find module".
2. **`npm run db:generate` is unsafe in this repo.** `server/drizzle/meta/` holds no snapshots
   past `0004` while `_journal.json` lists through `0023`, so drizzle-kit would diff against a
   five-year-old schema and emit a migration recreating half the database. Hand-write migrations,
   as every one since `0005` has been, and add the matching `_journal.json` entry.
3. **Two pre-existing type errors** in `server/src/routes/competitions.ts` (a `Date`/`string`
   mismatch around line 911 and a missing `isReplacement` around line 1285). They are on `main`
   and unrelated to this work. `npx tsc --noEmit` in `server/` should report exactly 2 errors —
   if you see more, you added them. The `client/` workspace should report 0.
4. **`api.football-data.org` is blocked** by the environment's network policy. See below.

### Verifying database work without a live database

There is no test DB and `server/src/db/client.ts` connects at module import time, so route files
cannot be imported in tests. Postgres 16 *is* installed in the cloud image, though, which is how
Phase 1's schema was actually exercised rather than merely typechecked:

```bash
PGBIN=/usr/lib/postgresql/16/bin
rm -rf /tmp/pgd /tmp/pgs && mkdir -p /tmp/pgd /tmp/pgs
chown postgres:postgres /tmp/pgd /tmp/pgs          # postgres refuses to run as root
su postgres -c "$PGBIN/initdb -D /tmp/pgd -U postgres --auth=trust"
su postgres -c "$PGBIN/pg_ctl -D /tmp/pgd -o '-k /tmp/pgs -p 5433 -h 127.0.0.1' -l /tmp/pgd/log start"
su postgres -c "$PGBIN/createdb -h 127.0.0.1 -p 5433 -U postgres tp"
# then: DATABASE_URL='postgresql://postgres@127.0.0.1:5433/tp' npx tsx <script>
```

Keep the socket directory short — a path under the session scratchpad exceeds Postgres's
107-byte socket limit. Apply `server/drizzle/*.sql` in filename order to reproduce a real
database. Remember to `pg_ctl stop` and delete any scratch scripts before committing.

### Blocked: Phase 2 needs two things from the user

Phase 2 (§13) is the go/no-go for the whole provider choice, and it cannot run in a cloud session until:

1. **`*.football-data.org` is allowlisted.** The Default environment ships with **Trusted**
   network access, which rejects the API host — the proxy returns
   `403 Host not in allowlist: api.football-data.org`. Fix: at claude.ai/code, click the cloud
   icon above the message box, hover the environment, open its settings, switch **Network
   access** to **Custom**, add `*.football-data.org` to **Allowed domains**, and — importantly —
   tick **"Also include default list of common package managers"**, or `npm install` breaks.
   Network policy is read once at session start, so a **new session** is required afterwards.
   The wildcard covers `api.` (the API), `crests.` (team badges, needed in Phase 6) and `docs.`
   (the API reference, which was unreachable when this plan was written — several field names in
   §6 are from memory and still need confirming).
2. **`FOOTBALL_DATA_API_KEY` is set**, either in the environment's variables box or in a local
   `.env`. Note the docs warn that environment variables are readable by anyone using the
   environment and are not a secrets store; for a personal environment and a free read-only key
   that is a reasonable trade, but it is the user's call.

**If either is missing, do not start writing the adapter.** Ask the user to run
`server/src/scripts/live-provider-smoke.ts` locally and paste the output — it answers all four
questions without the key ever leaving their machine, and captured payloads are enough to build
and unit-test the adapter.

### Next step

Phase 2, in §13. Run the smoke script, then write `server/src/live/providers/` against what it
actually returns. The single most important answer is whether `score.regularTime` exists on a
finished extra-time match: the agreed rule scores knockout fixtures on the end of normal time,
and if the provider only reports the after-extra-time score, that rule is not implementable on
football-data and the adapter should target API-Football instead.

---

## 1. Why

The app currently supports exactly one kind of tournament. An admin hand-creates it,
hand-adds groups, teams and fixtures, and hand-enters every result
(`PATCH /api/matches/:id`, `server/src/routes/tournaments.ts`). Predictions are gated by a
single competition-wide `competitions.prediction_deadline`, and a large part of the product
is *predicted matchups* — users predict who reaches each knockout tie, stored as a JSON blob
in `bracket_predictions` and resolved recursively by `getUserPredictedTeamForKnockoutSlot`
(`server/src/lib/scoring.ts`).

We are adding a second, fundamentally different kind of tournament:

- **Bound to a real competition via a data API.** Teams, fixtures, kickoff times, live scores
  and standings all arrive from the provider. No manual entry.
- **Per-fixture deadlines.** Users can create and change a prediction on any fixture right up
  until **kickoff minus 60 minutes**. No tournament-wide deadline ever locks them out.
- **No predicted matchups.** Users only ever predict the actual scheduled fixture with the
  actual teams. No bracket, no group-position points, no lucky-loser resolution.
- **Format-aware.** Different real competitions have different shapes (Swiss league phase,
  domestic round-robin, two-legged knockouts), so stages are data, not hardcoded.

Because the behaviour diverges this much, **the implementation is completely separate** — new
tables, new routes, new scoring, new pages. Existing manual-tournament code is not modified,
only additively mounted alongside. See §12 for the exact shared/not-shared split.

### First target: UEFA Champions League 2026/27, from the league phase onwards

Timing matters. As of 11 August 2026: 29 teams are automatic qualifiers, the play-off round is
played 18/19 and 25/26 August, and the **league phase draw is 27 August 2026**. The tournament
must therefore be creatable *now*, showing whatever is known, and fill itself in as the
provider publishes play-off results and then the drawn fixtures. That falls out of a
poll-and-upsert sync — no special-case code, as long as "zero fixtures" is treated as a valid
state rather than an error.

Second preset: **Premier League 2026/27** (round-robin, 380 fixtures, 38 matchdays).

---

## 2. Scoring rules

Three **stacking** tiers, evaluated per fixture:

| Tier | Points |
|---|---|
| Correct outcome (home win / draw / away win) | +1 |
| Correct goal difference | +1 |
| Exact scoreline | +2 |
| **Maximum per fixture** | **4** |

The tiers are nested — an exact scoreline necessarily also has the right goal difference and
outcome — so points simply add.

| Actual | Predicted | Outcome | GD | Exact | Total |
|---|---|---|---|---|---|
| 2–1 | 2–1 | ✓ | ✓ | ✓ | **4** |
| 2–1 | 3–2 | ✓ | ✓ | ✗ | **2** |
| 2–1 | 3–1 | ✓ | ✗ | ✗ | **1** |
| 2–1 | 1–1 | ✗ | ✗ | ✗ | **0** |
| 1–1 | 0–0 | ✓ | ✓ | ✗ | **2** |

**Which score counts:** the score at the end of **normal time** (90 minutes including stoppage
time). Extra time and penalties never affect points, in any stage. Extra-time and shootout
results are still stored and displayed so users can see how a tie actually ended — they just
do not score.

Config is a JSON column so values are tunable and more tiers can be added later without a
migration:

```ts
export interface LiveScoringConfig {
  correct_outcome: number;
  correct_goal_difference: number;
  exact_score: number;
}
export const DEFAULT_LIVE_SCORING_CONFIG: LiveScoringConfig = {
  correct_outcome: 1, correct_goal_difference: 1, exact_score: 2,
};
```

---

## 3. Naming convention

Everything new is prefixed `live`, making the boundary obvious in the schema, the URL space and
the file tree.

| Concept | Manual type | Live type |
|---|---|---|
| Tournament | `tournaments` | `live_tournaments` |
| Teams | `teams` | `live_teams` |
| Fixtures | `matches` | `live_fixtures` |
| Standings | derived in code | `live_standings` |
| Prediction league | `competitions` | `live_competitions` |
| Membership | `competition_members` | `live_competition_members` |
| Predictions | `predictions` + `bracket_predictions` | `live_predictions` |
| API base | `/api/tournaments`, `/api/competitions` | `/api/live/*` |
| Server code | `server/src/routes/`, `server/src/lib/` | `server/src/live/` |
| Client code | `client/src/pages/` | `client/src/pages/live/`, `client/src/components/live/` |
| Shared code | `shared/src/types.ts` | `shared/src/live/` |

The user-facing word for a prediction league stays **"competition"** in both types, so the UI
vocabulary does not change for players.

---

## 4. Formats, stages and presets

This is what makes the type reusable across competitions, so it is built first.

### `shared/src/live/formats.ts`

```ts
export type LiveStageKind = 'table' | 'knockout';

export interface LiveStageDef {
  key: string;                    // stable internal key, e.g. 'league_phase'
  labelKey: string;               // i18n key
  kind: LiveStageKind;
  legs: 1 | 2;                    // two-legged ties are grouped in the UI
  order: number;                  // chronological ordinal, used for startStage filtering
  // Raw provider stage strings that map here, keyed by provider — stage vocabularies are
  // provider-specific, so a second adapter adds a key rather than forking the format.
  providerStages: Partial<Record<LiveProviderId, string[]>>;
}

export interface LiveFormatDef {
  key: LiveFormatKey;
  tableScope: 'single' | 'per_group';
  stages: LiveStageDef[];
}
```

Helpers exported alongside: `getLiveFormat`, `getLiveStage`, `resolveStageKey`,
`isStageAtOrAfter`, `predictableStages`.

**`ucl_swiss`** — UEFA Champions League, current format (`tableScope: 'single'`, one 36-team table):

| key | kind | legs | order | football-data stage strings |
|---|---|---|---|---|
| `qualifying_round_1` | knockout | 2 | 1 | `1ST_QUALIFYING_ROUND` |
| `qualifying_round_2` | knockout | 2 | 2 | `2ND_QUALIFYING_ROUND` |
| `qualifying_round_3` | knockout | 2 | 3 | `3RD_QUALIFYING_ROUND` |
| `qualifying_playoff` | knockout | 2 | 4 | `PLAY_OFF_ROUND` |
| `league_phase` | table | 1 | 10 | `LEAGUE_STAGE` |
| `knockout_playoff` | knockout | 2 | 20 | `PLAYOFFS` |
| `round_of_16` | knockout | 2 | 30 | `LAST_16` |
| `quarter_final` | knockout | 2 | 40 | `QUARTER_FINALS` |
| `semi_final` | knockout | 2 | 50 | `SEMI_FINALS` |
| `final` | knockout | 1 | 60 | `FINAL` |

**`domestic_league`** — Premier League and any round-robin:

| key | kind | legs | order | football-data stage strings |
|---|---|---|---|---|
| `regular_season` | table | 1 | 10 | `REGULAR_SEASON` |

> The four summer qualifying rounds are mapped rather than left unknown, so their fixtures can
> be ingested and used to derive qualification status. They sit *below* the usual
> `startStageKey` of `league_phase` and so are never predictable.
>
> **Note the collision risk** between the August qualifier `PLAY_OFF_ROUND` (order 4) and the
> February knockout `PLAYOFFS` (order 20). They are deliberately separate stages — mapping both
> to one key would make summer qualifiers predictable. `server/src/live/lock.test.ts` asserts
> they stay apart, but the exact provider strings still need confirming against a live API call
> in Phase 2.

Any fixture whose provider stage matches no entry is still stored, with `stageKey = null` and
the raw string kept in `providerStage`. The admin detail page surfaces a warning listing
unmapped stages, so a provider rename is visible rather than silently dropping fixtures.

### `shared/src/live/presets.ts`

The "ready-made connections" dropdown. Adding a competition later is one array entry.

```ts
export interface LiveTournamentPreset {
  key: string;
  defaultName: string;
  labelKey: string;
  provider: LiveProviderId;
  providerCompetitionId: string;
  season: string;                 // football-data uses the starting year
  format: LiveFormatKey;
  startStageKey: string;          // ignore everything before this stage
  expectedTeamCount: number | null;
  defaultImageUrl?: string | null;
}

export const LIVE_TOURNAMENT_PRESETS: LiveTournamentPreset[] = [
  {
    key: 'ucl_2026_27',
    defaultName: 'UEFA Champions League 2026/27',
    labelKey: 'live.presets.ucl_2026_27',
    provider: 'football_data',
    providerCompetitionId: 'CL',
    season: '2026',
    format: 'ucl_swiss',
    startStageKey: 'league_phase',
    expectedTeamCount: 36,
  },
  {
    key: 'pl_2026_27',
    defaultName: 'Premier League 2026/27',
    labelKey: 'live.presets.pl_2026_27',
    provider: 'football_data',
    providerCompetitionId: 'PL',
    season: '2026',
    format: 'domestic_league',
    startStageKey: 'regular_season',
    expectedTeamCount: 20,
  },
];
```

Served by `GET /api/live/presets` (admin). Creating a live tournament is: pick a preset from the
dropdown → optionally override name/image → submit. No free-text provider ids in the UI; the
escape hatch for an unlisted competition stays a code change, which is the right trade for a
~20-person private app.

---

## 5. Database schema

New file **`server/src/db/liveSchema.ts`**.

It imports `users` from `./schema`, so `schema.ts` deliberately does **not** re-export it — that
would be a circular import. The two are joined where they are consumed instead, keeping the
dependency one-directional:

```ts
// server/src/db/client.ts
import * as schema from './schema';
import * as liveSchema from './liveSchema';
export const db = drizzle(client, { schema: { ...schema, ...liveSchema } });

// server/drizzle.config.ts
schema: ['./src/db/schema.ts', './src/db/liveSchema.ts'],
```

```ts
export const liveProviderEnum = pgEnum('live_provider', ['football_data']);
export const liveFixtureStatusEnum = pgEnum('live_fixture_status', [
  'scheduled', 'in_play', 'paused', 'finished', 'postponed', 'suspended', 'cancelled',
]);
export const liveTournamentStatusEnum = pgEnum('live_tournament_status', [
  'upcoming', 'active', 'completed',
]);
export const liveQualificationEnum = pgEnum('live_qualification_status', [
  'qualified', 'pending', 'eliminated',
]);
```

### `live_tournaments`
`id` pk · `name` · `imageUrl` · `presetKey` · `provider` · `providerCompetitionId` · `season` ·
`format` text · `startStageKey` text · `status` · `syncEnabled` bool default true ·
`lastStructureSyncAt` · `lastFixtureSyncAt` · `lastSyncError` text · `createdAt`.
**Unique** `(provider, provider_competition_id, season)`.

### `live_teams`
`id` pk · `liveTournamentId` → cascade · `providerTeamId` · `name` · `shortName` · `tla` ·
`crestUrl` · `groupName` nullable · `qualificationStatus` (enum, default `pending`).
**Unique** `(live_tournament_id, provider_team_id)`.

### `live_fixtures`
`id` pk · `liveTournamentId` → cascade · `providerFixtureId` · `homeTeamId` / `awayTeamId` →
`live_teams` nullable (knockout fixtures exist before teams are known) · `kickoffAt` nullable ·
`kickoffConfirmed` bool · `status` enum · `stageKey` text nullable · `providerStage` text ·
`groupName` · `matchday` int · `tieKey` text nullable · `legNumber` int nullable ·

**Scores:** `normalTimeHome` / `normalTimeAway` (← the values that score) · `halfTimeHome` /
`halfTimeAway` · `extraTimeHome` / `extraTimeAway` · `penaltiesHome` / `penaltiesAway` ·
`finalHome` / `finalAway` (provider full-time, display only) · `winner` text · `minute` int ·
`providerScoreRaw` json (the provider's score object verbatim — small, and makes any mapping
bug diagnosable after the fact) · `providerLastUpdated` · `updatedAt`.

**Unique** `(live_tournament_id, provider_fixture_id)`.
**Index** `(live_tournament_id, kickoff_at)`, `(live_tournament_id, stage_key)`, `(status)`.

### `live_standings`
`id` pk · `liveTournamentId` → cascade · `stageKey` · `groupName` nullable · `teamId` →
`live_teams` · `position` · `played` · `won` · `drawn` · `lost` · `goalsFor` · `goalsAgainst` ·
`goalDifference` · `points` · `form` · `updatedAt`.
**Unique** `(live_tournament_id, stage_key, team_id)` — `group_name` is deliberately *not* part
of the key. It is nullable, and Postgres treats NULLs as distinct, so including it would let
duplicate rows through for single-table formats. A team appears once per stage regardless.

Standings are stored **verbatim from the provider and never recomputed locally**. That
deliberately avoids the tiebreaker duplication that bit the manual type (`computeGroupStandings`
exists twice, in `server/src/lib/scoring.ts` and `server/src/routes/tournaments.ts`), which
matters doubly here because the UCL league phase has its own tiebreak rules.

### `live_competitions`
`id` pk · `liveTournamentId` → cascade · `name` · `imageUrl` · `inviteCode` unique ·
`scoringConfig` json `$type<LiveScoringConfig>` · `createdAt`.

### `live_competition_members`
`id` pk (a real one this time) · `liveCompetitionId` → cascade · `userId` → cascade · `joinedAt` ·
`correctOutcomePoints` · `correctGoalDifferencePoints` · `exactScorePoints` · `totalPoints`
(all `integer notNull default 0`).
**Unique** `(live_competition_id, user_id)`.

### `live_predictions`
`id` pk · `liveCompetitionId` → cascade · `userId` → cascade · `liveFixtureId` → cascade ·
`homeScore` int notNull · `awayScore` int notNull · `points` int nullable ·
`correctOutcomePoints` / `correctGoalDifferencePoints` / `exactScorePoints` int default 0 ·
`createdAt` · `updatedAt`.
**Unique** `(live_competition_id, user_id, live_fixture_id)` — the constraint the manual
`predictions` table omits, which is why uniqueness there is enforced only in app code.

### Migration mechanics

This repo's migration state is messy — `server/drizzle/meta/_journal.json` lists entries through
`0022` but `meta/` holds no snapshots past `0004`. **`npm run db:generate` is therefore unsafe
here:** it would diff the current schema against a five-year-old snapshot and emit a migration
that recreates half the database. Migrations `0005`–`0022` were all hand-written for this reason.

Phase 1 followed the same convention:

- `server/drizzle/0023_live_tournaments.sql` — hand-written, plus a matching `_journal.json`
  entry so `migrate()` applies it.
- `server/src/live/ensureSchema.ts` — the same statements with `IF NOT EXISTS` / `EXCEPTION WHEN
  duplicate_object`, exported as `ensureLiveSchema()` and called from `start()` in
  `server/src/index.ts`. Kept in its own file rather than inlined so the already-long defensive
  block in `index.ts` does not keep growing.

The two must stay in sync when columns are added.

---

## 6. Provider abstraction

**`server/src/live/providers/types.ts`** — provider-neutral DTOs and the interface every adapter
satisfies.

```ts
export interface ProviderTeam {
  providerTeamId: string; name: string; shortName?: string | null;
  tla?: string | null; crestUrl?: string | null; groupName?: string | null;
}

export interface ProviderFixture {
  providerFixtureId: string;
  homeProviderTeamId: string | null; awayProviderTeamId: string | null;
  kickoffAt: string | null; kickoffConfirmed: boolean;
  status: LiveFixtureStatus;              // already normalised
  providerStage: string | null; groupName: string | null; matchday: number | null;
  score: {
    normalTime: { home: number | null; away: number | null };   // ← what scores
    halfTime:   { home: number | null; away: number | null };
    extraTime:  { home: number | null; away: number | null };
    penalties:  { home: number | null; away: number | null };
    final:      { home: number | null; away: number | null };
    winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    raw: unknown;
  };
  minute: number | null;
  providerLastUpdated: string | null;
}

export interface LiveProvider {
  readonly id: LiveProviderId;
  listCompetitions(): Promise<ProviderCompetitionSummary[]>;
  fetchTeams(competitionId: string, season: string): Promise<ProviderTeam[]>;
  fetchFixtures(competitionId: string, season: string,
                opts?: { dateFrom?: string; dateTo?: string }): Promise<ProviderFixture[]>;
  fetchStandings(competitionId: string, season: string): Promise<ProviderStandingRow[]>;
}
```

**`server/src/live/providers/footballData.ts`** — base `https://api.football-data.org/v4`, auth
header `X-Auth-Token: process.env.FOOTBALL_DATA_API_KEY`. Endpoints: `GET /competitions`,
`/competitions/{id}/teams?season=`, `/competitions/{id}/matches?season=[&dateFrom&dateTo]`,
`/competitions/{id}/standings?season=`. Both `CL` and `PL` are in the free tier
(10 requests/minute).

Status normalisation: `SCHEDULED|TIMED → scheduled` (`kickoffConfirmed = status === 'TIMED'`),
`IN_PLAY → in_play`, `PAUSED → paused`, `FINISHED|AWARDED → finished`,
`POSTPONED → postponed`, `SUSPENDED → suspended`, `CANCELLED → cancelled`.

**Normal-time extraction** — the single most important mapping, since it drives every point
awarded:

```
if score.duration === 'REGULAR'        → normalTime = score.fullTime
else if score.regularTime is present   → normalTime = score.regularTime
else                                   → normalTime = null, flag the fixture, do not score it
```

Never silently fall back to `fullTime` for an extra-time match — that would hand out points on a
scoreline the rules exclude. A fixture with `normalTime = null` and status `finished` is
surfaced in the admin UI as needing attention, and `providerScoreRaw` retains everything needed
to fix it.

**`server/src/live/providers/rateLimiter.ts`** — a serialising token bucket (10 req/60 s by
default, from `FOOTBALL_DATA_RATE_LIMIT`). All adapter calls queue through it; `429` backs off on
`Retry-After`; other non-2xx become a typed `ProviderError` recorded in
`live_tournaments.lastSyncError` rather than crashing the tick.

**`server/src/live/providers/index.ts`** — `getProvider(id)`. A second provider is one file plus
one registry entry.

### New environment variables

```env
FOOTBALL_DATA_API_KEY=
LIVE_SYNC_ENABLED=true
LIVE_SYNC_TICK_SECONDS=30
```

Already in `.env.example`. Also needs setting in the Railway dashboard before deploy.

### Network egress — required for every phase from 2 onward

Outbound access from a Claude Code cloud session is governed by the environment's network
policy, and the **Trusted** default does not include the provider. Any request fails with:

```
403 Host not in allowlist: api.football-data.org
```

To fix it, at [claude.ai/code](https://claude.ai/code) click the cloud icon in the row above the
message box, hover the environment, open its settings, set **Network access** to **Custom**, and
add to **Allowed domains**:

```
*.football-data.org
```

Then tick **"Also include default list of common package managers"** — Custom *replaces* the
Trusted list rather than extending it, so leaving it unchecked breaks `npm install` and the
build. Network policy is read once when a session's VM boots, so an existing session keeps the
policy it started with: **start a new session** after saving.

The wildcard covers the three hosts this feature needs — `api.` for the API, `crests.` for team
badges mirrored into R2 in Phase 6, and `docs.` for the API reference. Configuration reference:
[cloud environments](https://code.claude.com/docs/en/cloud-environments#allow-specific-domains).

None of this applies to Railway, which has no such restriction. It is purely about being able to
develop and verify the feature from a cloud session.

---

## 7. Sync engine

**`server/src/live/sync.ts`**

- `syncTournamentStructure(id)` — teams + full fixture list + standings, ~3 provider requests.
  Upserts by provider id, so re-running is harmless and partial data is normal.
- `syncLiveWindow(id)` — fixtures only, `dateFrom = today-1`, `dateTo = today+1`. One request.
  This is what carries live scores.
- **Stage mapping** on ingest: `providerStage` → `stageKey` via the format's `providerStages`.
  Fixtures whose stage `order` is below the tournament's `startStageKey` are stored but marked
  non-predictable (they are the summer qualifiers), so they can inform qualification status
  without ever appearing as something to predict.
- **Tie grouping** for two-legged stages: the provider gives no tie id, so derive
  `tieKey = ${stageKey}:${[homeTeamId, awayTeamId].sort().join('-')}` and set `legNumber` by
  kickoff order within that key. Recomputed on every sync.
- **Qualification status**: a team is `eliminated` if it lost a decided tie in a stage below
  `startStageKey`; `qualified` if it appears in `live_standings` or in any fixture at or above
  `startStageKey`; `pending` otherwise. Recomputed after each structure sync. Before the
  27 August draw this shows the play-off round resolving; after it, all 36 flip to qualified.
- **Scoring hand-off**: fixtures transitioning *into* `finished` are collected and passed to
  `scoreFixtures(ids)`, then SSE fires. Score changes on an `in_play` fixture also fire SSE so
  watchers see live scores without polling.

**`server/src/live/scheduler.ts`** — there is no cron, queue or worker in this project and it
deploys as a single Railway service (`railway.toml`, `startCommand = "npm run start"`), so an
in-process interval started from `start()` in `server/src/index.ts` is the right fit.

`tick()`:

1. Bail if a previous tick is still running (module-level flag) or `LIVE_SYNC_ENABLED !== 'true'`.
2. Take `pg_try_advisory_lock(<constant>)`, release in `finally` — cheap insurance if the service
   is ever scaled past one replica.
3. Per enabled, non-completed tournament:
   - **Hot** — a fixture kicks off within `now − 3h … now + 15min`, or any fixture is
     `in_play`/`paused` → `syncLiveWindow` if `lastFixtureSyncAt` is older than 60 s.
   - **Warm** — a fixture kicks off in the next 24 h → `syncLiveWindow` every 15 min.
   - **Cold** → `syncTournamentStructure` every 6 h.
4. Budget-aware: with 10 req/min, at most one hot tournament is polled per minute. Candidates are
   sorted by staleness and the tick stops when the minute's budget is spent.

`POST /api/live/tournaments/:id/sync` triggers either sync on demand.

**Scale-out caveat:** the advisory lock protects the sync, but `server/src/live/liveEvents.ts`
(like the existing `leaderboardEvents.ts`) holds SSE connections in process memory, so a second
replica would only reach its own clients.

---

## 8. Deadline / lock logic

One shared pure function, so client and server cannot drift.

**`shared/src/live/lock.ts`**

```ts
export const LIVE_LOCK_MINUTES = 60;

export function fixtureLockAt(kickoffAt: string | null): Date | null {
  return kickoffAt ? new Date(new Date(kickoffAt).getTime() - LIVE_LOCK_MINUTES * 60_000) : null;
}

export function isFixtureLocked(
  f: { kickoffAt: string | null; status: LiveFixtureStatus },
  now: Date = new Date(),
): boolean {
  if (f.status !== 'scheduled' && f.status !== 'postponed') return true;   // in play / finished / cancelled
  const lockAt = fixtureLockAt(f.kickoffAt);
  if (!lockAt) return false;                                               // TBD kickoff → stays open
  return now >= lockAt;
}
```

- **Server**: enforced in `PUT /api/live/competitions/:id/predictions`. Nothing else can lock a
  user out — there is deliberately **no league-wide deadline column** on `live_competitions`.
- **Client**: `LiveFixtureCard` calls the same helper to disable inputs and render a countdown.
- **Postponed** fixtures reopen with the new kickoff; existing predictions survive.
  **Cancelled** fixtures award nobody anything.
- **TBD kickoff** stays open — relevant right now, since UCL league-phase fixtures have no dates
  until the draw.
- Fixtures below `startStageKey` are never predictable regardless of lock state.
- `isLeaderboardUser` still cannot predict (403). `isComparisonUser` bot accounts get **no**
  bypass here — the per-fixture lock is the whole point of this type.

---

## 9. Scoring implementation

**`server/src/live/scoring.ts`** — pure, no DB, mirroring the shape of `calculateMatchPoints`
(`server/src/lib/scoring.ts`) but with no stage or progressing-team dimension:

```ts
export function calculateLivePoints(
  prediction: { homeScore: number; awayScore: number },
  fixture: { normalTimeHome: number | null; normalTimeAway: number | null; status: LiveFixtureStatus },
  config: LiveScoringConfig,
): {
  points: number;
  correctOutcomePoints: number;
  correctGoalDifferencePoints: number;
  exactScorePoints: number;
}
```

Returns all zeros unless `status === 'finished'` and both normal-time scores are non-null.
Otherwise: outcome via `Math.sign` comparison, goal difference via `(h - a) === (ph - pa)`, exact
via both equal — each awarding its configured value, summed.

**`server/src/live/scoringTrigger.ts`**

- `scoreFixtures(fixtureIds)` — for each `live_competitions` row on that tournament, score every
  member's prediction for those fixtures, write `live_predictions.points` plus the three
  breakdown columns, then recompute `live_competition_members` totals in one
  `UPDATE … FROM (SELECT … SUM …)`.
- `recalculateLiveCompetition(id)` / `recalculateLiveTournament(id)` — full rebuild, exposed as
  an admin endpoint (needed whenever `scoringConfig` changes).
- Called from the sync tick, not from a request handler — unlike the manual type, which runs
  scoring inline inside `PATCH /api/matches/:id`.

**Leaderboard** is a straight read of the denormalised columns on `live_competition_members`,
sorted by `totalPoints` desc — three point sources instead of the manual type's nine.

---

## 10. API surface

Mounted as `app.use('/api/live', liveRouter)` in `server/src/index.ts`.

### `server/src/live/routes/tournaments.ts`

| Method | Path | Guard | Notes |
|---|---|---|---|
| GET | `/presets` | admin | the dropdown source |
| GET | `/formats` | auth | stage definitions, for client rendering |
| GET | `/tournaments` | auth | |
| POST | `/tournaments` | admin | `{presetKey, name?, imageUrl?}`; runs a structure sync inline and returns the populated tournament |
| GET | `/tournaments/:id` | auth | includes sync state, unmapped-stage warnings, `qualifiedCount / expectedTeamCount` |
| PATCH | `/tournaments/:id` | admin | `{name?, imageUrl?, status?, syncEnabled?}` |
| DELETE | `/tournaments/:id` | admin | |
| POST | `/tournaments/:id/sync` | admin | `{full?: boolean}` |
| POST | `/tournaments/:id/recalculate` | admin | |
| GET | `/tournaments/:id/teams` | auth | with `qualificationStatus` |
| GET | `/tournaments/:id/fixtures` | auth | `?stageKey&matchday&from&to&status` |
| GET | `/tournaments/:id/standings` | auth | `?stageKey` |

### `server/src/live/routes/competitions.ts`

| Method | Path | Guard |
|---|---|---|
| GET | `/competitions` | auth — the caller's leagues |
| POST | `/competitions` | admin |
| GET / PATCH / DELETE | `/competitions/:id` | auth (member/admin) / admin / admin |
| POST | `/competitions/join` | auth — `{inviteCode}` |
| DELETE | `/competitions/:id/leave` | auth |
| GET | `/competitions/:id/members` | auth |
| GET | `/competitions/:id/leaderboard` | auth |
| GET | `/competitions/:id/events` | auth — SSE: `fixtures-updated`, `leaderboard-updated` |
| GET | `/competitions/:id/fixtures` | auth — **main read model**: fixtures for a stage/matchday + caller's prediction + `lockedAt` + `isLocked` + awarded points, in one call |
| PUT | `/competitions/:id/predictions` | auth — upsert one `{fixtureId, homeScore, awayScore}` |
| GET | `/competitions/:id/predictions/:userId` | auth — another member's, **only for already-locked fixtures** |

Zod schemas live in **`shared/src/live/schemas.ts`**, following the style of
`shared/src/schemas.ts`.

**`server/src/live/liveEvents.ts`** — a parallel copy of the subscribe/notify pattern in
`server/src/lib/leaderboardEvents.ts`, keyed by live competition id. Deliberately separate so the
namespaces evolve independently.

---

## 11. Client

New routes in `client/src/App.tsx`:

| Path | Component | Guard |
|---|---|---|
| `/live/competitions/:id` | `pages/live/LiveCompetitionDetailPage.tsx` | Private |
| `/admin/live-tournaments` | `pages/live/AdminLiveTournamentsPage.tsx` | Admin |
| `/admin/live-tournaments/:id` | `pages/live/AdminLiveTournamentDetailPage.tsx` | Admin |
| `/admin/live-competitions` | `pages/live/AdminLiveCompetitionsPage.tsx` | Admin |

Components under `client/src/components/live/`:

- `LiveFixtureCard.tsx` — crests, names, kickoff, live minute/score, score inputs or locked
  read-only state, awarded points once finished, and an "AET / pens" annotation showing how the
  tie ended alongside the normal-time score that actually scored.
- `LiveTieCard.tsx` — wraps the two legs of a two-legged tie with the running aggregate
  (informational only; each leg is predicted and scored separately).
- `LiveCountdown.tsx` — ticking "locks in 2h 14m", flips to "Locked" at kickoff − 60 min.
- `LiveStandingsTable.tsx` — read-only provider standings; single table or per-group depending on
  `format.tableScope`.
- `LiveLeaderboard.tsx`, `LiveQualifiedTeamsPanel.tsx`.
- `client/src/lib/liveApi.ts` — typed thin wrappers over the existing `client/src/lib/api.ts`.
  Note `api` currently has no `put` — add one.

`LiveCompetitionDetailPage` uses the tab pattern of `CompetitionDetailPage` but with three tabs:
**Fixtures** · **Standings** · **Leaderboard**. No knockout tab, no bracket, no group-position
tab.

The Fixtures tab is driven by the format, not hardcoded:

- A stage selector built from `format.stages`, defaulting to the stage containing the next
  unplayed fixture.
- `table` stages list fixtures grouped by matchday, defaulting to the current one — essential for
  the Premier League's 380 fixtures.
- `knockout` stages list `LiveTieCard`s.
- Before the UCL draw, the tab shows `LiveQualifiedTeamsPanel` ("29 of 36 teams confirmed —
  fixtures available after the draw on 27 August") instead of an empty list.

Data strategy:

- Query keys `['live','competitions']`, `['live','competition',id]`,
  `['live','fixtures',compId,stageKey,matchday]`, `['live','leaderboard',compId]`,
  `['live','standings',tournamentId,stageKey]`.
- One `EventSource('/api/live/competitions/:id/events')` per detail page (same pattern as
  `CompetitionDetailPage.tsx`), invalidating fixtures + leaderboard on push.
- Fallback `refetchInterval: 30_000` on the fixtures query, enabled only while a fixture is
  `in_play`.

Navigation:

- `client/src/pages/HomePage.tsx` — a "Live competitions" section fed by
  `GET /api/live/competitions`, plus a join-by-invite-code form pointed at the live endpoint.
- `client/src/pages/AdminHomePage.tsx` — two new cards linking to `/admin/live-tournaments` and
  `/admin/live-competitions`.
- `client/src/components/Navbar.tsx` — its tab bar is hard-wired to `/competitions/:id` and the
  manual eight-tab set. Add a sibling branch matching `/live/competitions/:id` with the three
  live tabs. Do not extend the existing dropdowns.

i18n: a `live: { … }` block under all three languages (`no`, `en`, `de`) in
`client/src/lib/translations.ts`, via the existing `useT()`.

**Team crests:** football-data serves crests from `crests.football-data.org`, but this app's
image proxy reads **only from R2** (`server/src/routes/images.ts`) — a deliberate choice to dodge
corporate firewalls. So mirror each crest into R2 via `uploadToR2` (`server/src/lib/r2.ts`)
during structure sync and store the resulting `/api/images/...` URL in `live_teams.crestUrl`.
Two small edits: add `'live-teams'` to `VALID_FOLDERS` in `images.ts` and to the `type` union in
`uploadFile` in `client/src/lib/api.ts`. Some crests are SVG — `sharp` handles SVG input, but
store the content type correctly.

---

## 12. What is and is not shared

**Reused as-is**

- `users` / `sessions` tables and `server/src/middleware/auth.ts` (`requireAuth`, `requireAdmin`,
  `res.locals.user`)
- `server/src/db/client.ts`
- `server/src/lib/r2.ts` + `routes/upload.ts` + `routes/images.ts`
- `client/src/lib/api.ts` (plus a new `put`), `AppLayout`, `Navbar`, `LoadingSpinner`,
  theme/language stores, `translations.ts` + `useT`
- Tailwind / shadcn conventions

**Not shared — deliberately separate**

- `tournaments` / `groups` / `teams` / `matches` / `competitions` / `competition_members` /
  `predictions` / `bracket_predictions` tables
- `server/src/lib/scoring.ts`, `scoringTrigger.ts`, `bracketSlots.ts`, `bonusVisibility.ts`
- `server/src/routes/tournaments.ts`, `server/src/routes/competitions.ts`
- `CompetitionDetailPage.tsx`, `KnockoutStageContent.tsx`, `TournamentDetailPage.tsx`,
  `TournamentKnockoutPage.tsx`, `UserPredictionsPage.tsx`
- `leaderboardEvents.ts` (mirrored as `live/liveEvents.ts`)
- Bonus questions, players, late-additions, comparison-user bypass, group-stage self-lock,
  tiebreak choices — none carry over to v1

---

## 13. Build order

Nothing in the existing code path changes except additive touches (`server/src/index.ts` router
mount + scheduler start, `client/src/App.tsx` routes, `Navbar`/`HomePage`/`AdminHomePage` entry
points). The manual "Fotball-VM 2026" competition is unaffected at every phase.

- [x] **Phase 0 — Documentation.** This file, plus `CLAUDE_CONTEXT.md` and `README.md` updates.

- [x] **Phase 1 — Formats, presets, schema, shared types.** *(done)*
  `shared/src/live/{types,formats,presets,lock,schemas,index}.ts`, re-exported from
  `shared/src/index.ts`; `server/src/db/liveSchema.ts`; `server/src/live/ensureSchema.ts`;
  `server/drizzle/0023_live_tournaments.sql` + journal entry; `.env.example` keys;
  `db/client.ts` and `drizzle.config.ts` wiring.
  *Verified:* all 24 migrations applied in order to a fresh Postgres 16, `0023` last, no errors.
  `\d live_fixtures` shows the expected columns, 4 indexes and 3 FKs. `ensureLiveSchema()` built
  all 7 tables and 18 indexes from nothing on a database that skipped `0023`, and was a no-op on
  the 2nd and 3rd run. Every unique constraint rejects duplicates; the same provider fixture id
  is accepted under a different tournament; deleting a tournament cascades to its fixtures,
  competitions and predictions. Full insert/select round-trip through the Drizzle table objects
  and the relational query API, confirming column names match the SQL. Both workspaces
  typecheck with no new errors (2 pre-existing ones in `routes/competitions.ts` remain), and
  `npm run build` succeeds.
  *Tests:* `server/src/live/lock.test.ts` — 39 specs. Note the location: Vitest is configured in
  the `server` workspace only, so shared-package tests live there, exactly as
  `server/src/lib/bracketSlots.test.ts` already tests `shared/src/bracketSlots.ts`.

- [ ] **Phase 2 — Provider adapter, no DB writes. The go/no-go phase. ← next**

  **Prerequisites, both from the user** (see §0 and §6): `*.football-data.org` allowlisted in the
  environment's network policy, and `FOOTBALL_DATA_API_KEY` available. Without them, ask the user
  to run the smoke script locally and paste the output rather than guessing at payload shapes.

  The check script already exists: **`server/src/scripts/live-provider-smoke.ts`** (committed in
  `0435bbe`). It is read-only, never prints the key, paces requests 7s apart to stay inside the
  free tier's 10/minute limit, and reports per-step failures instead of aborting. Run it with:

  ```bash
  cd server && FOOTBALL_DATA_API_KEY=xxx npx tsx src/scripts/live-provider-smoke.ts
  ```

  *The four questions it answers:*
  1. Do the Champions League `availableStages` match the `ucl_swiss` mapping — in particular, are
     the August qualifier (`PLAY_OFF_ROUND`) and the February knockout (`PLAYOFFS`) genuinely two
     different strings? If one string covers both, `startStageKey` cannot separate them and the
     format needs rework.
  2. Does `/teams?season=2026` return the 29 automatic qualifiers *before* the 27 August draw, or
     only after? A "no" is survivable — the UI shows "teams confirmed after the draw" and fills
     itself in — but it is worth knowing.
  3. **Does `/matches` expose `score.regularTime` on a completed extra-time match?** This is the
     real blocker. The agreed rule scores on the end of normal time, so if the provider only
     reports the after-extra-time score, the rule is not implementable here and the adapter
     should target API-Football instead.
  4. Does `/competitions/PL/matches?season=2026` return 380 fixtures with matchdays?

  Then write `server/src/live/providers/{types,footballData,rateLimiter,index}.ts` against the
  real payloads, correcting the stage mapping and the normal-time extraction in §6 — several
  field names there were written from memory, because the provider's docs host was unreachable.
  *Tests:* `server/src/live/providers/footballData.test.ts` — raw→DTO mapping against captured
  JSON fixtures committed as test data. No network in tests.

- [ ] **Phase 3 — Sync + admin tournament API.**
  `server/src/live/sync.ts`, `scheduler.ts`, `routes/tournaments.ts`, mounted in `index.ts`.
  *Verify:* `GET /api/live/presets` returns both entries; `POST /api/live/tournaments
  {presetKey:'ucl_2026_27'}` creates and populates; `GET /tournaments/:id/teams` shows
  qualification statuses; `GET /tournaments/:id/fixtures?stageKey=league_phase` is legitimately
  empty pre-draw; the Premier League preset returns a full fixture list with matchdays. Watch the
  log for scheduler ticks and confirm the rate limiter queues rather than 429s.

- [ ] **Phase 4 — Prediction leagues, lock, scoring.**
  `server/src/live/routes/competitions.ts`, `scoring.ts`, `scoringTrigger.ts`, `liveEvents.ts`.
  *Verify:* create a live competition on the Premier League preset (it has real dated fixtures
  now, unlike UCL), join by invite code, `PUT` a prediction on a fixture >1 h out (200) and one
  <1 h out (400). Then set a fixture's `kickoffAt` into the past via SQL, run a sync, and confirm
  scoring fires and the leaderboard moves.
  *Tests:* `server/src/live/scoring.test.ts` — the full table from §2, plus: unfinished fixture
  scores 0, null normal-time scores 0, and an extra-time fixture scores on normal time only.

- [ ] **Phase 5 — Client.**
  Pages, components, routes, `api.put`, HomePage/AdminHomePage/Navbar entry points, i18n.
  *Verify:* end to end in the browser — create both tournaments as admin, create a competition,
  join as a normal user, enter predictions on a PL matchday, watch a countdown flip to Locked,
  watch a live score arrive over SSE. Confirm the UCL competition renders the qualified-teams
  panel rather than an empty fixture list.

- [ ] **Phase 6 — Polish.**
  Crest mirroring to R2, `lastSyncError` and unmapped-stage warnings in the admin UI, README and
  `CLAUDE_CONTEXT.md` refresh, `.env.example` entries.

No integration test harness exists (no test DB, and `server/src/db/client.ts` connects at import
time), so Phases 3–5 are verified manually. Pure functions — scoring, lock, provider mapping,
stage mapping, tie grouping — get Vitest coverage.

---

## 14. Risks and open questions

1. **Pre-draw UCL data is the main unknown.** football-data does expose CL qualifying stages, so
   play-off results should land — but whether `/teams?season=2026` lists the 29 automatic
   qualifiers before 27 August is not confirmed. Phase 2 answers it with one API call. If the
   answer is no, the fallback is honest rather than broken: the panel reads "teams confirmed
   after the draw" and self-populates. If the qualified-so-far list must definitely work,
   API-Football is the safer provider — the interface makes that a one-file swap.
2. **Stage string collision.** The qualifying `PLAY_OFF_ROUND` and the February knockout
   `PLAYOFFS` are easy to conflate, and getting it wrong would make summer qualifiers
   predictable. Confirm both strings against live data in Phase 2; the `startStageKey` filter is
   the safety net.
3. **`score.regularTime` availability** decides whether the 90-minute rule is implementable on
   this provider. The plan refuses to score rather than guessing — so if the field is missing,
   extra-time knockout fixtures would sit unscored until handled. Confirm in Phase 2 against a
   past season's knockout tie.
4. **Premier League volume.** 380 fixtures plus a per-fixture 1-hour deadline means users predict
   continuously all season rather than in one sitting. The matchday-grouped UI handles it, but it
   is a different rhythm from the existing World Cup product.
5. **Who creates live competitions?** Kept admin-only, matching `POST /api/competitions`. Easy to
   relax.
6. **Scoring config has no edit UI** — same as the manual type, where changes are made by SQL. The
   values are in a JSON column and `recalculateLiveTournament` exists, so an admin form is a small
   later addition when more tiers are added.

---

## 15. Deviations from the original plan

Recorded as they happen, so the document stays trustworthy.

**Phase 1**

| Change | Why |
|---|---|
| `schema.ts` does not re-export `liveSchema.ts`; `client.ts` merges the two and `drizzle.config.ts` takes an array | `liveSchema.ts` imports `users` from `schema.ts`, so re-exporting would be a circular import |
| Defensive DDL extracted to `server/src/live/ensureSchema.ts` instead of inlined in `index.ts` | The block in `index.ts` is already ~80 lines; keeping live code under `server/src/live/` also matches the separation rule |
| Migration hand-written rather than generated with `npm run db:generate` | `meta/` has no snapshots past `0004`, so generate would emit a destructive diff. Same reason `0005`–`0022` are hand-written |
| `providerStages` is `Partial<Record<LiveProviderId, string[]>>`, not `string[]` | Stage vocabularies are provider-specific; a second adapter should add a key, not fork the format |
| The four UCL summer qualifying rounds are mapped as stages | They must be ingestible to derive qualification status. Mapping them also makes the `PLAY_OFF_ROUND` / `PLAYOFFS` split explicit instead of implicit |
| `live_standings` unique key drops `group_name` | Nullable columns are distinct under Postgres unique constraints, so including it would allow duplicates in single-table formats |
| Lock test lives at `server/src/live/lock.test.ts`, not `shared/src/live/lock.test.ts` | Vitest only runs in the `server` workspace; this matches `server/src/lib/bracketSlots.test.ts` testing shared code |
| Added `minutesUntilLock()` and an explicit stale-kickoff rule for postponed fixtures | The countdown UI needs the former; the latter stops a provider's un-updated kickoff time from locking a match that was never played |

---

## 16. References

- [2026/27 Champions League: teams, dates, draws, format](https://www.uefa.com/uefachampionsleague/news/02a6-20d57cfcd03e-407c22a7f465-1000--2026-27-champions-league-teams-dates-draws-format-final/)
- [UEFA confirms date for the 2026/27 Champions League league phase draw](https://www.besoccer.com/new/uefa-confirms-date-for-the-202627-champions-league-league-phase-draw-1421299)
- [football-data.org coverage](https://www.football-data.org/coverage)
- [football-data.org API policies](https://docs.football-data.org/general/v4/policies.html)
