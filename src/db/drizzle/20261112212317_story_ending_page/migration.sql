ALTER TYPE "story_template_reason" ADD VALUE 'spoils_opening' BEFORE 'low_quality';--> statement-breakpoint
ALTER TABLE "story_turns" ADD COLUMN "free" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD COLUMN "ending" jsonb;--> statement-breakpoint
-- Players' pool stories written before stories had a hook and opening lines
-- can't fill the next-story card, so they leave the pool. Seeds are rewritten
-- with both right after the migrations (seedPool).
UPDATE "story_templates"
SET "status" = 'failed', "reason" = 'generation_failed', "content" = NULL
WHERE "status" = 'ready' AND "origin" <> 'seed' AND NOT ("content" ? 'openingLines');
