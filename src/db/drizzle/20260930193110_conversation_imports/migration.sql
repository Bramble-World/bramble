CREATE TYPE "import_stage" AS ENUM('reading', 'writing', 'casting');--> statement-breakpoint
CREATE TYPE "import_status" AS ENUM('queued', 'running', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"conversation_key" text NOT NULL,
	"status" "import_status" DEFAULT 'queued'::"import_status" NOT NULL,
	"stage" "import_stage",
	"storyline_id" uuid,
	"failure_code" text,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_imports_user" ON "imports" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_imports_user_conversation" ON "imports" ("user_id","conversation_key");--> statement-breakpoint
CREATE INDEX "idx_imports_user_status" ON "imports" ("user_id","status");--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE SET NULL;