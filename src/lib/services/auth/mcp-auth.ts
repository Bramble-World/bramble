import { env } from '@/env';
import { getOrCreateFromClerk } from '@/lib/services/users/users.service';
import { PublicUser } from '@/lib/services/users/users.types';
import { ForbiddenError, UnauthorizedError } from '@/lib/utils/errors';
import { clerkBackend } from './auth.client';
import { clerkEnabled } from './auth.config';
import { clerkIdentity } from './auth.service';

/**
 * Sign-in for Bramble in ChatGPT (`/api/mcp`), and only there.
 *
 * ChatGPT signs its user in through Clerk's OAuth (Clerk is the authorization
 * server; Bramble is the protected resource), and sends the access token it
 * got. Everything else in the API keeps accepting only Clerk session tokens and
 * guest tokens (`requireCurrentUser`): an OAuth token is never a way into the
 * app's routes, and a session token is never a way into this one.
 *
 * Accounts only. A guest has no Clerk user, so cannot reach here at all.
 */

/** The path ChatGPT calls. Also the resource its tokens are for. */
export const MCP_PATH = '/api/mcp';

/**
 * The origin ChatGPT called: api.brambleworld.com in production, whichever host
 * staging or a tunnel serves. Taken from the request rather than configured, so
 * the resource ChatGPT is told about is always the URL it is talking to.
 */
function origin(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-host');
  const url = new URL(request.url);
  if (!forwarded) return url.origin;
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${forwarded.split(',')[0].trim()}`;
}

/** The resource URL: what ChatGPT is told it is signing in to. */
export function mcpResourceUrl(request: Request): string {
  return `${origin(request)}${MCP_PATH}`;
}

/** Where ChatGPT reads which authorization server to use (RFC 9728). */
export function mcpResourceMetadataUrl(request: Request): string {
  return `${origin(request)}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/**
 * Clerk's issuer, from the publishable key: `pk_<env>_` then the Frontend API
 * host, base64, with a trailing `$`. The same decoding Clerk's SDKs do.
 */
export function clerkIssuer(): string | null {
  const key = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const encoded = key?.split('_')[2];
  if (!encoded) return null;
  const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '');
  return host ? `https://${host}` : null;
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

/**
 * The account a ChatGPT call is from. Throws `UnauthorizedError` (a 401, which
 * the route answers with `WWW-Authenticate` so ChatGPT shows "connect") for no
 * token or one Clerk doesn't accept, and `ForbiddenError` for a token Clerk
 * issued to some other OAuth client.
 */
export async function requireMcpUser(request: Request): Promise<PublicUser> {
  if (!bearer(request) || !clerkEnabled || !env.CHATGPT_OAUTH_CLIENT_ID) {
    throw new UnauthorizedError();
  }

  const state = await clerkBackend.authenticateRequest(
    new Request(request.url, { method: request.method, headers: request.headers }),
    { acceptsToken: 'oauth_token' }
  );
  if (!state.isAuthenticated) throw new UnauthorizedError();

  const auth = state.toAuth();
  // Clerk's OAuth tokens carry no audience, so the client is what says the
  // token was issued for ChatGPT's connection to this server.
  if (auth.clientId !== env.CHATGPT_OAUTH_CLIENT_ID) {
    throw new ForbiddenError('This token is not for Bramble in ChatGPT.');
  }
  const clerkId = auth.userId;
  if (!clerkId) throw new UnauthorizedError();
  return getOrCreateFromClerk(clerkId, () => clerkIdentity(clerkId));
}
