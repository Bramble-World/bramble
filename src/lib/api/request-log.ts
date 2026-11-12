import { CLIENT_HEADER, parseClientHeader } from './client-version';

/**
 * One log line per API request: what was asked, what came back, and how long
 * it took. Production had no request logs at all, so a failure the code
 * doesn't log itself (a 4xx, a slow turn) was invisible from the server.
 *
 * **Structure only**, as every log here is (invariants.md §1): the method, the
 * route with its ids replaced (`/api/v1/sessions/:id/turn`), the status, the
 * error code when there is one, the duration, the client's platform and build,
 * and a request id the response carries back as `X-Request-Id`. Never a body,
 * a query string, a header value beyond the client's build, or who asked.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `/api/v1/sessions/1f…/turn` → `/api/v1/sessions/:id/turn`; `/answers/2` → `/answers/:n`. */
export function routeOf(url: string): string {
  const path = new URL(url).pathname;
  return path
    .replace(UUID, ':id')
    .split('/')
    .map((part) => (/^\d+$/.test(part) ? ':n' : part))
    .join('/');
}

export type RequestLogLine = {
  event: 'request';
  requestId: string;
  method: string;
  route: string;
  status: number;
  /** The `error.code` of an error response, e.g. `RATE_LIMITED`. */
  code?: string;
  ms: number;
  /** `ios/1.2 (16)`, from `X-Bramble-Client`, when it says. */
  client?: string;
};

type Log = (line: RequestLogLine) => void;
const writeLine: Log = (line) => console.log(JSON.stringify(line));

/**
 * Wraps a route handler so its request is logged, whatever it returns or
 * throws. A thrown error is logged as a 500 and thrown on, for the handler's
 * own error handling (and Next's) to deal with as before.
 */
export function withRequestLog<Args extends [Request, ...unknown[]]>(
  handler: (...args: Args) => Promise<Response>,
  log: Log = writeLine
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const [request] = args;
    const started = performance.now();
    // A caller's id is kept only when it's a short plain token, so nothing
    // arbitrary can be written into the logs through it.
    const sent = request.headers.get('x-request-id');
    const requestId = sent && /^[\w-]{1,64}$/.test(sent) ? sent : crypto.randomUUID().slice(0, 8);
    const client = parseClientHeader(request.headers.get(CLIENT_HEADER));
    const line = (status: number, code?: string): RequestLogLine => ({
      event: 'request',
      requestId,
      method: request.method,
      route: routeOf(request.url),
      status,
      ...(code ? { code } : {}),
      ms: Math.round(performance.now() - started),
      ...(client ? { client: `${client.platform}/${client.version} (${client.build})` } : {}),
    });

    let response: Response;
    try {
      response = await handler(...args);
    } catch (error) {
      log(line(500, 'UNHANDLED'));
      throw error;
    }

    // The error code is the one part of an error body worth having: a fixed
    // vocabulary (`RATE_LIMITED`, `GENERATION_TIMEOUT`), never the message.
    let code: string | undefined;
    if (response.status >= 400) {
      code = await response
        .clone()
        .json()
        .then((body: { error?: { code?: unknown } }) =>
          typeof body?.error?.code === 'string' ? body.error.code : undefined
        )
        .catch(() => undefined);
    }
    log(line(response.status, code));

    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
