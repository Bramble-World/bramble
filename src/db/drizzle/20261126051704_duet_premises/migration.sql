CREATE TABLE "duet_premises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"content" jsonb NOT NULL,
	"quality_score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_duet_premises_slug" ON "duet_premises" ("slug");