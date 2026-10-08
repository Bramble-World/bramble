import { z } from 'zod';
import { ValidationError } from '@/lib/utils/errors';

const uuid = z.string().uuid();

/**
 * Reads a uuid out of a route parameter.
 *
 * Exists because the alternative is not "a slightly worse error" — it is a 500.
 * A malformed id passed straight to a scoped reader reaches Postgres, which
 * rejects the cast, and drizzle wraps that in a generic "Failed query" that
 * `handleError` has no choice but to report as an internal error. The request was
 * bad, the server was fine, and the client is told the opposite.
 *
 * The name is carried into `fields` so a client can point at the offending
 * parameter rather than re-deriving which one it was.
 */
export function uuidParam(value: string | undefined, name: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`${name} must be a uuid`, { [name]: 'must be a uuid' });
  }
  return parsed.data;
}

/**
 * Parses and validates a JSON request body.
 *
 * Absent, malformed and wrong-shaped bodies all become the same 400 with a
 * `fields` map, because from the client's side they are the same mistake. A
 * missing body in particular would otherwise throw a `SyntaxError` out of
 * `request.json()` and surface as a 500.
 */
export async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Expected a JSON body');
  }

  return validate(raw, schema);
}

/**
 * `parseBody` for a request whose body is entirely optional.
 *
 * "Open this storyline" has nothing it needs to say, and a POST with no body is
 * the natural way to say it — `URLSession` sends one by default. Treating that
 * as a 400 would make the simplest correct request the one that fails, so an
 * absent body becomes `{}` and the schema decides whether that is enough.
 */
export async function parseOptionalBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await request.text();
  if (text.trim() === '') return validate({}, schema);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError('Expected a JSON body');
  }

  return validate(raw, schema);
}

function validate<T>(raw: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      // Join because a nested path reads better as one key than as a tree the
      // client has to walk.
      fields[issue.path.join('.') || '_'] = issue.message;
    }
    throw new ValidationError('That request body is not in the expected shape', fields);
  }

  return parsed.data;
}
