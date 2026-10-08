/**
 * The success response for every `/api/v1` route.
 *
 * `no-store` is the default rather than an opt-in because everything this API
 * returns is one user's private story. A cache header is the kind of thing that
 * is correct until an intermediary is introduced, at which point the failure is
 * one user seeing another's world — so it is set once here rather than
 * remembered per handler.
 *
 * Bodies are always objects, never bare arrays. An array is a shape you cannot
 * add a field to, and the client on the other end of this is a shipped macOS
 * app that cannot be rolled back: `{ nodes: [...] }` can grow a `truncated` flag
 * later, `[...]` can only be replaced.
 */
export function json(body: Record<string, unknown>, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: { 'Cache-Control': 'private, no-store', ...init?.headers },
  });
}
