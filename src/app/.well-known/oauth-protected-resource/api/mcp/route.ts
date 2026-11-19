import { NextResponse } from 'next/server';
import { clerkIssuer, mcpResourceUrl } from '@/lib/services/auth/mcp-auth';

/**
 * OAuth protected resource metadata for Bramble in ChatGPT (RFC 9728): the
 * resource is `/api/mcp`, and Clerk is the authorization server that signs its
 * users in. ChatGPT reads this after `/api/mcp` answers 401.
 *
 * Only `openid`: ChatGPT asks for it anyway, and it gives ChatGPT nothing but
 * an account id. `profile` or `email` would hand it the player's name, photo or
 * email, which the server doesn't need (it reads the user from the token).
 */
export function GET(request: Request): Response {
  const issuer = clerkIssuer();
  return NextResponse.json(
    {
      resource: mcpResourceUrl(request),
      authorization_servers: issuer ? [issuer] : [],
      scopes_supported: ['openid'],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://www.brambleworld.com/privacy',
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } }
  );
}
