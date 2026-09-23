CREATE TYPE "character_role" AS ENUM('protagonist', 'antagonist', 'supporting');--> statement-breakpoint
CREATE TYPE "context_source" AS ENUM('inferred', 'conversation_generated', 'user_provided');--> statement-breakpoint
CREATE TYPE "event_origin" AS ENUM('extracted', 'conversation_generated');--> statement-breakpoint
CREATE TYPE "storyline_link_type" AS ENUM('sequel', 'parallel', 'crossover', 'spinoff');--> statement-breakpoint
CREATE TYPE "storyline_status" AS ENUM('pending', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "character_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"storyline_id" uuid NOT NULL,
	"character_a_id" uuid NOT NULL,
	"character_b_id" uuid NOT NULL,
	"baseline_dynamic" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_character_relationships_order" CHECK ("character_a_id" < "character_b_id")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"storyline_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "character_role" DEFAULT 'supporting'::"character_role" NOT NULL,
	"description" text,
	"voice_profile_override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"storyline_id" uuid NOT NULL,
	"character_id" uuid,
	"content" text NOT NULL,
	"source" "context_source" DEFAULT 'inferred'::"context_source" NOT NULL,
	"triggered_by_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_participants" (
	"event_id" uuid,
	"character_id" uuid,
	CONSTRAINT "event_participants_pkey" PRIMARY KEY("event_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"storyline_id" uuid NOT NULL,
	"narrative_order" integer NOT NULL,
	"occurred_at" timestamp with time zone,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"stakes" text,
	"origin" "event_origin" DEFAULT 'extracted'::"event_origin" NOT NULL,
	"triggered_by_turn_id" uuid,
	"generation_rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motif_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"motif_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motif_participants" (
	"motif_id" uuid,
	"person_id" uuid,
	CONSTRAINT "motif_participants_pkey" PRIMARY KEY("motif_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "motifs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"person_a_id" uuid NOT NULL,
	"person_b_id" uuid NOT NULL,
	"relationship_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_person_relationships_order" CHECK ("person_a_id" < "person_b_id")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_contact_ref" text,
	"is_self" boolean DEFAULT false NOT NULL,
	"voice_profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"relationship_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"dynamic" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"session_id" uuid NOT NULL,
	"turn_order" integer NOT NULL,
	"narrative_content" text NOT NULL,
	"selected_choice_id" uuid,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storyline_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"storyline_a_id" uuid NOT NULL,
	"storyline_b_id" uuid NOT NULL,
	"link_type" "storyline_link_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storyline_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"storyline_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storylines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_surface" text NOT NULL,
	"setting" text,
	"tone" text,
	"status" "storyline_status" DEFAULT 'pending'::"storyline_status" NOT NULL,
	"failure_reason" text,
	"arc_summary" text,
	"arc_summary_generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_choices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"turn_id" uuid NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"order_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_character_relationships_storyline" ON "character_relationships" ("storyline_id");--> statement-breakpoint
CREATE INDEX "idx_character_relationships_a" ON "character_relationships" ("character_a_id");--> statement-breakpoint
CREATE INDEX "idx_character_relationships_b" ON "character_relationships" ("character_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_character_relationships_pair" ON "character_relationships" ("storyline_id","character_a_id","character_b_id");--> statement-breakpoint
CREATE INDEX "idx_characters_storyline" ON "characters" ("storyline_id");--> statement-breakpoint
CREATE INDEX "idx_characters_person" ON "characters" ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_characters_storyline_person" ON "characters" ("storyline_id","person_id");--> statement-breakpoint
CREATE INDEX "idx_context_entries_storyline" ON "context_entries" ("storyline_id");--> statement-breakpoint
CREATE INDEX "idx_context_entries_character" ON "context_entries" ("character_id");--> statement-breakpoint
CREATE INDEX "idx_context_entries_triggered_by" ON "context_entries" ("triggered_by_turn_id");--> statement-breakpoint
CREATE INDEX "idx_event_participants_character" ON "event_participants" ("character_id");--> statement-breakpoint
CREATE INDEX "idx_events_storyline" ON "events" ("storyline_id");--> statement-breakpoint
CREATE INDEX "idx_events_storyline_order" ON "events" ("storyline_id","narrative_order");--> statement-breakpoint
CREATE INDEX "idx_events_triggered_by" ON "events" ("triggered_by_turn_id");--> statement-breakpoint
CREATE INDEX "idx_motif_occurrences_motif" ON "motif_occurrences" ("motif_id");--> statement-breakpoint
CREATE INDEX "idx_motif_occurrences_storyline" ON "motif_occurrences" ("storyline_id");--> statement-breakpoint
CREATE INDEX "idx_motif_participants_person" ON "motif_participants" ("person_id");--> statement-breakpoint
CREATE INDEX "idx_motifs_user" ON "motifs" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_person_relationships_a" ON "person_relationships" ("person_a_id");--> statement-breakpoint
CREATE INDEX "idx_person_relationships_b" ON "person_relationships" ("person_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_person_relationships_pair" ON "person_relationships" ("person_a_id","person_b_id");--> statement-breakpoint
CREATE INDEX "idx_persons_user" ON "persons" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_persons_user_contact" ON "persons" ("user_id","source_contact_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_persons_one_self_per_user" ON "persons" ("user_id") WHERE "is_self" = true;--> statement-breakpoint
CREATE INDEX "idx_relationship_states_relationship" ON "relationship_states" ("relationship_id");--> statement-breakpoint
CREATE INDEX "idx_relationship_states_event" ON "relationship_states" ("event_id");--> statement-breakpoint
CREATE INDEX "idx_story_turns_session" ON "story_turns" ("session_id");--> statement-breakpoint
CREATE INDEX "idx_story_turns_session_order" ON "story_turns" ("session_id","turn_order");--> statement-breakpoint
CREATE INDEX "idx_story_turns_selected_choice" ON "story_turns" ("selected_choice_id");--> statement-breakpoint
CREATE INDEX "idx_storyline_links_a" ON "storyline_links" ("storyline_a_id");--> statement-breakpoint
CREATE INDEX "idx_storyline_links_b" ON "storyline_links" ("storyline_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_storyline_links_unique" ON "storyline_links" ("storyline_a_id","storyline_b_id","link_type");--> statement-breakpoint
CREATE INDEX "idx_storyline_sessions_storyline" ON "storyline_sessions" ("storyline_id");--> statement-breakpoint
CREATE INDEX "idx_storyline_sessions_user" ON "storyline_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_storyline_sessions_last_active" ON "storyline_sessions" ("last_active_at");--> statement-breakpoint
CREATE INDEX "idx_storylines_user" ON "storylines" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_turn_choices_turn" ON "turn_choices" ("turn_id");--> statement-breakpoint
ALTER TABLE "character_relationships" ADD CONSTRAINT "character_relationships_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "character_relationships" ADD CONSTRAINT "character_relationships_character_a_id_characters_id_fkey" FOREIGN KEY ("character_a_id") REFERENCES "characters"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "character_relationships" ADD CONSTRAINT "character_relationships_character_b_id_characters_id_fkey" FOREIGN KEY ("character_b_id") REFERENCES "characters"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_person_id_persons_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_character_id_characters_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_triggered_by_turn_id_story_turns_id_fkey" FOREIGN KEY ("triggered_by_turn_id") REFERENCES "story_turns"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_character_id_characters_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_triggered_by_turn_id_story_turns_id_fkey" FOREIGN KEY ("triggered_by_turn_id") REFERENCES "story_turns"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "motif_occurrences" ADD CONSTRAINT "motif_occurrences_motif_id_motifs_id_fkey" FOREIGN KEY ("motif_id") REFERENCES "motifs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "motif_occurrences" ADD CONSTRAINT "motif_occurrences_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "motif_occurrences" ADD CONSTRAINT "motif_occurrences_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "motif_participants" ADD CONSTRAINT "motif_participants_motif_id_motifs_id_fkey" FOREIGN KEY ("motif_id") REFERENCES "motifs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "motif_participants" ADD CONSTRAINT "motif_participants_person_id_persons_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "motifs" ADD CONSTRAINT "motifs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_person_a_id_persons_id_fkey" FOREIGN KEY ("person_a_id") REFERENCES "persons"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_person_b_id_persons_id_fkey" FOREIGN KEY ("person_b_id") REFERENCES "persons"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relationship_states" ADD CONSTRAINT "relationship_states_qaXyfKiBe2T2_fkey" FOREIGN KEY ("relationship_id") REFERENCES "character_relationships"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relationship_states" ADD CONSTRAINT "relationship_states_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "story_turns" ADD CONSTRAINT "story_turns_session_id_storyline_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "storyline_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "story_turns" ADD CONSTRAINT "story_turns_selected_choice_id_turn_choices_id_fkey" FOREIGN KEY ("selected_choice_id") REFERENCES "turn_choices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "storyline_links" ADD CONSTRAINT "storyline_links_storyline_a_id_storylines_id_fkey" FOREIGN KEY ("storyline_a_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "storyline_links" ADD CONSTRAINT "storyline_links_storyline_b_id_storylines_id_fkey" FOREIGN KEY ("storyline_b_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD CONSTRAINT "storyline_sessions_storyline_id_storylines_id_fkey" FOREIGN KEY ("storyline_id") REFERENCES "storylines"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "storyline_sessions" ADD CONSTRAINT "storyline_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "storylines" ADD CONSTRAINT "storylines_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "turn_choices" ADD CONSTRAINT "turn_choices_turn_id_story_turns_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "story_turns"("id") ON DELETE CASCADE;