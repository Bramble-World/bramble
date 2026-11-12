CREATE TYPE "story_template_origin" AS ENUM('seed', 'reborn', 'reddit');--> statement-breakpoint
CREATE TYPE "story_template_reason" AS ENUM('too_thin', 'not_a_story', 'unclear', 'identifier', 'minors', 'abuse', 'self_harm', 'quotes_answer', 'low_quality', 'moderation', 'generation_failed');--> statement-breakpoint
CREATE TYPE "story_template_status" AS ENUM('pending', 'generating', 'ready', 'declined', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "story_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"origin" "story_template_origin" NOT NULL,
	"user_id" uuid,
	"source_answer_id" uuid,
	"slug" text UNIQUE,
	"status" "story_template_status" DEFAULT 'pending'::"story_template_status" NOT NULL,
	"reason" "story_template_reason",
	"quality_score" smallint,
	"content" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD COLUMN "next_template_id" uuid;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD COLUMN "next_session_id" uuid;--> statement-breakpoint
ALTER TABLE "storylines" ADD COLUMN "template_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_story_templates_user" ON "story_templates" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_story_templates_answer" ON "story_templates" ("source_answer_id");--> statement-breakpoint
CREATE INDEX "idx_story_templates_claimable" ON "story_templates" ("created_at") WHERE "status" IN ('pending', 'generating');--> statement-breakpoint
CREATE INDEX "idx_story_templates_ready" ON "story_templates" ("origin") WHERE "status" = 'ready';--> statement-breakpoint
CREATE INDEX "idx_storylines_template" ON "storylines" ("user_id","template_id");--> statement-breakpoint
ALTER TABLE "story_templates" ADD CONSTRAINT "story_templates_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "story_templates" ADD CONSTRAINT "story_templates_source_answer_id_reborn_answers_id_fkey" FOREIGN KEY ("source_answer_id") REFERENCES "reborn_answers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD CONSTRAINT "storyline_sessions_next_template_id_story_templates_id_fkey" FOREIGN KEY ("next_template_id") REFERENCES "story_templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD CONSTRAINT "storyline_sessions_next_session_id_storyline_sessions_id_fkey" FOREIGN KEY ("next_session_id") REFERENCES "storyline_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "storylines" ADD CONSTRAINT "storylines_template_id_story_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "story_templates"("id") ON DELETE SET NULL;