import { z } from 'zod';
import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody, uuidParam } from '@/lib/api/params';
import { reportStory, STORY_REPORT_REASONS } from '@/lib/services/reports/reports.service';

type Params = { params: Promise<{ sessionId: string }> };

const bodySchema = z.object({
  /** A code. There is no free-text field: a player who wants to say more emails us. */
  reason: z.enum(STORY_REPORT_REASONS),
  /** The beat on screen, when there was one. */
  turnId: z.string().uuid().optional(),
});

/**
 * "Report this story": the reader telling the team a story shouldn't be in Bramble.
 *
 * It changes nothing about the story by itself. The team is alerted and reviews
 * it (`src/scripts/review-reports.ts`). Guests can report too — their first
 * beats are AI-written as well — and a report moves with them when they sign up.
 *
 * Free, and safe to repeat: one report per reader per story, the latest reason
 * kept.
 */
export const POST = withUser(async (user, request, { params }: Params) => {
  const sessionId = uuidParam((await params).sessionId, 'sessionId');
  const body = await parseBody(request, bodySchema);

  const report = await reportStory(user.id, sessionId, body);

  return json({ report: { id: report.id, reason: report.reason } });
});
