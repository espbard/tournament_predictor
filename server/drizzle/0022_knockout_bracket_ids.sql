-- Add bracket_index (0-based position within a knockout round) and next_match_id
-- (FK to the match the winner of this match advances into) to the matches table.
-- These replace the fragile date-ordering approach for determining bracket structure.
ALTER TABLE matches ADD COLUMN bracket_index integer;
ALTER TABLE matches ADD COLUMN next_match_id text REFERENCES matches(id) ON DELETE SET NULL;
