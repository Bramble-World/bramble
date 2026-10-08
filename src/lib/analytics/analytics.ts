import { PostHog } from 'posthog-node';
import { env } from '@/env';
import * as userReader from '@/lib/services/users/users.reader';
import type { AnalyticsEvent } from './events';

/**
 * Server-side product events.
 *
 * These exist because they are **complete**: an ad blocker or a corporate
 * firewall can stop the Mac app's events, and nothing can stop these. They also
 * fire at the moment the thing happens rather than when a client gets around to
 * reporting it.
 *
 * They are not the source of truth for money or limits. Cost and energy tuning
 * are answered with SQL against our own tables — see `docs/metrics.md` — because
 * those questions need to be exact and PostHog is a sampled, best-effort
 * pipeline we do not own.
 *
 * **`distinctId` is always `users.id`, lowercased**, which is exactly what the
 * Mac app identifies with. If the two ever disagree, one person becomes two
 * PostHog people and every funnel silently splits in half.
 */
export interface Analytics {
  /** False when nothing is configured, so callers can skip work before a read. */
  readonly enabled: boolean;
  capture(userId: string, event: AnalyticsEvent): Promise<void>;
}

/**
 * The sink when PostHog is not configured, which is local development, every
 * test run and CI.
 *
 * Chosen by the absence of a token rather than by a flag someone has to
 * remember, so there is no configuration in which tests send real events.
 */
export class NoopAnalytics implements Analytics {
  readonly enabled = false;
  async capture(): Promise<void> {}
}

export class PostHogAnalytics implements Analytics {
  readonly enabled = true;
  constructor(private readonly client: PostHog) {}

  async capture(userId: string, event: AnalyticsEvent): Promise<void> {
    await this.client.captureImmediate({
      // Lowercased to match the Mac exactly. Postgres returns uuids lowercase
      // already; doing it here means a future caller passing a value from
      // somewhere else cannot split a person in two.
      distinctId: userId.toLowerCase(),
      event: event.name,
      properties: event.properties,
      // Off everywhere. An IP-derived location is personal data this product has
      // no use for, and the events are about what happened, not where.
      disableGeoip: true,
    });
  }
}

let client: PostHog | null = null;
let analytics: Analytics | null = null;

/**
 * The sink this process uses.
 *
 * `flushAt: 1` alongside `captureImmediate` because the two places that send
 * events are a serverless route handler and a worker process, both of which
 * can exit before a batched queue is drained. A dropped batch is an event that
 * never happened as far as any chart is concerned, and it fails silently.
 */
export function getAnalytics(): Analytics {
  if (analytics) return analytics;

  const token = env.POSTHOG_PROJECT_TOKEN;
  if (!token) return (analytics = new NoopAnalytics());

  client = new PostHog(token, {
    host: env.POSTHOG_HOST,
    flushAt: 1,
  });

  return (analytics = new PostHogAnalytics(client));
}

/** Test seam: drops the memoised sink so a fake can replace it. */
export function resetAnalytics(): void {
  analytics = null;
  client = null;
}

/**
 * Sends an event, and never lets doing so break anything.
 *
 * Analytics must not fail a request or a job. A reader who played a turn played
 * it whether or not PostHog heard about it, and a worker that finished an import
 * finished it. Every call site uses this rather than the interface directly, so
 * "never throws" is a property of the module rather than a rule each caller has
 * to remember.
 *
 * The failure is logged structurally — the event name and the reason, never the
 * properties, since a thrown error can carry whatever was being sent.
 */
export async function track(userId: string, event: AnalyticsEvent): Promise<void> {
  try {
    const sink = getAnalytics();
    // Checked before the consent read, so a deployment with no PostHog — local
    // development, every test, CI — does no extra query per event.
    if (!sink.enabled) return;

    // The opt-out, honoured here rather than at each call site, so it cannot be
    // forgotten by whoever adds the next event. A reader who has turned this off
    // produces no events at all, not quieter ones.
    if (!(await userReader.sharesUsage(userId))) return;

    await sink.capture(userId, event);
  } catch (error) {
    console.error('analytics capture failed', {
      event: event.name,
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}
