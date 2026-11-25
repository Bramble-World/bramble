import { handleError } from '@/lib/utils/api.handler-errors';

export type EventSender = { send: (event: string, data: unknown) => void };

/** Whether the client asked to have the response streamed as server-sent events. */
export function wantsEventStream(request: Request): boolean {
  return request.headers.get('accept')?.includes('text/event-stream') ?? false;
}

/**
 * A response streamed as server-sent events: whatever `work` sends while it
 * runs, then `done` with `finish`'s body, or `error` with the same body an
 * error response would have had, plus its `status`.
 *
 * Nothing is committed until the first event: a failure before then (out of
 * battery, not your session, a guest past the wall) is thrown, so the caller's
 * error handling answers it with its real status, exactly as without streaming.
 *
 * The client going away stops nothing: `work` runs to the end and saves what it
 * makes, as a plain request's does. Sends after that are dropped.
 */
export async function eventStream<T>(
  work: (stream: EventSender) => Promise<T>,
  finish: (result: T) => Promise<Record<string, unknown>>
): Promise<Response> {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  const send = (event: string, data: unknown) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      closed = true;
    }
  };
  const close = () => {
    if (closed || !controller) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Already gone with the client.
    }
  };

  let opened: () => void = () => {};
  const firstEvent = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const running = work({
    send: (event, data) => {
      send(event, data);
      opened();
    },
  });

  const first = await Promise.race([
    firstEvent.then(() => 'streaming' as const),
    running.then(
      () => 'done' as const,
      () => 'failed' as const
    ),
  ]);
  if (first === 'failed') {
    close();
    await running;
  }

  void running
    .then(async (result) => send('done', await finish(result)))
    .catch(async (error: unknown) => {
      const response = handleError(error);
      send('error', { status: response.status, ...(await response.json()) });
    })
    .finally(close);

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: compression would hold the events back until it had a
      // block's worth. X-Accel-Buffering: the ingress (nginx) likewise.
      'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
