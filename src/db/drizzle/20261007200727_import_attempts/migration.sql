ALTER TABLE "imports" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_imports_claimable" ON "imports" ("status","next_attempt_at","created_at");