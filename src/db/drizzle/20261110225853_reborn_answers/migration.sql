CREATE TABLE "reborn_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"question" smallint NOT NULL,
	"role" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_reborn_answers_user_question" UNIQUE("user_id","question"),
	CONSTRAINT "chk_reborn_answers_question" CHECK ("question" BETWEEN 1 AND 3),
	CONSTRAINT "chk_reborn_answers_role" CHECK (("question" = 2 AND ("role" IS NULL OR "role" IN ('parent', 'ex', 'best_friend', 'teacher', 'boss', 'stranger'))) OR ("question" <> 2 AND "role" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "reborn_answers" ADD CONSTRAINT "reborn_answers_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;