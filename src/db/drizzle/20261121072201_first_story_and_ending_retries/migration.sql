ALTER TABLE "storyline_sessions" ADD COLUMN "ending_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD COLUMN "ending_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storylines" ADD COLUMN "opening_id" text;--> statement-breakpoint
CREATE INDEX "idx_storyline_sessions_ending_owed" ON "storyline_sessions" ("ended_at") WHERE "ended_at" IS NOT NULL AND "ending" IS NULL;--> statement-breakpoint
-- The first stories already written are marked as what they are, so they end
-- on beat 10 like every new one. Every first story was written by
-- `createGuestStory` from the one opening there has ever been (`are_you_up`),
-- and every one of its setups (the opening's own and each premise's) ends on a
-- scripted beat titled "Two texts at 1:47 AM". No pool, ChatGPT or imported
-- story has that beat: pool copies carry a template id, and imports are written
-- by extraction, which titles its own beats.
--
-- A first story already past beat 10 ends on its next beat, which the turn
-- prompt writes as a real ending following on from the last choice.
UPDATE "storylines" AS s
SET "opening_id" = 'are_you_up', "target_beats" = 10
WHERE s."template_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "events" e
    WHERE e."storyline_id" = s."id"
      AND e."origin" = 'extracted'
      AND e."title" = 'Two texts at 1:47 AM'
  );
