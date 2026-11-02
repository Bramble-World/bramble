CREATE TABLE "push_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"anchor_turn_id" uuid NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_push_sends_kind" CHECK ("kind" IN ('battery_back', 'story_waiting'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "push_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_sends_once" ON "push_sends" ("anchor_turn_id","kind","ordinal");--> statement-breakpoint
CREATE INDEX "idx_push_sends_user" ON "push_sends" ("user_id","sent_at");--> statement-breakpoint
ALTER TABLE "push_sends" ADD CONSTRAINT "push_sends_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "push_sends" ADD CONSTRAINT "push_sends_anchor_turn_id_story_turns_id_fkey" FOREIGN KEY ("anchor_turn_id") REFERENCES "story_turns"("id") ON DELETE CASCADE;