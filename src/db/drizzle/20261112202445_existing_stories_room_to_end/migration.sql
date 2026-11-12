-- Stories already in progress when endings shipped get room to build to one.
--
-- A story's length counts its playthrough's own beats, so a playthrough already
-- past the cap would otherwise get its ending on its very next beat. Each
-- storyline played so far gets a budget of at least its longest playthrough + 8:
-- four more beats before it may close, then the closing window. New storylines
-- keep the default of 20, and so does any storyline nobody has played.
UPDATE "storylines" AS s
SET "target_beats" = GREATEST(s."target_beats", played.longest + 8)
FROM (
  SELECT ss."storyline_id", max(turns.beats) AS longest
  FROM "storyline_sessions" ss
  JOIN (
    SELECT "session_id", count(*)::int AS beats
    FROM "story_turns"
    GROUP BY "session_id"
  ) turns ON turns."session_id" = ss."id"
  GROUP BY ss."storyline_id"
) AS played
WHERE played."storyline_id" = s."id";
