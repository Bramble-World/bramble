CREATE TYPE "story_report_reason" AS ENUM('harmful', 'sexual', 'hateful', 'self_harm', 'real_person', 'other');--> statement-breakpoint
CREATE TYPE "story_report_status" AS ENUM('open', 'kept', 'pulled');--> statement-breakpoint
ALTER TYPE "story_template_reason" ADD VALUE 'reported';--> statement-breakpoint
CREATE TABLE "story_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"turn_id" uuid,
	"reason" "story_report_reason" NOT NULL,
	"status" "story_report_status" DEFAULT 'open'::"story_report_status" NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_story_reports_one_per_story" ON "story_reports" ("user_id","storyline_id");--> statement-breakpoint
CREATE INDEX "idx_story_reports_open" ON "story_reports" ("status","created_at");--> statement-breakpoint
ALTER TABLE "story_reports" ADD CONSTRAINT "story_reports_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "story_reports" ADD CONSTRAINT "story_reports_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "story_reports" ADD CONSTRAINT "story_reports_turn_id_story_turns_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "story_turns"("id") ON DELETE SET NULL;