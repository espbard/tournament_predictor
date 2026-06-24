-- Fix stale scoring_config defaults left by the d3d073a change that lowered
-- correct_group_position 2→1 and correct_winner 10→7 in DEFAULT_SCORING_CONFIG
-- but did not migrate existing competition rows or already-awarded points.

-- 1. Correct already-awarded group position points (were doubled: 2 pts/position → 1 pt/position)
UPDATE competition_members
SET correct_group_position_points = correct_group_position_points / 2
FROM competitions
WHERE competition_members.competition_id = competitions.id
  AND (competitions.scoring_config->>'correct_group_position')::int = 2;

-- 2. Reset winner points so they are recalculated with the new additive logic
--    (old: winner replaced finalist points at 10 pts; new: additive 7+5=12 pts)
UPDATE competition_members
SET correct_winner_points = 0
FROM competitions
WHERE competition_members.competition_id = competitions.id
  AND (competitions.scoring_config->>'correct_winner')::int = 10;

-- 3. Fix the scoring_config values
UPDATE competitions
SET scoring_config = (scoring_config::jsonb || '{"correct_group_position": 1}'::jsonb)::json
WHERE (scoring_config->>'correct_group_position')::int = 2;

UPDATE competitions
SET scoring_config = (scoring_config::jsonb || '{"correct_winner": 7}'::jsonb)::json
WHERE (scoring_config->>'correct_winner')::int = 10;
