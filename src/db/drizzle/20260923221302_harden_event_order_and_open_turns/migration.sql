DROP INDEX "idx_events_storyline_order";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_events_storyline_order" ON "events" ("storyline_id","narrative_order");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_story_turns_one_open_per_session" ON "story_turns" ("session_id") WHERE "selected_choice_id" IS NULL;