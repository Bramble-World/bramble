CREATE TABLE "duet_crossings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"duet_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"from_side" text NOT NULL,
	"to_storyline_id" uuid,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"delivered_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_duet_crossings_side" CHECK ("from_side" IN ('a', 'b')),
	CONSTRAINT "chk_duet_crossings_status" CHECK ("status" IN ('queued', 'delivered', 'dropped'))
);
--> statement-breakpoint
CREATE INDEX "idx_duet_crossings_to" ON "duet_crossings" ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "idx_duet_crossings_storyline" ON "duet_crossings" ("to_storyline_id","status");--> statement-breakpoint
ALTER TABLE "duet_crossings" ADD CONSTRAINT "duet_crossings_duet_id_duets_id_fkey" FOREIGN KEY ("duet_id") REFERENCES "duets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "duet_crossings" ADD CONSTRAINT "duet_crossings_to_user_id_users_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "duet_crossings" ADD CONSTRAINT "duet_crossings_to_storyline_id_storylines_id_fkey" FOREIGN KEY ("to_storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "duet_crossings" ADD CONSTRAINT "duet_crossings_delivered_turn_id_story_turns_id_fkey" FOREIGN KEY ("delivered_turn_id") REFERENCES "story_turns"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "push_sends" DROP CONSTRAINT "chk_push_sends_kind", ADD CONSTRAINT "chk_push_sends_kind" CHECK ("kind" IN ('battery_back', 'story_waiting', 'reply_arrived', 'duet_moved'));