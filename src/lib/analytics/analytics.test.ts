import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_PROPERTY_KEYS, type AnalyticsEvent } from './events';
import { PostHogAnalytics } from './analytics';

/**
 * What may leave this process, and under what conditions.
 *
 * The allowlist test mirrors the Mac's `AnalyticsTests`: both ends send events
 * about one person to one PostHog project, so both ends need the same answer to
 * "what is a property allowed to be". invariants.md §1 says message content
 * never reaches a long-term store, and an analytics pipeline is a long-term
 * store owned by somebody else.
 */
const sharesUsage = vi.fn();
vi.mock('@/lib/services/users/users.reader', () => ({ sharesUsage: () => sharesUsage() }));

/** Every event, with realistic values, so the allowlist is checked against all of them. */
const EVERY_EVENT: AnalyticsEvent[] = [
  {
    name: 'beat_played',
    properties: {
      turn_order: 7,
      surfaces: ['imessage_notifications'],
      beyond_script: false,
      started_from_event: true,
      generation_ms: 4312,
    },
  },
  {
    name: 'import_completed',
    properties: { status: 'ready', duration_ms: 91_204, message_count: 812 },
  },
  {
    name: 'import_completed',
    properties: { status: 'failed', failure_code: 'GENERATION_UNUSABLE', duration_ms: 4_002 },
  },
  { name: 'energy_depleted', properties: { limit: 20, retry_after_s: 3041 } },
];

describe('what a property may be', () => {
  it.each(EVERY_EVENT.map((e) => [e.name, e] as const))(
    '%s carries only allowlisted keys',
    (_name, event) => {
      for (const key of Object.keys(event.properties)) {
        expect(ALLOWED_PROPERTY_KEYS).toContain(key);
      }
    }
  );

  /**
   * The allowlist is maintained by hand so it is a second, independent statement
   * of what may ship. Derived from the types it checks, it would agree with them
   * by construction and prove nothing — including about a property added later.
   */
  it('has no entry that reads like free text', () => {
    for (const key of ALLOWED_PROPERTY_KEYS) {
      expect(key).not.toMatch(/name|title|text|email|content|narrative|headline|handle|body/i);
    }
  });

  // Ids, counts, durations and enums — never a sentence somebody wrote.
  it('sends no value that could be prose', () => {
    for (const event of EVERY_EVENT) {
      for (const value of Object.values(event.properties)) {
        const strings = Array.isArray(value) ? value : [value];
        for (const item of strings) {
          if (typeof item !== 'string') continue;
          // Enum members and codes: no spaces, nothing sentence-shaped.
          expect(item).toMatch(/^[a-z0-9_]+$/i);
        }
      }
    }
  });
});

describe('the sink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sharesUsage.mockResolvedValue(true);
  });

  it('is the no-op when no token is configured', async () => {
    vi.doMock('@/env', () => ({ env: { POSTHOG_PROJECT_TOKEN: undefined } }));
    // Imported from the same freshly-loaded module: `vi.resetModules` means the
    // class object here and the one at the top of this file are not the same
    // identity, so an `instanceof` across the two always fails.
    const mod = await import('./analytics');

    const sink = mod.getAnalytics();

    expect(sink).toBeInstanceOf(mod.NoopAnalytics);
    expect(sink.enabled).toBe(false);
  });

  it('is PostHog once a token is configured', async () => {
    vi.doMock('@/env', () => ({
      env: { POSTHOG_PROJECT_TOKEN: 'phc_test', POSTHOG_HOST: 'https://eu.posthog.com' },
    }));
    const mod = await import('./analytics');

    expect(mod.getAnalytics()).toBeInstanceOf(mod.PostHogAnalytics);
    expect(mod.getAnalytics().enabled).toBe(true);
  });

  /**
   * GeoIP off. An IP-derived location is personal data this product has no use
   * for, and the events are about what happened rather than where.
   */
  it('turns geoip off on every capture, and identifies by the lowercased user id', async () => {
    const captureImmediate = vi.fn().mockResolvedValue(undefined);
    const sink = new PostHogAnalytics({ captureImmediate } as never);

    await sink.capture('AB12CD34-0000-4000-8000-00000000FFFF', EVERY_EVENT[0]);

    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: 'ab12cd34-0000-4000-8000-00000000ffff',
      event: 'beat_played',
      properties: EVERY_EVENT[0].properties,
      disableGeoip: true,
    });
  });
});

describe('track', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sharesUsage.mockResolvedValue(true);
  });

  /**
   * Loads the module with a token and a fake PostHog, so `track` runs its real
   * path — enabled check, consent read, capture. Spying on the exported
   * `getAnalytics` would not work: `track` calls the module-local binding, which
   * an ESM spy does not intercept.
   */
  async function withToken() {
    const captureImmediate = vi.fn().mockResolvedValue(undefined);
    vi.doMock('posthog-node', () => ({
      PostHog: class {
        captureImmediate = captureImmediate;
      },
    }));
    vi.doMock('@/env', () => ({ env: { POSTHOG_PROJECT_TOKEN: 'phc_test' } }));
    const mod = await import('./analytics');
    return { ...mod, capture: captureImmediate };
  }

  it('sends nothing for a reader who opted out', async () => {
    const { track, capture } = await withToken();
    sharesUsage.mockResolvedValue(false);

    await track('user-1', EVERY_EVENT[0]);

    expect(capture).not.toHaveBeenCalled();
  });

  it('sends for a reader who has not', async () => {
    const { track, capture } = await withToken();

    await track('user-1', EVERY_EVENT[0]);

    expect(capture).toHaveBeenCalledOnce();
  });

  /**
   * Analytics must never fail a request or a job. A reader who played a turn
   * played it whether or not PostHog heard about it.
   */
  it('swallows a sink that throws', async () => {
    const { track } = await withToken();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sharesUsage.mockRejectedValue(new Error('database is on fire'));

    await expect(track('user-1', EVERY_EVENT[0])).resolves.toBeUndefined();
  });

  it('logs a failure without the properties it was sending', async () => {
    const { track } = await withToken();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    sharesUsage.mockRejectedValue(new Error('database is on fire'));

    await track('user-1', EVERY_EVENT[1]);

    const [, detail] = logged.mock.calls[0];
    expect(JSON.stringify(detail)).not.toContain('812');
    expect(detail).toStrictEqual({ event: 'import_completed', reason: 'Error' });
  });

  // No token means no consent read either — local dev and CI do no extra query.
  it('does not even ask about consent when nothing is configured', async () => {
    vi.doMock('@/env', () => ({ env: { POSTHOG_PROJECT_TOKEN: undefined } }));
    const { track } = await import('./analytics');

    await track('user-1', EVERY_EVENT[0]);

    expect(sharesUsage).not.toHaveBeenCalled();
  });
});
