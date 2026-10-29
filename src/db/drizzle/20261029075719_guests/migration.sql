ALTER TABLE "persons" ADD COLUMN "pronouns" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "guest_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "app_attest_key_id" text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "clerk_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_users_guest_expiry" ON "users" ("guest_expires_at") WHERE "is_guest";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_guest_attest_key" ON "users" ("app_attest_key_id") WHERE "is_guest" AND "deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "chk_persons_pronouns" CHECK ("pronouns" IN ('he', 'she', 'they'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_users_account_identity" CHECK ("is_guest" OR ("clerk_id" IS NOT NULL AND "email" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_users_guest_expiry" CHECK (NOT "is_guest" OR "guest_expires_at" IS NOT NULL);