import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { NextResponse } from 'next/server';
import { createBookingMcpServer } from '@/lib/agent/mcp-server';
import { getHoldLimiter } from '@/lib/agent/rate-limit';
import { appOrigin } from '@/lib/api/app-origin';
import { readLimitedBody } from '@/lib/api/body';
import { getBookingStore } from '@/lib/booking/store';
import { getOrdersController, getPaymentsController } from '@/lib/paypal/client';
import { sanitizeError } from '@/lib/paypal/errors';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The caller's address for rate limiting: the last X-Forwarded-For entry, the one appended by our
 * own proxy (Render). Earlier entries come from the client and can be made up.
 */
function clientKey(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown';
}

/**
 * Remote MCP endpoint (Streamable HTTP, stateless: a fresh server per request, JSON responses) for a
 * customer's AI assistant, e.g. a Claude custom connector pointed at https://<host>/api/mcp.
 * Public like the booking page; changes to a booking need its booking token, and reservations are
 * rate limited.
 */
export async function POST(request: Request) {
  const body = await readLimitedBody(request, MAX_BODY_BYTES);
  if (!body) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  try {
    const server = createBookingMcpServer({
      bookings: getBookingStore(),
      orders: getOrdersController,
      payments: getPaymentsController,
      timeZone: readBusinessTimeZone(),
      origin: appOrigin(request),
      clientKey: clientKey(request),
      holdLimiter: getHoldLimiter(),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    // The body was already read (with a limit); hand the transport the same request with those bytes.
    return await transport.handleRequest(
      new Request(request.url, { method: 'POST', headers: request.headers, body: new Uint8Array(body) }),
    );
  } catch (err) {
    console.error('[mcp] request failed', { error: sanitizeError(err, 'MCP').message });
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
      { status: 500 },
    );
  }
}

/** Stateless server: no server-to-client stream and no sessions to end. */
export function GET() {
  return NextResponse.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { status: 405 });
}

export const DELETE = GET;
