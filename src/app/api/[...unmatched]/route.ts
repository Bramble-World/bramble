import { json } from '@/lib/api/respond';
import { unmatchedRouteOf, withRequestLog } from '@/lib/api/request-log';

/**
 * Any `/api/…` request no route matches: a 404 in the API's own error shape,
 * logged like every other request. Without it, Next answered with its HTML
 * not-found page and nothing was logged, so an app calling a route the server
 * doesn't have yet (a deploy still rolling out, an old build) was invisible
 * (2026-11-26). Every real route is more specific than this one, so it only
 * ever sees what nothing else took.
 */
async function notFound(): Promise<Response> {
  return json({ error: { code: 'NOT_FOUND', message: 'No such route' } }, { status: 404 });
}

const handler = withRequestLog(notFound, undefined, unmatchedRouteOf);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
