/**
 * What went wrong, as fixed fields only: the provider's HTTP status, its error
 * type and code (`server_error`, `invalid_request_error`, `rate_limit_exceeded`),
 * the error's class name, and whether the caller had already given up. Never a
 * message or a body: those can echo the prompt, which carries the story.
 *
 * Looks through the SDK's wrappers (a `RetryError`'s last error, a `cause`) to
 * the provider's own failure.
 */
export function failureFields(error: unknown): {
  name?: string;
  status?: number;
  type?: string;
  code?: string;
} {
  const seen = new Set<unknown>();
  let current: unknown = error;
  const fields: { name?: string; status?: number; type?: string; code?: string } = {};
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      data?: { error?: { type?: unknown; code?: unknown } };
      lastError?: unknown;
      cause?: unknown;
    };
    if (fields.name === undefined && typeof e.name === 'string') fields.name = e.name;
    const status = typeof e.statusCode === 'number' ? e.statusCode : e.status;
    if (fields.status === undefined && typeof status === 'number') fields.status = status;
    const type = e.data?.error?.type;
    const code = e.data?.error?.code;
    if (fields.type === undefined && typeof type === 'string') fields.type = type.slice(0, 64);
    if (fields.code === undefined && typeof code === 'string') fields.code = code.slice(0, 64);
    current = e.lastError ?? e.cause;
  }
  return fields;
}
