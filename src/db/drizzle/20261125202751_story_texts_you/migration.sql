ALTER TABLE "story_turns" ADD COLUMN "reply_later" text;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD COLUMN "reply_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD COLUMN "reply_due_kind" text;--> statement-breakpoint
CREATE INDEX "idx_storyline_sessions_reply_due" ON "storyline_sessions" ("reply_due_at") WHERE "reply_due_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "story_turns" ADD CONSTRAINT "chk_story_turns_reply_later" CHECK ("reply_later" IS NULL OR "reply_later" IN ('soon', 'tonight', 'tomorrow'));--> statement-breakpoint
ALTER TABLE "push_sends" DROP CONSTRAINT "chk_push_sends_kind", ADD CONSTRAINT "chk_push_sends_kind" CHECK ("kind" IN ('battery_back', 'story_waiting', 'reply_arrived'));