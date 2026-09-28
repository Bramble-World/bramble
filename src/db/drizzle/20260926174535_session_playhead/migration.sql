ALTER TABLE "storyline_sessions" ADD COLUMN "playhead_order" integer DEFAULT 0 NOT NULL;
-- Existing playthroughs restart at the first beat of their source conversation,
-- rather than keeping the whole timeline visible.
--
-- Chosen deliberately over preserving their position: the fix is only
-- observable on a session whose playhead is behind the end of the story, and
-- the storylines already played are the ones worth judging it on. The cost is
-- that a long session's next turn shows little history beside many turns of
-- playthrough — so judge the change on a fresh session, not a restarted one.
UPDATE storyline_sessions s
SET playhead_order = COALESCE(
  (SELECT MIN(e.narrative_order) FROM events e
    WHERE e.storyline_id = s.storyline_id AND e.origin = 'extracted'), 0);
