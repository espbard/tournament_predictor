# Live (API-linked) tournaments — implementation plan

> **Status:** All six phases landed. Schema, provider adapter, sync engine, scheduler, both APIs,
> the per-fixture lock, scoring, the client, and crest mirroring are all built, and every phase
> up to 4 was verified against the real provider and a real database.
>
> **One thing remains: nobody has driven the feature end to end in a browser.** Everything
> typechecks, builds and unit-tests, and the server side was verified directly — but saving a
> prediction through the UI, watching a countdown flip to Locked, and watching a score arrive
> over SSE are all still unproven. The checklist is in §0 under "Next step".
>
> Update the phase checkboxes in §13 as work lands, and record any deviation in §15.
>
> **The Phase 2 go/no-go passed:** `score.regularTime` is present, so the 90-minute scoring rule
> is implementable on football-data. See §0 for the full smoke-check results.

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
| `116f606` | Network allowlist requirement and handoff state |
| `5116c60` | Phase 2 — provider adapter, rate limiter, captured fixtures, 44 specs |
| `32ba519` | Phase 3 — sync engine, scheduler, admin tournament API, 39 specs |
| `b43aba8` | Phase 4 — competitions, per-fixture lock, scoring, SSE, 25 specs |
| `39fc537` | Phase 5 — client pages, components, routes, entry points, i18n |
| `81c6138` | Phase 6 — crest mirroring to R2, docs refresh, 13 specs |
| *(this)* | League table predictions — migration `0024`, 29 specs |

Later commits on the branch are documentation only unless a phase box in §13 says otherwise.

No pull request has been opened. The manual tournament type is untouched — the only edits to
existing files are additive (`shared/src/index.ts` re-export, `db/client.ts` schema merge,
`drizzle.config.ts` array, one `ensureLiveSchema()` call in `server/src/index.ts`).

### What Phases 1–2 delivered

- `shared/src/live/` — `types.ts`, `formats.ts`, `presets.ts`, `lock.ts`, `schemas.ts`, `index.ts`
- `server/src/db/liveSchema.ts` — the `live_*` tables (seven at phase 1; eight since table predictions)
- `server/drizzle/0023_live_tournaments.sql` + its `_journal.json` entry
- `server/src/live/ensureSchema.ts` — idempotent boot-time DDL
- `server/src/live/lock.test.ts` — 39 passing specs
- `.env.example` — the three new keys
- `server/src/live/providers/` — `types.ts`, `rateLimiter.ts`, `footballData.ts`, `index.ts`,
  `__fixtures__/*.json` (real captured payloads) and `footballData.test.ts` (44 specs)

### Phase 2 smoke-check results — run 21 August 2026 against the live API

All four questions in §13 are answered. **The provider choice is confirmed: stay on
football-data.** Full output is in the commit message; the decisions that came out of it:

| # | Question | Answer |
|---|---|---|
| 1 | Do the CL stage strings match `ucl_swiss`? | **Yes, exactly** — `LEAGUE_STAGE`, `PLAYOFFS`, `LAST_16`, `QUARTER_FINALS`, `SEMI_FINALS`, `FINAL`. The `PLAY_OFF_ROUND` / `PLAYOFFS` collision is moot: coverage starts at the league phase, so the summer qualifiers never appear (189 matches = 144+16+16+8+4+1) |
| 2 | Does `/teams?season=2026` list the automatic qualifiers pre-draw? | **No — it 404s.** football-data has not created the CL 2026/27 season at all; `seasons` runs 2025 back to 1980. It should appear after the 27 August draw |
| 3 | **Is `score.regularTime` exposed after extra time?** | **Yes — the blocker is cleared.** And the fallback it rules out is worse than assumed: for a shootout, `fullTime` is regular time *plus the shootout tally* (a 0-1 tie won 4-1 on pens reports `fullTime: 1-5`) |
| 4 | Does PL 2026 return 380 fixtures with matchdays? | **Yes** — 380 fixtures, 38 matchdays, `REGULAR_SEASON`, first kickoff 2026-08-21 |

Two further findings, both verified through the adapter against the live API:

- **`matchday` is the leg number** on two-legged knockout ties (`[1, 2]` on `PLAYOFFS`, `LAST_16`,
  `QUARTER_FINALS`, `SEMI_FINALS`). Phase 3 should use it directly instead of §7's "order legs by
  kickoff" derivation, which breaks when both legs share a date.
- **`season` combines fine with `dateFrom`/`dateTo`**, so `syncLiveWindow` in Phase 3 works as
  designed — a 3-day PL window returned 9 fixtures.

### Environment gotchas that cost time

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
   A third, `Cannot find module 'sharp'` in `routes/images.ts`, appears only when `sharp` is
   missing from `node_modules`; it is an install gap, not a code error. `npm install` clears it.
4. **`api.football-data.org` is blocked** by the environment's network policy *in a cloud
   session*. See below. It is reachable from a normal local checkout, which is where Phase 2 was
   ultimately run.

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

### Running against the real API

`FOOTBALL_DATA_API_KEY` is set in the repo-root `.env`, so from a local checkout both of these
work with no further setup:

```bash
cd server
npm run live:smoke     # re-run the Phase 2 go/no-go check
npm run live:doctor    # why does a tournament have no fixtures? (CL 2026 by default)
```

### A second provider for fixtures (August 2026)

football-data never published the Champions League 2026/27 match calendar in a useful
timeframe, so `live_tournaments` gained `fixture_provider` and `fixture_provider_competition_id`:
fixtures may come from another adapter while teams and standings stay put. `providers/bigBalls.ts`
is the first such adapter (bigballsdata.com, fixtures only).

Three things to know before extending it:

1. **Its schema has no team ids.** Fixtures are matched to stored teams by club name, in
   `live/teamMatching.ts` — normalise, fold a short alias table, and match on the full name
   before the short name before the three-letter code. An unmatched club leaves the fixture
   unlinked and raises an admin warning; it is never guessed at. New aliases go in that file.
2. **Its schema has no stage.** A stage-less fixture is filed under the tournament's
   `startStageKey`, which is right for a league phase and wrong for anything else.
3. **Its schema has no matchday**, and the matchday *is* the gameweek — `live_gameweek_selections`
   is keyed by (stage, matchday), the admin's selected-matches panel only lists fixtures that
   have one, and the fixtures tab pages a table stage by it. `live/matchdays.ts` derives it by
   clustering kickoff times: a new round starts at a gap of more than four days, and no round
   spans more than six, which recovers UEFA's published round numbering from a calendar whose
   rounds are a fortnight apart. A stage where the provider reported *any* matchday is left
   alone, so this is a no-op for football-data.
4. **Its score is a single pair**, with no regular/extra-time split. §6's refuse-to-guess rule
   cannot be applied to it, so it must not be used for knockout rounds. Move fixtures back to
   football-data before February, or verify a richer field set exists.

Two more things its documentation does not describe, both found the hard way when a
league phase arrived as 5 rounds of 10 instead of 8 of 18, and both handled in the adapter:
its match list **pages** — and does not say so in the response. The adapter first follows
whatever the envelope advertises (`next` / `meta.page` / `next_cursor` / `total`); when a
page-shaped count comes back with nothing to follow, it *discovers* the convention by
trying it: a size parameter (`limit`, `per_page`, `page_size`, `count`), then page numbers,
then offsets, keeping whichever actually returns matches not already held. A parameter the
API ignores returns the same page and is discarded, everything is de-duplicated by match id,
and the walk is capped — see `discoverPaging`, and it is **keyed by date rather than
season**, so a whole-season fetch sends an explicit June-to-July range instead of trusting
whatever window a "live + scheduled fixtures" endpoint defaults to.

**Its page size is `limit`, and it tops out at 200.** Asked for 500 it answers
`400 {"fieldErrors":{"limit":["Number must be less than or equal to 200"]}}` — so the probe
starts at 200 and, if a provider ever refuses while naming a size, reads that number out of the
rejection and asks again for exactly it (`maxFromLimitError`). It also validates query
parameters strictly, so the other paging conventions the discovery tries come back 400 and are
discarded, which is what discovery is for.

**A season is a span of dates, per competition.** `LiveTournamentPreset.seasonBounds` says
where one sits in the calendar — the Champions League 1 September to 1 June, a domestic league
1 August to 30 June — because they do not share a calendar and a single hardcoded span would
silently drop a domestic August. `server/src/live/season.ts` turns those bounds and a season
year into dates; the sync engine passes them to the adapter as `FetchFixturesOptions.seasonWindow`,
since a date-keyed provider has no season parameter to be asked with.

**Its date parameters are advisory.** `date_from`/`date_to` are accepted and ignored: asked
for 2026/27 it returned 273 matches, every Champions League fixture it holds, last season's
included. So `server/src/live/season.ts` defines the season as a span of dates once, the
adapter applies it to what comes *back* rather than trusting the request, and a structure sync
deletes stored fixtures outside it — skipping any that carry predictions, which are reported
instead of cascaded away. A request filter you cannot verify is not a filter.

**And football-data, asked the same day:** `GET /v4/competitions/CL/matches` with no filter
comes back `{"filters":{"season":"2026"},"resultSet":{"count":0},"matches":[]}` — it applies
2026 as the competition's *current* season and has no matches for it. So the season is real,
its teams and table are real, and the calendar simply is not there. Not a filter problem, not a
request problem.

Which leaves the state this branch ends in: **neither provider has a complete Champions League
2026/27 calendar.** Hence `expectedStartStageFixtures` on the preset (144 for the UCL league
phase, 380 for a Premier League season) and the `provider_has_partial_fixtures` verdict — the
check that was missing while 50 fixtures passed for a season, because everything here only ever
asked whether there were *any*.

**What a real response turned out to say (30 August 2026).** The envelope carries no
pagination whatsoever — `{ data, meta: {source, cached, request_id, note}, error }` — and its
`meta.note` reads *"Upcoming matches served from the stored table (no live adapter covers this
sport/league; refreshed by ingest)."* So the Champions League is not a competition this provider
covers live; it serves what an ingest job stored. On that date that was 50 matches: roughly 10
of each round's 18, and no round at all between 10 September and 13 October. The 50 may well be
a page cap, but the thinness within each round is not paging — it is the data. Read the
`rounds by date` line in the diagnostic before trusting a season to this.

The adapter was written from bigballsdata's published documentation, not from captured
payloads — unlike every football-data mapping here, which is pinned to real responses under
`__fixtures__/`. `npm run live:capture -w server` fetches and saves the real ones and reports
which fields are actually present; run it and correct the mapping and `bigBalls.test.ts` before
trusting it in production.

In production the same check is a button: **Ask the provider** on the admin tournament page
(`POST /api/live/tournaments/:id/diagnose`, admin-only, read-only, five requests through the
adapter's own rate limiter). `LiveProvider.probe` is what each adapter implements for it, and
`server/src/live/diagnostics.ts` turns the answers into a verdict — including
`never_fully_synced`, the case where the fixtures are there and only a *window* sync has run.

`live:doctor` is the local-script form of it, for when a tournament sits at zero fixtures. It asks
`/matches?season=`, `/matches` unfiltered, `/teams` and `/standings` separately and prints a
verdict, because the app cannot tell those apart on its own — an unpublished season, a published
season with no calendar yet, and a `season=` filter that returns nothing all look like "0
fixtures" in the admin UI. Point it elsewhere with `LIVE_DOCTOR_COMPETITION`, `LIVE_DOCTOR_SEASON`
and `LIVE_DOCTOR_FORMAT`.

Two things to remember. Requests are capped at **10 per minute** on the free tier, and the cap is
per account rather than per process — so a `npm run dev` server syncing in the background eats
the same budget as a script. And in a **cloud** session the host is blocked unless
`*.football-data.org` is allowlisted: at claude.ai/code, click the cloud icon above the message
box, hover the environment, open its settings, set **Network access** to **Custom**, add
`*.football-data.org`, and tick **"Also include default list of common package managers"** or
`npm install` breaks. Policy is read once at boot, so a **new session** is needed afterwards.
None of this applies to Railway, or to a local checkout.

### Next step

Two things, in this order.

**1. The end-to-end browser pass for Phase 5.** Everything is built and typechecks, but nobody
has yet driven it against a running server with a real session. That needs a database, a logged-in
admin, and `FOOTBALL_DATA_API_KEY` set:

```bash
npm run dev -w server     # needs DATABASE_URL and FOOTBALL_DATA_API_KEY
npm run dev -w client
```

Then, as admin: create the **Premier League 2026/27** tournament from
`/admin/live-tournaments`, create a league on it from `/admin/live-competitions`, join as a normal
user with the invite code shown there, and check each of these:

- a matchday of fixtures renders, and the matchday selector defaults to the current one
- a prediction saves, survives a reload, and overwrites rather than duplicating on re-save
- a countdown flips to **Locked** at kickoff − 60 min, and the inputs disable with it
- the leaderboard reflects points once a fixture finishes
- the Champions League tournament renders `LiveQualifiedTeamsPanel`, not an empty list
- the **Predictions** / **Results** dropdowns appear in the navbar on `/live/competitions/:id`
  and nowhere else, the page itself has no tab bar, and every section is reachable from them

To watch SSE and scoring fire without waiting for a real match, set a fixture's `kickoff_at` into
the past and its status to `finished` with a normal-time score, then trigger a sync from the admin
detail page.

**2. Then the feature is complete.** All six phases have landed; the browser pass above is the
only outstanding work in this plan.

Worth checking during that pass, since it is the one Phase 6 behaviour with no unit coverage:
**crest mirroring**. On the first full sync of a tournament the admin detail page should report
crests copied to storage, and every team crest afterwards should be served from a
`/api/images/live-teams/...` URL rather than `crests.football-data.org`. A second full sync should
report zero — if it re-mirrors every time, the preserve-existing-crest clause in `sync.ts`'s team
upsert is not working.

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

### Fixture multipliers

An admin can make one match worth more than the rest by giving it a whole-number multiplier
(`live_fixtures.multiplier`, default 1, capped at `LIVE_MAX_MULTIPLIER`). Everything the fixture
awards is multiplied by it, so a ×3 match maxes out at 12 rather than 4.

The extra is stored **separately** from the tiers, in `multiplier_bonus_points`: a perfect
prediction on a ×3 match is 1 + 1 + 2 with a bonus of 8, not 3 + 3 + 6. The leaderboard shows a
column per source, and inflating the tiers would make somebody look like a better predictor of
goal difference than they are purely because an admin highlighted a match they got right. The
four parts always sum to `points`.

The multiplier is set from the selected-matches panel, and changing it recalculates the
tournament there and then, exactly as deselecting a match does. The provider never owns this
column, so a sync leaves it alone.

### Top-scorer ranking

An admin curates a shortlist of players out of `live_players`; users order it by how many
goals each will finish the tournament on. Every player placed in exactly the right position
is worth `scorer_exact_position` (2 by default). No bands — a top-scorer list has no
meaningful sections, so close is worth nothing.

The final ranking is made **strict 1..N** by breaking a tie on goals with assists, and a tie
on both with the player's name (case-folded, and compared without `localeCompare` so the
order cannot differ between machines). Shared ranks were the alternative and were rejected:
with three players level on 9 goals, nobody could ever score positions 2 and 3.

The shortlist is built **by searching**, not by importing. An admin types a name, the
competition's squads are searched for it, and the player they pick becomes one row —
nothing else is stored. The squads come from the `squad` array on
`/competitions/{id}/teams` (the scorers endpoint lists only players who have *already
scored*, so it is empty before a competition starts and useless for building a list), and
they are cached in memory for ten minutes, so a burst of typing is one provider request
rather than one per keystroke.

Goals and assists then come from the scorers endpoint, on every cold sync and on demand.
That refresh **never creates a row**: a hundred scorers nobody picked have no business in
the list. A player the provider does not list at all can still be added by name, and is
adopted — given the provider's id, and kept current from then on — the first time a refresh
matches their name unambiguously. `live_players.provider_player_id` is what tells a
provider-backed row from a hand-kept one.

Each shortlisted player also carries a picture and a **glow colour** (`glow_color`, a hex
string), both chosen by the admin, and their club's crest is shown beside them. The colour is drawn as a tinted border and halo around
that player's row in the ranking every user sees; it is decoration and means nothing about
goals or points. An exactly-right player's green scored state wins over it — two glows on
one row fight. Points are withheld until the tournament is marked completed, exactly as bonus
points are, so the ranking cannot be reverse-engineered from a moving total mid-season.

### League table prediction

Alongside the per-fixture predictions, users order **every team in the table stage** from top to
bottom. Once every fixture in that stage has been played, each team is compared with where it
actually finished:

| Tier | Points |
|---|---|
| Team in exactly the right position | +1 |
| Team in the right *band* of the table | +1 |

The two stack, so in the Champions League a team placed exactly right is worth **2**, a team in
the right band but the wrong place **1**, and a team in the wrong band **0**.

Bands are format data, defined on the table stage (`LiveStageDef.bands`). The Champions League
league phase has three:

| Band | Positions |
|---|---|
| Automatic qualification | 1–8 |
| Play-off spots | 9–24 |
| Eliminated | 25 and below |

The Premier League defines **no** bands, so only exact positions score there. A format that adds
bands later needs no code change — just the entries.

**Deadline:** the table prediction closes when the *first* fixture of the stage would lock, i.e.
first kickoff − `LIVE_LOCK_MINUTES`. Predicting a final order only makes sense before any of it
has been played. A stage with no published dates yet stays open, which is the normal pre-draw
state.

**Scored when the stage completes** — every fixture `finished` or `cancelled`. A cancelled fixture
counts as done, since waiting for one that will never be played would strand the table forever; a
*postponed* one does not, because it is still expected and could still move the table. Positions
come from `live_standings` verbatim, never recomputed.

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
  table_exact_position: number;
  table_correct_band: number;
}
export const DEFAULT_LIVE_SCORING_CONFIG: LiveScoringConfig = {
  correct_outcome: 1, correct_goal_difference: 1, exact_score: 2,
  table_exact_position: 2, table_correct_band: 1,
};
```

Always read a stored config through `withLiveScoringDefaults()`. Competitions created before a
tier existed have a JSON blob without it, and arithmetic on `undefined` silently yields `NaN`.

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
`scorerNationalities` jsonb nullable · `lastStructureSyncAt` · `lastFixtureSyncAt` ·
`lastSyncError` text · `createdAt`.
**Unique** `(provider, provider_competition_id, season)`.

`scorerNationalities` is the scorer feed folded into goals per country —
`{ fetchedAt, count, truncated, byNationality: { "Norway": { goals, players } } }` — written
whole by `refreshLivePlayerGoals` from the payload it already fetches, and read whole by the
"Norwegian goals" stat card. One jsonb column rather than a table for the same reason
`ordered_team_ids` is one column: it is only ever read and written entire. Deliberately not
on `live_players`, which is the admin's curated shortlist and is meant to stay small.
`truncated` says the feed came back at the request limit, so every total in it is a floor;
anything printing those numbers has to say "at least".

### `live_teams`
`id` pk · `liveTournamentId` → cascade · `providerTeamId` · `name` · `shortName` · `tla` ·
`crestUrl` · `groupName` nullable · `qualificationStatus` (enum, default `pending`).
**Unique** `(live_tournament_id, provider_team_id)`.

### `live_fixtures`
`id` pk · `liveTournamentId` → cascade · `providerFixtureId` · `homeTeamId` / `awayTeamId` →
`live_teams` nullable (knockout fixtures exist before teams are known) · `kickoffAt` nullable ·
`kickoffConfirmed` bool · `status` enum · `stageKey` text nullable · `providerStage` text ·
`groupName` · `matchday` int · `tieKey` text nullable · `legNumber` int nullable ·
`multiplier` int not null default 1 (admin-set point multiplier; never written by a sync) ·

**Scores:** `normalTimeHome` / `normalTimeAway` (← the values that score) · `halfTimeHome` /
`halfTimeAway` · `extraTimeHome` / `extraTimeAway` · `penaltiesHome` / `penaltiesAway` ·
`finalHome` / `finalAway` (provider full-time, display only) · `winner` text · `minute` int ·
`providerScoreRaw` json (the provider's score object verbatim — small, and makes any mapping
bug diagnosable after the fact) · `providerLastUpdated` · `updatedAt`.

**Unique** `(live_tournament_id, provider_fixture_id)`.
**Index** `(live_tournament_id, kickoff_at)`, `(live_tournament_id, stage_key)`, `(status)`.

### `live_players`
`id` pk · `liveTournamentId` → cascade · `providerPlayerId` text nullable (null = added by
hand, and never overwritten by a sync) · `name` · `teamId` → `live_teams` set null ·
`position` text nullable (the provider's own wording) ·
`imageUrl` text nullable (admin-uploaded, R2 folder `live-players`) ·
`glowColor` text nullable (hex; the glow on this player's row in the ranking) · `goals` int ·
`assists` int (only ever used to break a tie on goals) · `isSelected` bool (the shortlist
users rank) · `providerLastUpdated` · `createdAt` · `updatedAt`.

**Unique** `(live_tournament_id, provider_player_id)` — NULLs are distinct in Postgres, so
every hand-added row is unique however many there are. **Index** `(live_tournament_id)`.

### `live_scorer_predictions`
`id` pk · `liveCompetitionId` → cascade · `userId` → cascade · `orderedPlayerIds` json
(whole ranking, index 0 = top scorer; no FK, so a player dropped from the shortlist leaves
a stale id rather than destroying the ranking) · `points` int nullable (null until the
tournament completes) · `exactPositionPoints` · `createdAt` · `updatedAt`.

**Unique** `(live_competition_id, user_id)`.

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

### `live_gameweek_selections`
`id` pk · `liveTournamentId` → cascade · `stageKey` text · `matchday` int ·
`selectedFixtureIds` json `$type<string[]>` · `createdAt` · `updatedAt`.
**Unique** `(live_tournament_id, stage_key, matchday)`.

Which matches of a gameweek — one matchday inside one stage — users actually predict on. A
gameweek with **no row here has nothing selected**: a tournament is not playable until an admin
has been through its gameweeks and picked, so no match becomes part of the game without someone
choosing it — including one the provider adds mid-season. A row is never stored with an empty
array; saving an empty selection deletes the row instead, which under this default means exactly
the same thing.

A fixture that sits in no gameweek at all — no stage key, or no matchday — is excluded for the
same reason: there is no gameweek an admin could register it under, so it cannot be opted in and
must not be included by default.

No FK on the fixture ids, for the same reason as `live_table_predictions.orderedTeamIds`: a
fixture the provider drops degrades to a stale id rather than silently widening the selection.
The rule itself lives in `shared/src/live/selection.ts` so the client applies exactly the same
one, and it is enforced in three places — the fixtures read models, `PUT /predictions`, and the
scoring trigger.

### `live_bonus_questions` / `live_bonus_answers`
`live_bonus_questions`: `id` pk · `liveTournamentId` → cascade · `question` · `answerType`
(`live_bonus_answer_type`: number / player / team / yes_no / country) · `points` ·
`correctAnswer` text nullable · `lockAt` timestamp nullable · `minValue` / `maxValue` /
`leeway` int nullable · `options` json nullable · `createdAt`.

`live_bonus_answers`: `id` pk · `questionId` → cascade · `liveCompetitionId` → cascade · `userId`
→ cascade · `answer` · `points` int nullable · `createdAt` · `updatedAt`.
**Unique** `(question_id, live_competition_id, user_id)` — the constraint the manual
`bonus_answers` table enforces in app code only.

Season-long side bets. Questions belong to the **tournament** so every league playing it asks
the same ones; answers belong to a **competition**. Two rules differ from the manual type:

- **The deadline.** A live competition has no competition-wide deadline, so a question closes at
  its own `lockAt` when an admin set one, and otherwise an hour before the first match of the
  tournament's starting stage — the same instant the table prediction locks (`bonusQuestionLockAt`
  in `shared/src/live/lock.ts`). The override is what makes a question added mid-season
  answerable at all; without it, it would be born locked.
- **Nothing else.** Points are still withheld until the tournament is marked `completed`, exactly
  as in the manual type, so nobody can infer a correct answer from a leaderboard that moved.

**Constraints** (`shared/src/live/bonus.ts`) — all optional, and all enforced in that one
module so the answer input, the save route and scoring cannot disagree:

- `minValue` / `maxValue` bound a number answer; one outside is refused rather than scored 0.
- `leeway` widens what counts as right: "25, give or take 5" pays full points for 20 through 30.
  It never scales the award — a bonus question stays all-or-nothing.
- `options` lists the answers a player, team or country question accepts. Null or empty means
  every option: the tournament's teams for `team`, `EUROPEAN_COUNTRIES` (UEFA's 55 members) for
  `country`, and anything at all for `player`, which has no roster to check against.

An answer differing from an option only by case or spacing is accepted and stored as the option
spells it, so scoring never turns on how somebody typed it.

`server/src/live/bonusScoring.ts` holds the scoring (all-or-nothing, trimmed and
case-insensitive, several correct answers stored as a JSON array) and
`server/src/live/bonusVisibility.ts` the redaction — deliberately without the manual version's
test-account preview, which exists for a Final Results page the live type does not have.

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
awarded. **Verified against live data 21 Aug 2026** and implemented as `normalTimeFromScore`:

```
if score.duration === 'REGULAR'        → normalTime = score.fullTime
else if score.regularTime is present   → normalTime = score.regularTime
else                                   → normalTime = null, flag the fixture, do not score it
```

Never silently fall back to `fullTime` for an extra-time match — that would hand out points on a
scoreline the rules exclude. The captured payloads show this is worse than a rounding concern:
football-data reports a shootout's `fullTime` as **regular time plus the shootout tally**, so
Liverpool 0-1 PSG, won 4-1 on penalties, arrives as `fullTime: {home: 1, away: 5}` — a scoreline
that never happened in any period of play. A fixture with `normalTime = null` and status
`finished` is surfaced in the admin UI as needing attention, and `providerScoreRaw` retains
everything needed to fix it.

**Confirmed payload shapes.** Real trimmed responses are committed under
`server/src/live/providers/__fixtures__/` and are what `footballData.test.ts` runs against, so the
mapping is pinned without network access. Field names that differ from ours, and bit us:

| Provider | Ours | Note |
|---|---|---|
| `playedGames` | `played` | standings row |
| `draw` | `drawn` | standings row |
| `crest` | `crestUrl` | team |
| `utcDate` | `kickoffAt` | fixture |
| `lastUpdated` | `providerLastUpdated` | fixture |

`/standings` returns **three tables per stage** — `type` of `TOTAL`, `HOME` and `AWAY`. Only
`TOTAL` is the real table; keeping all three would triple every row and violate the
`(tournament, stage, team)` unique key on `live_standings`. `form` comes back as `""` rather than
null on the `HOME`/`AWAY` tables and early in a season, so it is normalised to null.

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
sorted by `totalPoints` desc: one column per point source, in the order a season earns them —
Result, GD, Exact, Highlight (what multiplied matches added), Table, Scorers, Bonus, Total.
All of them are always shown, zeros dimmed rather than hidden, because a table that changes
shape mid-season answers nobody's "what else can I score for?".

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
| GET | `/tournaments/:id/bonus-questions` | auth | correct answers redacted until the tournament is completed |
| POST / PATCH / DELETE | `/tournaments/:id/bonus-questions[/:questionId]` | admin | recording a correct answer scores it, but only once the tournament is completed |
| GET | `/tournaments/:id/selected-matches` | auth | every gameweek with `isCustomised` and its selected fixture ids |
| PUT | `/tournaments/:id/selected-matches` | admin | `{stageKey, matchday, fixtureIds}`; `fixtureIds: null` (or empty) resets the gameweek to "all selected". Recalculates the tournament, since a deselected match must give its points back |
| PATCH | `/tournaments/:id/fixtures/:fixtureId/multiplier` | admin | `{multiplier}`, a whole number from 1 to `LIVE_MAX_MULTIPLIER`. Recalculates the tournament, since an already-scored match has to be rescored |
| GET | `/tournaments/:id/players` | auth | the top-scorer list, shortlist first |
| POST / PATCH / DELETE | `/tournaments/:id/players[/:playerId]` | admin | `{name, teamId?, imageUrl?, goals?, assists?, isSelected?}`; anything touching goals, assists or the shortlist recalculates the tournament |
| GET | `/tournaments/:id/players/search` | admin | `?q=&season=` — search the competition's squads by name, folded for accents. Answers from a ten-minute cache of the squads |
| POST | `/tournaments/:id/players/refresh` | admin | `{season?, limit?}` — refresh the list's goals from the scorer endpoint. Adds nobody |
| DELETE | `/tournaments/:id/players/unselected` | admin | drop every player not in the shortlist — the clean-up for tournaments that were populated by the old whole-squad import. Registered before the `:playerId` route, or "unselected" would be read as an id |

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
| GET | `/competitions/:id/user-stats?lang=` | auth (member) **+ test account or admin** — the stat-card deck, worded server-side |
| GET | `/competitions/:id/events` | auth — SSE: `fixtures-updated`, `leaderboard-updated` |
| GET | `/competitions/:id/fixtures` | auth — **main read model**: fixtures for a stage/matchday + caller's prediction + `lockedAt` + `isLocked` + `isSelected` + awarded points, in one call |
| PUT | `/competitions/:id/predictions` | auth — upsert one `{fixtureId, homeScore, awayScore}`; rejects a fixture left out of its gameweek's selected matches |
| GET | `/competitions/:id/predictions/:userId` | auth — another member's, **only for already-locked fixtures** |
| GET | `/competitions/:id/bonus-questions` | auth — the questions plus `lockedAt` / `isLocked` per question |
| GET / PUT | `/competitions/:id/bonus-answers` | auth — the caller's answers; `PUT {questionId, answer}` upserts one, enforcing that question's deadline |
| GET | `/competitions/:id/bonus-answers/:userId` | auth — another member's, **only for already-locked questions** |

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
| `/live/competitions/:id/predictions/:userId` | `pages/live/LiveUserPredictionsPage.tsx` | Private |
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
  `format.tableScope`. Where the stage defines bands, each row carries a bar down its left in
  the band's colour, with `LiveTableBandLegend` underneath saying what they mean. Beside each
  team's crest sits a dimmed second one — the team the viewer predicted to finish there — and
  the row glows to say how the viewer placed *that row's* team: green where they put it in
  exactly this position, amber where they put it elsewhere but in this section of the table.
- `LiveTableBandLegend.tsx` — the swatches-and-ranges key, shown under both the real table and
  the predicted one. The colours themselves live in `lib/liveBands.ts` so the two agree.
- `LiveSelectedMatchesPanel.tsx` — admin only, rendered on `AdminLiveTournamentDetailPage`. Picks
  a stage and gameweek, then ticks which of its matches count. Opens on the gameweek of the next
  match still to be played, and saving with nothing ticked resets the gameweek to "all count".
- `LiveGateShell.tsx` / `LiveTablePredictionGate.tsx` / `LiveBonusQuestionsGate.tsx` — the
  full-screen, dark blue to black first-run flow a member sees instead of the competition until
  the season-long predictions are in: the table first, then any open bonus question they have
  not answered, one per screen with a "Question n/m" counter. Neither prediction can be made
  later — both close at the first kickoff — which is why they are asked for up front and why
  the competition is unreachable until they are done. Three groups are deliberately let through
  rather than trapped: anyone who can no longer submit, accounts that may not predict at all,
  and admins, who need to inspect a competition without playing it; a bonus question that has
  already locked is skipped on the same grounds. The table step renders `LiveTablePrediction`
  in its `gate` variant — same list, save control pinned to the foot of the screen, and the
  standings order on screen counts as a submission untouched. The bonus step writes its own
  controls rather than sharing the panel's: required answers are large and alone on a dark
  screen. A player, team or country answer must be picked from its list here as everywhere
  else — `PlayerSearchInput`'s `allowFreeText` is for the admin side only.
- `LiveBonusQuestionsTab.tsx` / `AdminLiveBonusQuestionsPanel.tsx` — the data half of the bonus
  tab and of the admin authoring panel. Both render
  `components/bonus/BonusQuestionsPanel.tsx`, which is the manual type's bonus UI lifted out of
  `pages/BonusQuestionsTab.tsx` and driven by an adapter: same panel, different endpoints and a
  per-question rather than per-competition deadline.
- `LiveFixtureList.tsx` — the stage's matches, grouped the way the stage is played: one
  matchday for a table stage, `LiveTieCard`s for a two-legged knockout one. Shared by the
  competition page and the read-only view of another member's predictions.
- `LiveMatchPredictions.tsx` — the collapsed "what everyone predicted" dropdown under a
  played match: every member, their score and what it was worth, names linking to their
  predictions. Fetched only once opened.
- `LiveLeaderboard.tsx`, `LiveQualifiedTeamsPanel.tsx`.
- `client/src/lib/liveApi.ts` — typed thin wrappers over the existing `client/src/lib/api.ts`.
  Note `api` currently has no `put` — add one.

`LiveCompetitionDetailPage` renders one section at a time, chosen by `?tab=`, exactly as
`CompetitionDetailPage` does — including navigating from the navbar rather than an in-page tab
bar. Its five sections fall under the navbar's two dropdowns: **Predictions** (Fixtures · Table
prediction · Bonus questions) and **Results** (Table · Leaderboard). No knockout tab, no bracket,
no group-position tab.

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
  manual eight-tab set. A sibling branch matches `/live/competitions/:id` and renders the live
  sections under the same two **Predictions** / **Results** dropdowns. It reuses the dropdown
  markup and open/close state, but stays a separate branch: the two tournament types share no
  sections, so do not merge the live entries into the manual dropdowns.

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
- Players, late-additions, comparison-user bypass, group-stage self-lock, tiebreak choices —
  none carry over
- Bonus questions were originally out of scope, and now exist on their own `live_bonus_*` tables
  with their own scoring and visibility modules. The only thing shared is the *UI*:
  `client/src/components/bonus/BonusQuestionsPanel.tsx`, which both types render through an
  adapter.

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

- [x] **Phase 2 — Provider adapter, no DB writes. The go/no-go phase.** *(done — **passed**)*

  `server/src/live/providers/{types,footballData,rateLimiter,index}.ts`, written against real
  payloads rather than the from-memory field names §6 originally carried.

  *Go/no-go:* **passed.** `score.regularTime` is present on finished extra-time and shootout
  matches, so the 90-minute rule is implementable and there is no need to move to API-Football.
  All four questions are answered in the table in §0, along with two extra findings (`matchday`
  carries the leg number; `season` combines with `dateFrom`/`dateTo`).

  *Verified:* the smoke script (`server/src/scripts/live-provider-smoke.ts`, unchanged from
  `0435bbe`) run against the live API, then the adapter itself exercised end-to-end — a 3-day PL
  window returned 9 fixtures, CL 2024 standings mapped to exactly 36 rows with `HOME`/`AWAY`
  duplicates dropped, and `CL 2026` surfaced as `ProviderError.isSeasonUnavailable` rather than
  crashing. `npx vitest run` is green (131 specs across 4 files) and `npx tsc --noEmit` reports
  only the 2 pre-existing errors in `routes/competitions.ts`.

  *Tests:* `server/src/live/providers/footballData.test.ts` — 44 specs covering raw→DTO mapping,
  the stage vocabulary and the rate limiter, run against real payloads captured into
  `__fixtures__/`. No network in tests.

- [x] **Phase 3 — Sync + admin tournament API.** *(done)*
  `server/src/live/sync.ts`, `scheduler.ts`, `routes/tournaments.ts`, mounted in `index.ts`.

  *Verified* end to end against the real provider and a real Postgres, by creating two
  tournaments, syncing, asserting, then deleting them:
  - **Premier League 2026/27** — 20 teams, 380 fixtures, 38 distinct matchdays, every fixture
    mapped to `regular_season` with a linked home team and a kickoff time, and no tie metadata
    on a table format. A second structure sync left the count at 380 and reported nothing newly
    finished, confirming the provider-id upserts are genuinely idempotent.
  - **Champions League 2024/25** (a completed season, which is what exercises the knockout
    paths) — 189 fixtures, 36 standings rows, all six stages mapped, 44 two-legged fixtures
    forming exactly 22 ties each holding legs 1 and 2, the final single-leg, every finished
    fixture carrying a normal-time score, and shootout fixtures storing normal time rather than
    the provider's inflated full-time value. All 36 teams derived as `qualified`.
  - Cleanup deleted both tournaments and left zero orphaned teams, fixtures or standings.

  *Tests:* `sync.test.ts` and `scheduler.test.ts` — 39 specs over the pure helpers (tie
  grouping, qualification derivation, live-window dates, temperature classification, request
  budgeting). 170 specs across the workspace in total.

- [x] **Phase 4 — Prediction leagues, lock, scoring.** *(done)*
  `server/src/live/routes/competitions.ts`, `scoring.ts`, `scoringTrigger.ts`, `liveEvents.ts`,
  plus `POST /tournaments/:id/recalculate` and the scheduler's scoring hand-off.

  *Verified* against the real provider and a real Postgres, on a Premier League tournament and
  competition created and then deleted:
  - **Lock** — a fixture far out is open; `lockedAt` is exactly kickoff − 60 min; moved to 30
    minutes before kickoff it locks; moved to 90 minutes it reopens.
  - **Predictions** — the `(competition, user, fixture)` unique constraint makes the upsert
    overwrite rather than duplicate.
  - **Scoring** — all four tiers against a real 2–1 result: 4 / 2 / 1 / 0, member total 7, every
    breakdown column correct. Re-scoring the same fixtures leaves the total at 7 rather than
    doubling it.
  - **Unscorable** — nulling a normal-time score sets points back to `null` rather than 0 and
    drops the total to 3; restoring the score brings it back to 7.
  - **Config change** — rebuilding under a custom config gives 29, cross-checked against the
    pure scoring function.
  - Deleting the competition and tournament cascaded away every prediction, member and fixture.

  *Tests:* `scoring.test.ts` — 25 specs covering the full table from §2, every non-finished
  status, null normal-time scores, extra-time fixtures scoring on normal time only, and custom
  configs. 195 specs across the workspace in total.

- [x] **Phase 5 — Client.** *(built; end-to-end browser pass still outstanding — see below)*
  `client/src/lib/liveApi.ts` (+ `api.put`), `components/live/` (`LiveFixtureCard`,
  `LiveTieCard`, `LiveCountdown`, `LiveStandingsTable`, `LiveLeaderboard`,
  `LiveQualifiedTeamsPanel`), `pages/live/` (`LiveCompetitionDetailPage`,
  `AdminLiveTournamentsPage`, `AdminLiveTournamentDetailPage`, `AdminLiveCompetitionsPage`),
  four routes in `App.tsx`, a live tab branch in `Navbar`, entry points on
  `HomePage`/`AdminHomePage`, and a `live` i18n block in all three languages.

  *Verified so far:* `npx tsc --noEmit` is clean in `client/` (0 errors) and unchanged in
  `server/` (the 2 pre-existing), `npm run build` succeeds, and the app boots and renders in a
  browser with no JavaScript errors. All **172** translation keys the new code references —
  including the runtime-built `live.status.*` / `live.tournamentStatus.*` /
  `live.qualification.*` keys and every stage `labelKey` from `shared/src/live/formats.ts` —
  resolve in **en, no and de**.

  *Still to verify, and it needs a running server plus a logged-in session:* create both
  tournaments as admin, create a competition, join as a normal user, enter predictions on a
  Premier League matchday, watch a countdown flip to Locked at kickoff − 60 min, and watch a
  live score arrive over SSE. Confirm the Champions League competition renders
  `LiveQualifiedTeamsPanel` rather than an empty fixture list.

- [x] **Phase 6 — Polish.** *(done)*
  `server/src/live/crests.ts` mirrors team crests into R2 under `live-teams/`; `lib/r2.ts` gained
  `uploadBufferToR2` and an `R2Folder` union; `routes/images.ts` serves the new folder. The
  `lastSyncError`, unmapped-stage and unscorable-fixture warnings already landed in Phase 5's
  `AdminLiveTournamentDetailPage`. README, `CLAUDE_CONTEXT.md` and `.env.example` refreshed —
  the last of those was missing `LIVE_SYNC_TICK_BUDGET` and `FOOTBALL_DATA_RATE_LIMIT` entirely,
  and had `LIVE_SYNC_ENABLED=true` where the code defaults it off.
  *Tests:* `crests.test.ts` — 13 specs over the pure helpers (extension parsing, content-type
  resolution, and the idempotency guard that stops a mirrored crest being re-downloaded).

No integration test harness exists (no test DB, and `server/src/db/client.ts` connects at import
time), so Phases 3–5 are verified manually. Pure functions — scoring, lock, provider mapping,
stage mapping, tie grouping — get Vitest coverage.

---

## 14. Risks and open questions

1. ~~**Pre-draw UCL data is the main unknown.**~~ **Resolved in Phase 2, worse than feared but
   manageable.** It is not that `/teams?season=2026` returns a short list — the CL 2026/27 season
   does not exist at the provider at all, and *every* endpoint 404s for it. So the fallback is
   mandatory, not optional: the qualified-teams panel must render from zero rows, and the sync
   engine must treat a 404 as "not published yet" rather than an error. Also note football-data
   does **not** cover the CL qualifying rounds, so the 29-automatic-qualifiers list cannot be
   derived from play-off results either. Everything appears at once after the 27 August draw.
   If a pre-draw qualified list is genuinely required, API-Football is the fallback — the
   provider interface makes that a one-file swap.
2. ~~**Stage string collision.**~~ **Resolved in Phase 2: no collision exists.** football-data's
   CL coverage begins at the league phase (189 matches = 144+16+16+8+4+1), so `PLAY_OFF_ROUND`
   never appears and only the February `PLAYOFFS` is ever emitted. The four summer qualifying
   stages in `ucl_swiss` are therefore dead mappings today. They are deliberately kept: they cost
   nothing, `providerStages` is per-provider by design, and a test pins the two strings apart in
   case coverage ever widens.
3. ~~**`score.regularTime` availability.**~~ **Resolved in Phase 2: present.** Confirmed on both
   `EXTRA_TIME` and `PENALTY_SHOOTOUT` fixtures from the 2024/25 season. The refuse-to-guess rule
   is implemented and unit-tested, so the "sits unscored" path only triggers if the provider
   regresses.
4. **Premier League volume.** 380 fixtures plus a per-fixture 1-hour deadline means users predict
   continuously all season rather than in one sitting. The matchday-grouped UI handles it, but it
   is a different rhythm from the existing World Cup product.
5. **Who creates live competitions?** Kept admin-only, matching `POST /api/competitions`. Easy to
   relax.
6. **Scoring config has no edit UI** — same as the manual type, where changes are made by SQL. The
   values are in a JSON column and `recalculateLiveTournament` exists, so an admin form is a small
   later addition when more tiers are added. Note `PATCH /api/live/competitions/:id` *does* accept
   a `scoringConfig` and recalculates on change, so the endpoint is ready when a form appears.
7. **Invite codes can collide across the two tournament types.** Both generate a 5-digit numeric
   code, in separate tables with separate uniqueness constraints, so the same code can exist as
   both a manual and a live competition. The single join box on `HomePage` tries the manual
   endpoint first, so a colliding code would always join the manual league and the live one would
   be unreachable by code. With a handful of leagues the odds are negligible, and the fix is a
   one-character prefix on live codes — but it would need the existing codes left alone, so it is
   recorded rather than done.

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

**Phase 2**

| Change | Why |
|---|---|
| An unknown provider status maps to `suspended`, not `scheduled` | `scheduled` and `postponed` are the only statuses that leave a fixture open for predictions. Guessing either for an unrecognised state could reopen a match already played; `suspended` locks it and awards nothing |
| `ProviderFixtureScore.normalTime` is a `{home, away}` pair of nullables rather than a nullable pair | Keeps one shape for all six score sections. "Refuse to score" is expressed as both sides null, which §9's scoring rule already treats as zero points |
| Added `ProviderError.isSeasonUnavailable` | A 404 on an unpublished season is an expected state for a tournament created before its draw, not a failure. The sync engine needs to tell the two apart |
| Added `ProviderError.retryable` and `RateLimiter.availableNow()` | §7's tick needs to know whether to re-try and how much of the minute's budget is left; both were implied by the design but had no accessor |
| `mapStandings` keeps only `type === 'TOTAL'` | Not in the original design because the three-tables-per-stage shape was unknown. Keeping all three triples every row and violates the `live_standings` unique key |
| Test fixtures are read with `readFileSync` rather than imported | Avoids adding `resolveJsonModule` to the server tsconfig, and keeps raw payloads typed as `any`, which is what they are |
| §7's "order legs by kickoff" derivation is superseded by the provider's `matchday` | Verified: two-legged ties come back with `matchday` 1 and 2. Kickoff ordering is ambiguous when both legs share a date |
| The four UCL summer qualifying stages are kept despite being unreachable | football-data's CL coverage starts at the league phase. They cost nothing, and removing them would drop the guard that keeps `PLAY_OFF_ROUND` and `PLAYOFFS` distinct |

**Phase 3**

| Change | Why |
|---|---|
| `ProviderFixture` gained `homeTeam` / `awayTeam` objects alongside the ids | Fixtures embed their teams, so the sync can create a team row for anyone missing from `/teams`. Without it a fixture could point at a team that was never inserted — the exact shape of the pre-draw Champions League, where `/teams` 404s while `/matches` may not |
| `legNumber` comes from the provider's `matchday`, with kickoff order only as a fallback | Phase 2 verified two-legged ties report matchday 1 and 2. §7's kickoff ordering is ambiguous when both legs share a date and wrong when a leg is postponed |
| Qualification never derives `eliminated` on football-data | §7 derived it from lost ties below `startStageKey`, but the provider does not cover the CL qualifiers at all. The branch is kept for providers that do; here teams go `pending` → `qualified` at the draw |
| Fixture team links are upgraded but never cleared (`coalesce(excluded.…, existing)`) | Once a draw assigns a team, a later payload that omits it must not blank out the opponent users have already predicted against |
| Standings sync deletes rows the provider no longer lists | Upsert alone would leave a team that dropped out of the table sitting at a stale position |
| `syncTournamentStructure` tolerates a 404 from `/teams` and `/standings` independently | A season can have fixtures but no table yet, or vice versa. Only a total failure is an error |
| Scheduler added a request *budget* (`LIVE_SYNC_TICK_BUDGET`, default 6) and a cost per sync kind | §7 said "at most one hot tournament per minute", which does not generalise. Costing structure syncs at 3 requests and window syncs at 1, then sorting by temperature and staleness, keeps the tick inside the free tier and stops a busy competition starving the others |
| `LIVE_SYNC_ENABLED` defaults to off | Two developers running `npm run dev` would otherwise both spend the shared 10 req/min account budget without realising |

**Phase 4**

| Change | Why |
|---|---|
| `recalculateLiveCompetition` clears points to `null` on an unscorable fixture rather than writing 0 | The UI has to tell "not scored yet" apart from "scored, earned nothing". A stored 0 conflates them |
| `PATCH /competitions/:id` triggers a recalculation when `scoringConfig` changes | Stored points were computed under the old values, so leaving them would silently show wrong totals until the next fixture finished |
| Member totals are rebuilt with one `UPDATE … FROM (SELECT … SUM …)`, including members with no scored predictions | A read-sum-write loop could drift if two ticks overlap. Including zero-prediction members is what makes recalculation after a config change correct rather than leaving stale rows |
| `applySyncResult` lives in `scoringTrigger.ts`, not in `sync.ts` | Keeps syncing a pure data concern; the scheduler owns the scoring and SSE hand-off. §7 implied the sync would call scoring directly |
| The leaderboard ranks with equal totals sharing a rank and the next rank skipping | Standard competition ranking. §9 only said "sorted by totalPoints desc", which leaves ties undefined |
| `POST /competitions/:id/recalculate` added alongside the tournament-level one in §10 | An admin fixing one league should not have to rebuild every league on the tournament |
| Comparison-user bot accounts get no lock bypass, and `isLeaderboardUser` accounts are refused outright | §8 specified both; recorded here because the manual type does grant comparison users a bypass, so the difference is deliberate rather than an oversight |

**Phase 5**

| Change | Why |
|---|---|
| The fixtures tab fetches **every** fixture once and filters stage/matchday in memory, rather than one request per stage as §11's query keys implied | One request instead of dozens, instant stage switching, and a single key for the SSE handler to invalidate. Even the Premier League's 380 fixtures are a modest payload for a ~20-person app |
| One invite-code box on `HomePage` that tries the manual endpoint and falls back to the live one on a 404, rather than §11's separate live join form | Users should not have to know which kind of league a code belongs to. See the caveat in §14.7 — the two code spaces can collide |
| `ListFixturesParams` is a type alias, not an interface | Only aliases get an implicit index signature, which is what lets the object be passed to the `Record`-typed query-string helper |
| `LiveCountdown` re-reads `minutesUntilLock` on a variable interval (5s under 2 min, 15s under an hour, else 60s) | A per-second timer on 380 mounted fixture cards is wasteful, and nothing visibly changes minute-to-minute an hour out |
| `LiveFixtureCard` only adopts a refetched prediction when its inputs are empty | A background refetch or an SSE push must not overwrite a score the user is midway through typing |
| The live tab bar is a sibling branch in `Navbar`, not an extension of the existing dropdowns | §11 called for this explicitly; the two tournament types share no tabs |
| Crests are rendered directly from `crestUrl` | Phase 6 mirrors them into R2 and rewrites the column; the component needs no change when that lands |

**Phase 6**

| Change | Why |
|---|---|
| Added `uploadBufferToR2` alongside `uploadToR2` rather than reusing it | `uploadToR2` takes an `Express.Multer.File`. A crest arrives as fetched bytes, and faking a multer object to reuse the function would be worse than splitting out the part that actually differs |
| The team upsert preserves an existing `/api/images/%` crest instead of taking the provider's | Without it every sync would reset the column to the provider URL and re-download all 36 crests. This is the whole idempotency mechanism, and it lives in `sync.ts` rather than `crests.ts` |
| Crest mirroring is best-effort, capped at 60 per sync, 4 concurrent, and skipped entirely when R2 is unconfigured | It runs last, after fixtures and standings are already saved. A crest CDN being down must not cost a sync, and a local dev environment without R2 should degrade to provider URLs rather than erroring every tick |
| A crest the provider *changes* is never re-fetched | A mirrored URL is indistinguishable from an up-to-date one without storing the provider URL separately, which would need a schema change. Crests change rarely; clearing the column forces a refresh |
| `client/src/lib/api.ts`'s `uploadFile` type union was **not** extended with `'live-teams'`, contrary to §11 | Nothing uploads a crest from the browser — mirroring is entirely server-side. Adding an option no caller can reach would be misleading |
| `.env.example` now shows `LIVE_SYNC_ENABLED=false` | It previously showed `true`, contradicting the code, which requires the string `"true"` to enable the scheduler. An example file that misstates the default is worse than no example |

**League table predictions** *(added after the six phases, on request)*

| Decision | Why |
|---|---|
| Bands live on `LiveStageDef`, not in scoring code | They are a property of the competition's shape, like stages themselves. The Premier League defines none and so scores exact positions only, with no special-casing anywhere |
| The order is stored as one `json` array, not a row per team | The ordering *is* the prediction; it is only ever read and written whole. A row per team would need 36 upserts per save and a position column that can never be allowed to collide |
| No FK on the team ids inside that array | A team removed from the tournament degrades to a stale id that simply scores nothing, rather than a cascade deleting the whole prediction |
| The deadline is the *first* fixture of the stage, not a per-fixture lock | Predicting a final order only makes sense before any of it has been played. Reuses `LIVE_LOCK_MINUTES` so there is still one lock rule |
| A cancelled fixture counts as "stage complete", a postponed one does not | Waiting on a match that will never be played would strand the table unscored forever; a postponed one is still expected and could still move it |
| The server re-validates the submitted order as a complete permutation | A partial or duplicated table would quietly distort scoring — duplicating a team you are confident about, or omitting one you are not |
| `LiveScoreResult` (per fixture) no longer extends `LiveScoreBreakdown` | The breakdown now includes table points, which a single fixture can never produce. Sharing the type would have forced a meaningless field onto every fixture result |
| Member totals moved to two `LEFT JOIN LATERAL` subqueries | Fixture points and table points are independent sources; summing them in one join would multiply the rows together |
| `moveItem` / `initialOrder` extracted to `client/src/lib/liveTableOrder.ts` | Pure logic worth checking without mounting React. Extracting it surfaced a real bug: a guard clause could return early and leave the table an incomplete permutation, which the server would then reject on save |

**Seeing what everyone else predicted** *(added after the six phases, on request)*

| Decision | Why |
|---|---|
| One request per fixture, made only when the dropdown is opened, rather than folding every member's predictions into the fixtures read model | A Premier League season is 380 fixtures × ~20 members. Nobody opens more than a handful, and the fixtures query is invalidated on every SSE push, which would re-fetch the lot |
| `GET /competitions/:id/fixtures/:fixtureId/predictions` refuses until that fixture has locked, even though the UI only offers it on a finished one | The same rule the per-user routes already follow. The UI's choice of when to show a control is not an access rule, and the endpoint is reachable directly |
| Members who never predicted the match are returned, with a null prediction | In a twenty-person league who sat a match out is as much a part of the picture as who got it right. Filtering them out server-side would make "everyone" mean "everyone who played" |
| `LiveUserPredictionsPage` reuses `LiveFixtureList`, `LiveTablePrediction` and `LiveBonusQuestionsTab` rather than rendering its own read-only variants | They already had the states this page needs — a locked fixture card, a `viewUserId` bonus panel — so a parallel set would have been a second thing to keep in step with scoring changes |
| It composes the other member's answers over the competition's own view instead of new per-user read models | The three per-user endpoints already decide what a member may see. The teams, bands and scoring the page renders around those answers are the competition's, not the member's |
| The two season-long calls — the table and the bonus answers — are open to the league from the moment they are submitted; only per-fixture predictions wait for their own kickoff | Requested. Both close at the first kickoff and are what the league argues about before a season starts, so withholding them until then hid them for exactly the stretch anyone cared. Copying an order or an answer is the accepted cost, and it does not extend to match predictions, where a copied score is worth points every week |
| The header resolves the viewed member from the membership list, never falling through a null field to the auth store | A member with no picture of their own has a null `imageUrl`. `member?.imageUrl ?? user?.imageUrl` put the *viewer's* face beside someone else's name |
| `LiveTablePrediction` gained a `readOnly` prop rather than being handed a view with `isLocked: true` | Faking the lock would have made the card announce "closed — the first match has started" to somebody looking at their own still-open table |
| The fixtures tab of a member's page opens on the last **played** gameweek, where the competition page opens on the next unplayed one | The predictions for a week still to come are withheld, so opening there would show a blank page. What can be looked at is what has been played |

**Colour-coding the league table, and the predicted-team column** *(added after the six phases, on request)*

| Decision | Why |
|---|---|
| The standings table reuses the format's existing `bands`, rather than taking a cutoff prop | The Champions League's 1–8 / 9–24 / 25+ split was already declared on `LiveStageDef` for the table-prediction bonus. A second definition of the same three ranges would be one to keep in step |
| Bands are resolved from the stage of the rows themselves, not from whatever stage the fixtures tab happens to be on | The standings query is keyed on the fixtures tab's stage, which is a coincidence of the page rather than a fact about the table. Rows carry their own `stageKey` |
| The band comes from the row's index in the table, not the `position` the provider reports | Two teams sharing a reported position would both take the higher band and push the count of coloured rows past 8. The first eight rows are the first eight rows |
| `bandBarClasses` / `bandSwatchClasses` extracted to `client/src/lib/liveBands.ts`, and the legend to `LiveTableBandLegend` | The predicted table and the real one are read against each other, so green has to mean the same thing on both. They were already drawn by two separate copies of the same switch |
| Under `border-collapse`, the per-row bars merge into one continuous stripe per band | This is how a real football table reads, and it is the same `border-l-4` the predicted table already used — where the rows are separate cards, so they stay separate bars there |
| The predicted team's crest sits inside the team cell, beside the real crest, rather than in a column of its own | A column of its own lands at the far right of the flexible team column, a team name away from the crest it is meant to be compared against. Side by side, the comparison is the whole row |
| A row's two glows are about the team standing in it — where the viewer placed *that* team — and not about the badge beside it | The badge answers "who did I put here", the colour answers "how did I do on this team". Colouring by the badge instead reads as a verdict on a team two rows away, and leaves every team's own row silent about it |
| Those two glows are exactly the two things `calculateTablePoints` awards for that team | Green is an exact position and amber is the right band, measured the same way the scoring measures them, so a glowing row is a row currently earning points rather than a second, subtly different notion of "close" |
| Both are read against the live standings, not a final table | The user asked for it to hold all season. Nothing about the comparison needs the stage to be over — where a team is standing today is what today's colours should reflect |
| The column is dropped entirely for a per-group scope, and on any stage other than the one the order was predicted for | A predicted order is one list top to bottom. Against per-group tables, or against a different stage's standings, its indices line up with the wrong rows |

**Answers must be picked, never typed** *(added after the six phases, on request)*

| Decision | Why |
|---|---|
| The gate no longer passes `allowFreeText` to `PlayerSearchInput`; it is now admin-only, for setting a correct answer or building an option list | Answers are graded by comparing text. A typed name that differs from the picked one by a typo, an accent or a first initial scores nothing and reads as bad luck rather than a mistake. Picking is what keeps every answer to one question spelled the same way |
| Country, team, and a player question narrowed to an option list were already safe, and the server already enforced them | `checkLiveBonusAnswer` refuses anything outside `liveBonusOptions`, which resolves to the European countries, the tournament's teams, or the admin's list. Only a free-form player question has no set to check against |
| Which means a free-form player answer is enforced in the UI alone | There is no roster on our side to check a name against, and the suggestions come from a third-party database the browser queries directly. Validating server-side would mean putting that database in the save path, where an outage would start refusing valid answers |
| A typed-but-unpicked box now says so, and says separately when the database is unreachable | A disabled Next button is not an explanation. The two cases also differ in what to do about them — one is a spelling to fix, the other is a network to change — and they look identical on screen otherwise |
| Opening the suggestions scrolls the field to the middle of the screen | The list renders under the input, which on a phone is often already near the keyboard. This is what likely produced the typed answers in the first place: the suggestions were there, just not visible |
| A member behind a firewall that blocks the player database now cannot pass the gate on a free-form player question | Accepted, and requested. The way out is on the admin side, which already exists: narrowing the question to a list of allowed answers turns it into a `<select>` with no external dependency |

**Phase 7 — statistics**

| Change | Why |
|---|---|
| The scorer feed limit rose from 100 to 500, shared by the sync and the doctor probe as `SCORER_FEED_LIMIT` | The feed is *ranked*. 100 is ample for refreshing a ten-player shortlist — they are all near the top — but a UCL league phase has a few hundred distinct scorers, so a top-100 list omits exactly the one-goal tail that a nationality total is made of. It is one request either way |
| Live competitions render stat cards through their own `LiveUserStatCard`, not the manual type's `UserStatCard` | The live cards are tiles with the picture as the background and no emoji. Sharing the payload type (`UserStatCardData`) was worth it; sharing the layout was not |
| `UserStatSubject.type` gained `'player'` | It says how to picture a subject rather than what kind of thing it is: a crest is shown whole, a photograph is cropped to fill. A flag uses `'team'` for that reason |
| Whether `/scorers` carries `player.nationality`, and what its maximum `limit` is, are unverified | `api.football-data.org` is unreachable from a cloud session. The `scorers` probe reports both, so `npm run live:doctor` answers them locally in one run — and the "at least" wording means a clamped limit produces an honest card rather than a wrong one |

---

## 16. References

- [2026/27 Champions League: teams, dates, draws, format](https://www.uefa.com/uefachampionsleague/news/02a6-20d57cfcd03e-407c22a7f465-1000--2026-27-champions-league-teams-dates-draws-format-final/)
- [UEFA confirms date for the 2026/27 Champions League league phase draw](https://www.besoccer.com/new/uefa-confirms-date-for-the-202627-champions-league-league-phase-draw-1421299)
- [football-data.org coverage](https://www.football-data.org/coverage)
- [football-data.org API policies](https://docs.football-data.org/general/v4/policies.html)
