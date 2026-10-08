ALTER TABLE "story_turns" ADD COLUMN "consequence_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "story_turns" ADD COLUMN "consequences_abandoned_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "idx_story_turns_owed_consequences";--> statement-breakpoint
CREATE INDEX "idx_story_turns_owed_consequences" ON "story_turns" ("session_id") WHERE "selected_choice_id" IS NOT NULL AND "consequences_generated_at" IS NULL AND "consequences_abandoned_at" IS NULL;