import { env } from '@/env';

/**
 * Domain verification for Bramble in ChatGPT: OpenAI's plugin portal fetches
 * this on the MCP server's host and expects exactly the token it showed, as
 * plain text. The token comes from `OPENAI_APPS_CHALLENGE`; unset, it's a 404.
 */
// Read at request time, so setting the variable doesn't need a rebuild.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const token = env.OPENAI_APPS_CHALLENGE;
  if (!token) return new Response('Not found', { status: 404 });
  return new Response(token, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
