-- Live tournaments: a snapshot of the scorer feed, aggregated by nationality.
--
-- Feeds the "Norwegian goals" statistics card, which counts every goal scored by players
-- of one country rather than only the ones an admin shortlisted. The numbers come from
-- the same /competitions/{id}/scorers request the shortlist refresh already makes, so
-- this costs no extra provider call — only somewhere to keep the answer.
--
-- A single jsonb column rather than a table: it is a small map, written whole on every
-- refresh and read whole by the card, which is the same reasoning that keeps
-- live_table_predictions.ordered_team_ids in one column. It is deliberately not stored on
-- live_players either — that table is the admin's curated shortlist, and the whole point
-- of the search-and-add flow is that it does not fill up with hundreds of rows nobody
-- will ever rank.
--
-- Shape:
--   {
--     "fetchedAt": "2026-09-02T10:00:00.000Z",
--     "count": 412,          -- rows the feed returned
--     "truncated": false,    -- it came back at the limit, so every total is a floor
--     "byNationality": { "Norway": { "goals": 23, "players": 7 } }
--   }
--
-- Keys are the provider's own English country names, kept verbatim. Null until the first
-- refresh runs, which is why the card treats a missing snapshot as "nothing to say".
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.
-- Mirrored with IF NOT EXISTS in server/src/live/ensureSchema.ts — keep the two in sync.

ALTER TABLE "live_tournaments"
  ADD COLUMN IF NOT EXISTS "scorer_nationalities" jsonb;
