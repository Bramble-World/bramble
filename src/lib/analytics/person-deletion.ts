import { env } from '@/env';
import { AppError } from '@/lib/utils/errors';

/**
 * Deletes a person from PostHog, with every event they sent.
 *
 * Its own module rather than a method on `Analytics`, because it is a different
 * API with a different credential: capturing uses the public project token on
 * the ingestion host, and deleting uses a personal API key on the app host. The
 * capture side must never hold a key that can delete.
 *
 * Addressed by distinct id, which is `users.id` lowercased — the same id every
 * capture used, so a person whose events came from the Mac, the iPhone and the
 * server is one person here. They may be in either project, or both, so both are
 * asked.
 */

export class AnalyticsDeletionError extends AppError {
  constructor(message: string) {
    super(message, 'ANALYTICS_DELETION_FAILED', 502);
  }
}

export async function deleteAnalyticsPerson(userId: string): Promise<void> {
  // No project token means no events were ever sent from this deployment, so
  // there is nobody to delete. Local development, tests and CI.
  if (!env.POSTHOG_PROJECT_TOKEN) return;

  // A second project's token with no id would mean events nobody can delete,
  // so that fails closed as well.
  const iosConfigured = !env.POSTHOG_IOS_PROJECT_TOKEN || env.POSTHOG_IOS_PROJECT_ID;
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID || !iosConfigured) {
    throw new AnalyticsDeletionError('PostHog person deletion is not configured.');
  }

  const projects = [env.POSTHOG_PROJECT_ID, env.POSTHOG_IOS_PROJECT_ID].filter(Boolean);
  for (const project of projects) {
    const res = await fetch(
      `${env.POSTHOG_API_HOST}/api/environments/${project}/persons/bulk_delete/`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ distinct_ids: [userId.toLowerCase()], delete_events: true }),
      }
    );
    // A person who never shared usage data was never created; PostHog answers
    // that with success and nothing deleted, which is what we want.
    if (!res.ok) {
      throw new AnalyticsDeletionError(`PostHog refused the deletion (${res.status}).`);
    }
  }
}
