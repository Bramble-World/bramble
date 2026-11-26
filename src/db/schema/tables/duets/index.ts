import { index, integer, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { storylines } from '../storylines';
import { storyTemplates } from '../storyTemplates';
import { characters } from '../characters';

/**
 * A story for two: one duet premise, played from two sides by two players who
 * found each other through an invite (`invites`).
 *
 * Each side is that player's own story, in their own rows (invariants.md §3):
 * a `duet` template written for them, then, once they start it, a storyline
 * copied from it, as any next story is. This row only links the two, so the
 * choices that matter on one side can reach the other (PR 3), and records
 * which character on each side is the other player.
 *
 * Everything is `set null`: a player who deletes their account takes their
 * side with them, and the other side carries on with their character renamed
 * (`forgetDuetPartner`).
 */
export const duets = pgTable(
  'duets',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** The premise's slug (`DUET_PREMISES`), so a pair is never given the same one twice. */
    premise: text().notNull(),

    /** The inviter, who plays side A, and the invitee, side B. */
    sideAUserId: uuid('side_a_user_id').references(() => users.id, { onDelete: 'set null' }),
    sideBUserId: uuid('side_b_user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Each side's template, written for its player when the invite was accepted. */
    sideATemplateId: uuid('side_a_template_id').references((): AnyPgColumn => storyTemplates.id, {
      onDelete: 'set null',
    }),
    sideBTemplateId: uuid('side_b_template_id').references((): AnyPgColumn => storyTemplates.id, {
      onDelete: 'set null',
    }),

    /** Each side's storyline, once its player has started it. */
    sideAStorylineId: uuid('side_a_storyline_id').references((): AnyPgColumn => storylines.id, {
      onDelete: 'set null',
    }),
    sideBStorylineId: uuid('side_b_storyline_id').references((): AnyPgColumn => storylines.id, {
      onDelete: 'set null',
    }),

    /** On each side, the character who is the other player. */
    sideAPartnerCharacterId: uuid('side_a_partner_character_id').references(
      (): AnyPgColumn => characters.id,
      { onDelete: 'set null' }
    ),
    sideBPartnerCharacterId: uuid('side_b_partner_character_id').references(
      (): AnyPgColumn => characters.id,
      { onDelete: 'set null' }
    ),

    /** Where the other player sits in each side's cast, to find their character once it's copied. */
    sideAPartnerIndex: integer('side_a_partner_index').notNull(),
    sideBPartnerIndex: integer('side_b_partner_index').notNull(),

    /** The first name each player gave, as the other side knows them. */
    sideAName: text('side_a_name').notNull(),
    sideBName: text('side_b_name').notNull(),

    ...timestamps,
  },
  (table) => [
    index('idx_duets_side_a').on(table.sideAUserId),
    index('idx_duets_side_b').on(table.sideBUserId),
  ]
);
