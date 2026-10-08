import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { uuidParam } from '@/lib/api/params';
import { storylineDetailView } from '@/lib/api/views';
import * as storylines from '@/lib/services/storylines/storylines.service';
import * as persons from '@/lib/services/persons/persons.service';
import * as sessions from '@/lib/services/sessions/sessions.service';
import * as timelineReader from '@/lib/services/timeline/timeline.reader';

type Params = { params: Promise<{ storylineId: string }> };

/**
 * One storyline, as the arc-detail screen shows it (screen 12).
 *
 * The cast is cut to people the reader has met. That is not politeness: a
 * character description is written by extraction, which has read the whole
 * conversation, and one of them really did read "the investor who offers
 * $300,000" — putting the ending on the first screen a reader opens.
 *
 * `setting` carries the premise. `arcSummary` is never returned; it describes
 * the whole arc.
 */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const storylineId = uuidParam((await params).storylineId, 'storylineId');

  // Throws NotFoundError for a storyline that is not this user's — 404, never
  // 403, so "not yours" and "no such thing" are the same answer.
  const storyline = await storylines.getStoryline(user.id, storylineId);

  // listCharactersForUser proves ownership; everything after it is derived from
  // ids that came out of a userId-scoped query, never from the request.
  const [cast, session] = await Promise.all([
    storylines.listCharactersForUser(user.id, storylineId),
    sessions.currentSession(user.id, storylineId),
  ]);

  const met = await timelineReader.charactersMetUpTo(storylineId, session?.playheadOrder ?? 0);

  const metPeople = await Promise.all(
    cast
      .filter((character) => met.has(character.id))
      .map((character) => persons.getPerson(user.id, character.personId))
  );

  return json({ storyline: storylineDetailView(storyline, metPeople) });
});
