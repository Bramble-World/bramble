import { z } from 'zod';
import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseOptionalBody, uuidParam } from '@/lib/api/params';
import { sessionResponse } from '@/lib/api/session-response';
import { NEXT_STORY_HOW, startNextStory } from '@/lib/services/pool/next.service';

type Params = { params: Promise<{ sessionId: string }> };

const bodySchema = z.object({
  /** How the reader went on, for analytics only. */
  how: z.enum(NEXT_STORY_HOW).optional(),
});

/**
 * Starts the story offered after an ended one — the "next episode".
 *
 * Free: it copies the offered pool story into the reader's world and opens a
 * playthrough on it, with no model call. The first beat is the usual
 * `POST .../turn` on the returned session. Safe to retry: asking again for the
 * same ended session returns the same new session.
 *
 * 409 if the story has not ended; 404 when the pool has nothing for this reader.
 */
export const POST = withUser(async (user, request, { params }: Params) => {
  const sessionId = uuidParam((await params).sessionId, 'sessionId');
  const { how = 'begin_now' } = await parseOptionalBody(request, bodySchema);

  const started = await startNextStory(user.id, sessionId, { how });

  return json({ session: await sessionResponse(user.id, started.sessionId) }, { status: 201 });
});
