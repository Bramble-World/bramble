ALTER TABLE "story_turns" ADD COLUMN "is_ending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storylines" ADD COLUMN "target_beats" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
DROP INDEX "idx_story_turns_one_open_per_session";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_story_turns_one_open_per_session" ON "story_turns" ("session_id") WHERE "selected_choice_id" IS NULL AND NOT "is_ending";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_story_turns_one_ending_per_session" ON "story_turns" ("session_id") WHERE "is_ending";