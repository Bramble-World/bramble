ALTER TABLE "characters" ADD COLUMN "want" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "avoids" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "actor_character_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_events_actor" ON "events" ("actor_character_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_character_id_characters_id_fkey" FOREIGN KEY ("actor_character_id") REFERENCES "characters"("id") ON DELETE SET NULL;
-- Not backfilled, and there is nothing to backfill from.
--
-- A want is the model's reading of a whole conversation, and the raw messages
-- are deliberately never persisted (invariants.md §1), so no source survives
-- for a storyline already extracted. Guessing one from the beats now would be a
-- decision the model never made, permanently indistinguishable from one it did.
--
-- actor_character_id is the same: who caused a past beat was never recorded,
-- and inferring it from a title is a guess dressed as data — the very thing
-- this column exists to replace.
--
-- Both are therefore observable only on newly extracted storylines. Existing
-- ones keep exactly their current behaviour.
