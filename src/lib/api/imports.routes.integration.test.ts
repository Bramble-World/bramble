import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { like } from 'drizzle-orm';

/**
 * The import endpoints over their real handlers.
 *
 * `tasks.trigger` is stubbed because there is no queue in a test run and the
 * route's contract is that it enqueues *something* carrying only an id — which
 * is asserted here rather than taken on trust, since a payload is a store too
 * and a transcript in one would outlive the ciphertext's thirty minutes.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});
vi.mock('@/lib/services/auth/auth.service', () => ({ requireCurrentUser: vi.fn() }));
vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: vi.fn().mockResolvedValue({ id: 'run_1' }) },
}));

const { db } = await import('@/index');
const { users } = await import('@/db/schema/tables');
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const { tasks } = vi.mocked(await import('@trigger.dev/sdk'));
const importsRoute = await import('@/app/api/v1/imports/route');
const importRoute = await import('@/app/api/v1/imports/[importId]/route');
const { IMPORT_LIMIT } = await import('@/lib/services/imports/imports.types');

const OWNER = 'user_import_routes_owner';
const STRANGER = 'user_import_routes_stranger';
const NEEDLE = 'pomegranate seventeen umbrella';

let ownerId: string;
let strangerId: string;

const get = (path: string) => new Request(`http://api.test${path}`);
const post = (path: string, body: unknown) =>
  new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });
const asOwner = () => auth.requireCurrentUser.mockResolvedValue({ id: ownerId } as never);
const asStranger = () => auth.requireCurrentUser.mockResolvedValue({ id: strangerId } as never);

const body = (key: string, count = 60) => ({
  conversationKey: key,
  transcript: {
    surface: 'imessage',
    messages: Array.from({ length: count }, (_, i) => ({
      isFromMe: i % 2 === 0,
      handle: i % 2 === 0 ? 'me' : 'c_9b1e04a7d2f3c611',
      sender: i % 2 === 0 ? 'me' : 'Maya',
      text: i === 3 ? NEEDLE : `message number ${i}`,
      sentAt: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(),
    })),
  },
});

async function seed(clerkId: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ clerkId, email: `${clerkId}@routes.local` })
    .returning({ id: users.id });
  return user.id;
}

const wipe = async () => {
  for (const clerkId of [OWNER, STRANGER]) {
    await db.delete(users).where(like(users.clerkId, `${clerkId}%`));
  }
};

beforeAll(wipe);
afterAll(wipe);

beforeEach(async () => {
  vi.clearAllMocks();
  tasks.trigger.mockResolvedValue({ id: 'run_1' } as never);
  await wipe();
  ownerId = await seed(OWNER);
  strangerId = await seed(STRANGER);
});

describe('POST /api/v1/imports', () => {
  it('accepts a conversation with 202 and queues exactly one job', async () => {
    asOwner();

    const response = await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined);
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json.import).toMatchObject({
      conversationKey: 'conv_a',
      status: 'queued',
      stage: null,
      storylineId: null,
      failure: null,
    });
    expect(tasks.trigger).toHaveBeenCalledTimes(1);
  });

  /**
   * The payload is the contract's sharpest privacy line. A queue stores its
   * payloads, shows them in a dashboard and writes them to run logs — a
   * transcript in there would outlive by a long way the thirty minutes the
   * ciphertext in Redis gets.
   */
  it('puts nothing but an id on the queue', async () => {
    asOwner();
    await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined);

    const [, payload] = tasks.trigger.mock.calls[0];

    expect(Object.keys(payload as object)).toStrictEqual(['importId']);
    expect(JSON.stringify(payload)).not.toContain(NEEDLE);
    expect(JSON.stringify(payload)).not.toContain('Maya');
  });

  // A re-send is the normal path, not an exceptional one: the Mac holds the
  // durable copy and sends again whenever it is unsure.
  it('answers 200 and starts nothing for a conversation already sent', async () => {
    asOwner();
    await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined);

    const again = await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined);

    expect(again.status).toBe(200);
    expect(tasks.trigger).toHaveBeenCalledTimes(1);
  });

  it('answers 409 once the allowance is spent', async () => {
    asOwner();
    for (let i = 0; i < IMPORT_LIMIT; i++) {
      await importsRoute.POST(post('/api/v1/imports', body(`conv_${i}`)), undefined);
    }

    const response = await importsRoute.POST(post('/api/v1/imports', body('conv_x')), undefined);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('IMPORT_LIMIT_REACHED');
  });

  it('answers 413 for a transcript past the ceiling', async () => {
    asOwner();
    const big = body('conv_a');
    big.transcript.messages[0].text = 'x'.repeat(400_001);

    const response = await importsRoute.POST(post('/api/v1/imports', big), undefined);

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('TRANSCRIPT_TOO_LARGE');
  });

  it('answers 400 for a conversation too short to extract', async () => {
    asOwner();

    const response = await importsRoute.POST(
      post('/api/v1/imports', body('conv_a', 10)),
      undefined
    );

    expect(response.status).toBe(400);
  });

  /**
   * The privacy boundary is an allow-list. A real handle arriving here would be
   * hashed and written to `persons.source_contact_ref` exactly as a legitimate
   * one would — valid-looking, and a breach.
   */
  it.each([
    ['a phone number', '+15550109999'],
    ['an email', 'maya@example.com'],
    ['an unprefixed hash', '9b1e04a7d2f3c611'],
  ])('answers 400 for %s in place of a pseudonym', async (_label, handle) => {
    asOwner();
    const leaky = body('conv_a');
    leaky.transcript.messages[1].handle = handle;

    const response = await importsRoute.POST(post('/api/v1/imports', leaky), undefined);

    expect(response.status).toBe(400);
    expect(tasks.trigger).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/imports', () => {
  it('reports the allowance and every import', async () => {
    asOwner();
    await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined);

    const json = await (await importsRoute.GET(get('/api/v1/imports'), undefined)).json();

    expect(json).toMatchObject({ limit: IMPORT_LIMIT, used: 0 });
    expect(json.imports).toHaveLength(1);
  });

  it('never shows one reader another reader imports', async () => {
    asOwner();
    await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined);

    asStranger();
    const json = await (await importsRoute.GET(get('/api/v1/imports'), undefined)).json();

    expect(json.imports).toStrictEqual([]);
    expect(json.used).toBe(0);
  });
});

describe('GET /api/v1/imports/:importId', () => {
  it('reports where one import has got to', async () => {
    asOwner();
    const created = await (
      await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined)
    ).json();

    const response = await importRoute.GET(
      get(`/api/v1/imports/${created.import.id}`),
      ctx({ importId: created.import.id })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).import.id).toBe(created.import.id);
  });

  it("answers 404 for another reader's import", async () => {
    asOwner();
    const created = await (
      await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined)
    ).json();

    asStranger();
    const response = await importRoute.GET(
      get(`/api/v1/imports/${created.import.id}`),
      ctx({ importId: created.import.id })
    );

    expect(response.status).toBe(404);
  });

  it('answers 400 for an id that is not a uuid', async () => {
    asOwner();

    const response = await importRoute.GET(
      get('/api/v1/imports/not-a-uuid'),
      ctx({ importId: 'not-a-uuid' })
    );

    expect(response.status).toBe(400);
  });

  // The whole response surface, checked for content it must never carry.
  it('never returns message text in any import response', async () => {
    asOwner();
    await importsRoute.POST(post('/api/v1/imports', body('conv_a')), undefined);

    const listed = await (await importsRoute.GET(get('/api/v1/imports'), undefined)).text();

    expect(listed).not.toContain(NEEDLE);
    expect(listed).not.toContain('Maya');
  });
});
