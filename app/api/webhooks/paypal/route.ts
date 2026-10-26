import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { getBookingStore } from '@/lib/booking/store';
import { getOrdersController, getPaymentsController } from '@/lib/paypal/client';
import { PayPalConfigError } from '@/lib/paypal/config';
import {
  handleWebhookEvent,
  parseWebhookEvent,
  processWebhookOnce,
  WebhookPayloadError,
} from '@/lib/paypal/webhook-events';
import {
  verifyWebhookSignature,
  WebhookRetryableError,
  WebhookSignatureError,
} from '@/lib/paypal/webhook-signature';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Reads the body as raw bytes (signatures cover the exact bytes) but stops at `limit`: this route
 * is public and runs before the signature check, so it must not buffer whatever it is sent.
 */
async function readLimitedBody(request: Request, limit: number): Promise<Buffer | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * PayPal webhook receiver. Any non-2xx makes PayPal redeliver (up to 25 times over 3 days), so:
 * 2xx once handled or deliberately ignored, 401/400 for requests PayPal didn't send or we can't
 * read, 503 for failures a retry can fix.
 */
export async function POST(request: Request) {
  try {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
    if (!webhookId) {
      throw new PayPalConfigError('PAYPAL_WEBHOOK_ID is not set; webhooks cannot be verified.', [
        'PAYPAL_WEBHOOK_ID',
      ]);
    }
    const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
    if (!rawBody) {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }
    await verifyWebhookSignature({ headers: request.headers, rawBody, webhookId });
    const event = parseWebhookEvent(rawBody);
    const outcome = await processWebhookOnce(event.id, () =>
      handleWebhookEvent(
        { orders: getOrdersController(), payments: getPaymentsController() },
        getBookingStore(),
        event,
      ),
    );
    console.info('[webhook] handled', { eventId: event.id, type: event.eventType, ...outcome });
    return NextResponse.json({ received: true, ...outcome });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      console.error('[webhook] rejected', {
        reason: err.reason,
        transmissionId: request.headers.get('paypal-transmission-id'),
      });
      return NextResponse.json({ error: 'invalid_signature', reason: err.reason }, { status: 401 });
    }
    if (err instanceof WebhookPayloadError) {
      return NextResponse.json({ error: 'invalid_payload', message: err.message }, { status: 400 });
    }
    if (err instanceof WebhookRetryableError) {
      console.error('[webhook] will be retried', { message: err.message });
      return NextResponse.json({ error: 'retry_later', message: err.message }, { status: 503 });
    }
    return errorResponse(err);
  }
}
