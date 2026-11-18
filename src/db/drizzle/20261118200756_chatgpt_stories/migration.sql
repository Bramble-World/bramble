ALTER TYPE "story_template_origin" ADD VALUE 'chatgpt';--> statement-breakpoint
ALTER TYPE "story_template_reason" ADD VALUE 'harms_real_person' BEFORE 'low_quality';--> statement-breakpoint
CREATE TABLE "chatgpt_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_templates" ADD COLUMN "source_context_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chatgpt_connected_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_story_templates_context" ON "story_templates" ("source_context_id");--> statement-breakpoint
ALTER TABLE "chatgpt_contexts" ADD CONSTRAINT "chatgpt_contexts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "story_templates" ADD CONSTRAINT "story_templates_source_context_id_chatgpt_contexts_id_fkey" FOREIGN KEY ("source_context_id") REFERENCES "chatgpt_contexts"("id") ON DELETE SET NULL;