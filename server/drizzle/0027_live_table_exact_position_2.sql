-- Live tournaments: an exactly-right table position is worth 2 points, not 1.
--
-- DEFAULT_LIVE_SCORING_CONFIG.table_exact_position changed 1 → 2, which only affects
-- competitions created afterwards; every existing row carries the old value in its
-- scoring_config JSON. This brings those forward.
--
-- Only rows still on the old default are touched. A competition whose admin deliberately
-- set some other value keeps it — this is a change of default, not of everyone's rules.
--
-- Stored table points are NOT rewritten here: they are awarded once, at the end of a
-- season, and any already scored are corrected by "Recalculate scores" on the tournament.
-- No live season has been scored yet, so there is nothing to correct.
--
-- Hand-written: see docs/LIVE_TOURNAMENTS_PLAN.md on why db:generate is unsafe here.

UPDATE "live_competitions"
SET scoring_config = (scoring_config::jsonb || '{"table_exact_position": 2}'::jsonb)::json
WHERE (scoring_config->>'table_exact_position') IS NULL
   OR (scoring_config->>'table_exact_position')::int = 1;
