CREATE TABLE "turn_surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"turn_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_turns" ADD COLUMN "headline" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_turn_surfaces_turn_position" ON "turn_surfaces" ("turn_id","position");--> statement-breakpoint
ALTER TABLE "turn_surfaces" ADD CONSTRAINT "turn_surfaces_turn_id_story_turns_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "story_turns"("id") ON DELETE CASCADE;