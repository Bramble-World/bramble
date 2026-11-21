CREATE TYPE "user_role" AS ENUM('player', 'admin');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'player'::"user_role" NOT NULL;