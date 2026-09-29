import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { uuidParam } from '@/lib/api/params';
import { personDetailView } from '@/lib/api/views';
import * as persons from '@/lib/services/persons/persons.service';

type Params = { params: Promise<{ personId: string }> };

/**
 * One person and the arcs they are in — screens 10 and 11 from one request.
 *
 * Screen 11 is a list of arcs against a person; it is served from this payload
 * rather than its own endpoint, because a person with four arcs carries four
 * short rows and a second round trip would buy nothing but a spinner.
 *
 * Only recorded facts travel: name, relationship type, arcs. No hook line and no
 * bio — the only way to fill those would be to have a model write a sentence
 * about a real person the reader knows, from a conversation it has read all of.
 *
 * Note for the client: until several conversations are imported, every person in
 * a thread yields the same single arc with the same title. That is the data
 * being sparse, not a bug — collapse screen 11 into screen 10 when `arcs` has
 * one entry.
 */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const personId = uuidParam((await params).personId, 'personId');

  // Throws NotFoundError for someone else's person — 404, never 403.
  const detail = await persons.personDetail(user.id, personId);

  return json({ person: personDetailView(detail) });
});
