import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

/** "Report this story", and the team's review of it, against a real database. */
vi.mock('@/lib/services/auth/auth.service', () => ({ requireCurrentUser: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const { db } = await import('@/index');
const { storyReports, storyTemplates, users } = await import('@/db/schema/tables');
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const Sentry = vi.mocked(await import('@sentry/nextjs'));
const { SEED_STORIES } = await import('@/lib/pool/seeds');
const { seedPool } = await import('@/lib/pool/seed-pool');
const { instantiateTemplate } = await import('@/lib/services/pool/next.service');
const { createFakeGenerator } = await import('@/lib/ai');
const { registerFixtures } = await import('@/lib/ai/fixtures');
const { generateTurn } = await import('@/lib/services/generation/turns.service');
const reports = await import('@/lib/services/reports/reports.service');
const route = await import('@/app/api/v1/sessions/[sessionId]/report/route');

const IDS = ['user_report_reader', 'user_report_second', 'user_report_author'];
const CONTENT = SEED_STORIES['summer-shift'];

let reader: string;
let second: string;
let author: string;
let templateId: string;
let readerSession: string;
let readerTurn: string;
let secondSession: string;

function post(sessionId: string, payload: unknown) {
  auth.requireCurrentUser.mockResolvedValue({ id: currentUser, isGuest: false } as never);
  return route.POST(
    new Request(`http://test/api/v1/sessions/${sessionId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ sessionId }) }
  );
}

let currentUser = '';
const as = (id: string) => (currentUser = id);
const reportsOf = (userId: string) =>
  db.select().from(storyReports).where(eq(storyReports.userId, userId));
const template = async () =>
  (await db.select().from(storyTemplates).where(eq(storyTemplates.id, templateId)))[0];

beforeAll(async () => {
  await db.delete(users).where(inArray(users.clerkId, IDS));
  [{ id: reader }, { id: second }, { id: author }] = await db
    .insert(users)
    .values(IDS.map((clerkId) => ({ clerkId, email: `${clerkId}@test.local` })))
    .returning({ id: users.id });

  [{ id: templateId }] = await db
    .insert(storyTemplates)
    .values({ origin: 'reborn', userId: author, status: 'ready', content: CONTENT })
    .returning({ id: storyTemplates.id });

  readerSession = await db.transaction((tx) =>
    instantiateTemplate(tx, reader, templateId, CONTENT)
  );
  secondSession = await db.transaction((tx) =>
    instantiateTemplate(tx, second, templateId, CONTENT)
  );
  const fake = createFakeGenerator();
  registerFixtures(fake);
  readerTurn = (await generateTurn(reader, readerSession, { generator: fake })).id;
});

beforeEach(async () => {
  await db.delete(storyReports).where(inArray(storyReports.userId, [reader, second]));
  await db
    .update(storyTemplates)
    .set({ status: 'ready', reason: null })
    .where(eq(storyTemplates.id, templateId));
  Sentry.captureMessage.mockReset();
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.clerkId, IDS));
});

describe('POST /api/v1/sessions/{id}/report', () => {
  it('files a report on the beat, alerts the team, and leaves the story in the pool', async () => {
    as(reader);
    const response = await post(readerSession, { reason: 'harmful', turnId: readerTurn });

    expect(response.status).toBe(200);
    const [row, ...rest] = await reportsOf(reader);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ reason: 'harmful', turnId: readerTurn, status: 'open' });
    expect((await template()).status).toBe('ready');

    // One Sentry issue per report, carrying codes and ids only.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'A player reported a story',
      expect.objectContaining({
        fingerprint: ['story-report', row.id],
        tags: { flow: 'story_report', reason: 'harmful', origin: 'reborn' },
        extra: { reportId: row.id },
      })
    );
  });

  it('keeps one report per story, with the latest reason', async () => {
    as(reader);
    await post(readerSession, { reason: 'harmful', turnId: readerTurn });
    await post(readerSession, { reason: 'real_person' });

    const rows = await reportsOf(reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'real_person', turnId: null });
  });

  it("refuses someone else's session, a beat from another session, and an unknown reason", async () => {
    as(second);
    expect((await post(readerSession, { reason: 'harmful' })).status).toBe(404);
    expect((await post(secondSession, { reason: 'harmful', turnId: readerTurn })).status).toBe(404);
    expect((await post(secondSession, { reason: 'boring' })).status).toBe(400);
    expect(await reportsOf(reader)).toEqual([]);
  });
});

describe('reviewing reports', () => {
  it('lists open reports with how many are on the same pool story', async () => {
    as(reader);
    await post(readerSession, { reason: 'harmful' });
    as(second);
    await post(secondSession, { reason: 'hateful' });

    const open = (await reports.listOpenReports()).filter((r) => r.templateId === templateId);
    expect(open).toHaveLength(2);
    expect(open.every((r) => r.reportsOnTemplate === 2 && r.origin === 'reborn')).toBe(true);
  });

  it('shows the story as the reporter saw it, marking the reported beat', async () => {
    as(reader);
    await post(readerSession, { reason: 'harmful', turnId: readerTurn });
    const [row] = await reportsOf(reader);

    const story = await reports.readReportedStory(row.id);
    expect(story.title).toBe(CONTENT.title);
    expect(story.beats.filter((b) => b.reported)).toHaveLength(1);
  });

  it('keep closes the report and the story stays', async () => {
    as(reader);
    await post(readerSession, { reason: 'other' });
    const [row] = await reportsOf(reader);

    await reports.keepReportedStory(row.id);
    expect((await reportsOf(reader))[0]).toMatchObject({ status: 'kept' });
    expect((await template()).status).toBe('ready');
    await expect(reports.keepReportedStory(row.id)).rejects.toThrow();

    // Reporting it again reopens it.
    await post(readerSession, { reason: 'harmful' });
    expect((await reportsOf(reader))[0]).toMatchObject({ status: 'open', reviewedAt: null });
  });

  it('pull takes the template out of the pool and closes every report on it', async () => {
    as(reader);
    await post(readerSession, { reason: 'harmful' });
    as(second);
    await post(secondSession, { reason: 'hateful' });
    const [row] = await reportsOf(reader);

    expect(await reports.pullReportedStory(row.id)).toBe(2);
    expect(await template()).toMatchObject({ status: 'rejected', reason: 'reported' });
    expect((await reportsOf(second))[0].status).toBe('pulled');

    // Restore puts it back.
    await reports.restorePulledTemplate(templateId);
    expect(await template()).toMatchObject({ status: 'ready', reason: null });
  });

  it('a pulled seed stays pulled when the seeds are written again on deploy', async () => {
    await seedPool(db);
    const [{ id: seedId }] = await db
      .select({ id: storyTemplates.id })
      .from(storyTemplates)
      .where(eq(storyTemplates.slug, 'summer-shift'));

    await db
      .update(storyTemplates)
      .set({ status: 'rejected', reason: 'reported' })
      .where(eq(storyTemplates.id, seedId));
    await seedPool(db);
    const [after] = await db.select().from(storyTemplates).where(eq(storyTemplates.id, seedId));
    expect(after).toMatchObject({ status: 'rejected', reason: 'reported' });

    await reports.restorePulledTemplate(seedId);
    await seedPool(db);
    const [restored] = await db.select().from(storyTemplates).where(eq(storyTemplates.id, seedId));
    expect(restored.status).toBe('ready');
  });
});
