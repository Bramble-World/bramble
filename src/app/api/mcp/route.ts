import { NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { withRequestLog } from '@/lib/api/request-log';
import { brambleMcpServer } from '@/lib/chatgpt/mcp.server';
import { markConnected } from '@/lib/services/chatgpt/chatgpt.service';
import { mcpResourceMetadataUrl, requireMcpUser } from '@/lib/services/auth/mcp-auth';
import { handleError } from '@/lib/utils/api.handler-errors';
import { UnauthorizedError } from '@/lib/utils/errors';

/**
 * Bramble in ChatGPT: the MCP endpoint (Streamable HTTP, stateless, JSON
 * responses). Every call is signed in with a Clerk OAuth token issued to
 * ChatGPT's client (`requireMcpUser`); without one, a 401 whose
 * `WWW-Authenticate` points at this resource's metadata, which is what makes
 * ChatGPT show "connect".
 *
 * Request bodies carry what the user's ChatGPT sent about their life, so they
 * are never logged: `withRequestLog` records the method, path and status only.
 */

async function handlePOST(request: Request): Promise<Response> {
  let user;
  try {
    user = await requireMcpUser(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Connect your Bramble account.' } },
        {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer resource_metadata="${mcpResourceMetadataUrl()}"`,
          },
        }
      );
    }
    return handleError(error);
  }

  try {
    await markConnected(user.id);
    const server = brambleMcpServer(user);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    return handleError(error);
  }
}

/** Stateless: no server-sent stream to open, and no session to end. */
function notAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}

export const POST = withRequestLog(handlePOST);
export const GET = notAllowed;
export const DELETE = notAllowed;
