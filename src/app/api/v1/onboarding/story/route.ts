import { z } from 'zod';
import { withGuest } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { personView, turnView } from '@/lib/api/views';
import { PRONOUNS, RELATIONSHIPS } from '@/lib/onboarding/openings';
import { createGuestStory } from '@/lib/services/onboarding/onboarding.service';

/** The naming screen's own limit. A first name or a nickname, not a sentence. */
const MAX_NAME_CHARACTERS = 24;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const bodySchema = z.object({
  openingId: z.string().min(1).max(64),
  relationship: z.enum(RELATIONSHIPS),
  name: z
    .string()
    .trim()
    .min(1, 'Required')
    // Counted as the iPhone counts characters — grapheme clusters, so "Zoë" or
    // a name with an emoji is the length a person sees, not its UTF-16 units.
    .refine(
      (name) => [...graphemes.segment(name)].length <= MAX_NAME_CHARACTERS,
      `At most ${MAX_NAME_CHARACTERS} characters`
    )
    // No control characters, newlines above all: the name is written into the
    // prompt line by line, and a line break inside it would be a line of its own.
    .refine((name) => !/\p{Cc}/u.test(name), 'Letters, not control characters'),
  pronouns: z.enum(PRONOUNS).optional(),
});

/**
 * Writes the guest's story from the naming screen, and returns beat 1.
 *
 * No model call: beat 1 is the opening's script with the name and pronouns in
 * it. **201** when the story is written; **200** with the story that already
 * exists when the guest has one — one story per guest, and a retried request is
 * answered rather than refused. `pronouns` may be omitted, and the story then
 * says "they".
 *
 * The name and pronouns are stored with the story and sent to the model to write
 * beats 2 and 3. Nothing on this path logs them, and analytics never carries them.
 */
export const POST = withGuest(async (user, request) => {
  const body = await parseBody(request, bodySchema);

  const { story, created } = await createGuestStory(
    user.id,
    body.openingId,
    { name: body.name, relationship: body.relationship, pronouns: body.pronouns ?? 'they' },
    { pronounsGiven: body.pronouns !== undefined }
  );

  return json(
    {
      story: {
        sessionId: story.sessionId,
        storylineId: story.storylineId,
        storylineTitle: story.storylineTitle,
        person: personView({ ...story.person, voiceProfile: null }),
        turn: story.turn ? turnView(story.turn) : null,
      },
    },
    { status: created ? 201 : 200 }
  );
});
