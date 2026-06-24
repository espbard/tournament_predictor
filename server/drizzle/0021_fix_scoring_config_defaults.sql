-- Fix stale scoring_config defaults left by the d3d073a change that lowered
-- correct_group_position 2→1 and correct_winner 10→7 in DEFAULT_SCORING_CONFIG
-- but did not migrate existing competition rows.

UPDATE competitions
SET scoring_config = (scoring_config::jsonb || '{"correct_group_position": 1}'::jsonb)::json
WHERE (scoring_config->>'correct_group_position')::int = 2;

UPDATE competitions
SET scoring_config = (scoring_config::jsonb || '{"correct_winner": 7}'::jsonb)::json
WHERE (scoring_config->>'correct_winner')::int = 10;
