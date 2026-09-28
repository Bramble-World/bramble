ALTER TABLE "story_turns" ADD COLUMN "consequences_generated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_story_turns_owed_consequences" ON "story_turns" ("session_id") WHERE "selected_choice_id" IS NOT NULL AND "consequences_generated_at" IS NULL;
-- Turns that demonstrably produced something are marked resolved, using the
-- lineage already on the rows they wrote.
--
-- Answered turns with no trace are deliberately LEFT NULL. They are genuinely
-- ambiguous — the whole defect is that "consequences ran and changed nothing"
-- and "consequences never ran" were stored identically — and inventing a stamp
-- for them would permanently retire any that really did fail part-way. Leaving
-- them null keeps today's behaviour for those rows and nothing worse: they stay
-- retryable. Every turn answered from here on is unambiguous.
UPDATE story_turns t
SET consequences_generated_at = COALESCE(
  (SELECT MIN(e.created_at) FROM events e WHERE e.triggered_by_turn_id = t.id),
  (SELECT MIN(c.created_at) FROM context_entries c WHERE c.triggered_by_turn_id = t.id))
WHERE t.selected_choice_id IS NOT NULL
  AND (EXISTS (SELECT 1 FROM events e WHERE e.triggered_by_turn_id = t.id)
    OR EXISTS (SELECT 1 FROM context_entries c WHERE c.triggered_by_turn_id = t.id));
