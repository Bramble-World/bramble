ALTER TYPE "story_template_origin" ADD VALUE 'duet';--> statement-breakpoint
CREATE TABLE "duets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"premise" text NOT NULL,
	"side_a_user_id" uuid,
	"side_b_user_id" uuid,
	"side_a_template_id" uuid,
	"side_b_template_id" uuid,
	"side_a_storyline_id" uuid,
	"side_b_storyline_id" uuid,
	"side_a_partner_character_id" uuid,
	"side_b_partner_character_id" uuid,
	"side_a_partner_index" integer NOT NULL,
	"side_b_partner_index" integer NOT NULL,
	"side_a_name" text NOT NULL,
	"side_b_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" text NOT NULL,
	"inviter_user_id" uuid NOT NULL,
	"inviter_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"duet_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_templates" ADD COLUMN "duet_id" uuid;--> statement-breakpoint
ALTER TABLE "storylines" ADD COLUMN "duet_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_duets_side_a" ON "duets" ("side_a_user_id");--> statement-breakpoint
CREATE INDEX "idx_duets_side_b" ON "duets" ("side_b_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_invites_code" ON "invites" ("code");--> statement-breakpoint
CREATE INDEX "idx_invites_inviter" ON "invites" ("inviter_user_id","created_at");--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_a_user_id_users_id_fkey" FOREIGN KEY ("side_a_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_b_user_id_users_id_fkey" FOREIGN KEY ("side_b_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_a_template_id_story_templates_id_fkey" FOREIGN KEY ("side_a_template_id") REFERENCES "story_templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_b_template_id_story_templates_id_fkey" FOREIGN KEY ("side_b_template_id") REFERENCES "story_templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_a_storyline_id_storylines_id_fkey" FOREIGN KEY ("side_a_storyline_id") REFERENCES "storylines"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_b_storyline_id_storylines_id_fkey" FOREIGN KEY ("side_b_storyline_id") REFERENCES "storylines"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_a_partner_character_id_characters_id_fkey" FOREIGN KEY ("side_a_partner_character_id") REFERENCES "characters"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "duets" ADD CONSTRAINT "duets_side_b_partner_character_id_characters_id_fkey" FOREIGN KEY ("side_b_partner_character_id") REFERENCES "characters"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_user_id_users_id_fkey" FOREIGN KEY ("inviter_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_user_id_users_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_duet_id_duets_id_fkey" FOREIGN KEY ("duet_id") REFERENCES "duets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "story_templates" ADD CONSTRAINT "story_templates_duet_id_duets_id_fkey" FOREIGN KEY ("duet_id") REFERENCES "duets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "storylines" ADD CONSTRAINT "storylines_duet_id_duets_id_fkey" FOREIGN KEY ("duet_id") REFERENCES "duets"("id") ON DELETE SET NULL;