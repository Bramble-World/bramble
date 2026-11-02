import { AsyncLocalStorage } from 'node:async_hooks';
import { CLIENT_HEADER, parseClientHeader } from '@/lib/api/client-version';

/**
 * Which client this request came from, for the code far below the route.
 *
 * iPhone events go to their own PostHog project, and `track` is called from
 * services that never see a request. Threading a platform through every one of
 * them would be a change to each caller, and the one that forgot would quietly
 * put an iPhone player's event in the Mac's project.
 *
 * Nothing in a worker or a sweep runs inside this, and neither serves the
 * iPhone directly, so outside a request the answer is "not iOS".
 */
const storage = new AsyncLocalStorage<string | null>();

export function withRequestClient<T>(request: Request, run: () => T): T {
  const client = parseClientHeader(request.headers.get(CLIENT_HEADER));
  return storage.run(client?.platform ?? null, run);
}

export function isIosRequest(): boolean {
  return storage.getStore() === 'ios';
}
