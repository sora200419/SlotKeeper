import { errorResponse, staffBooking } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { onBookingChange } from '@/lib/booking/events';
import { queuedWrites } from '@/lib/storage/records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 10_000;

/**
 * Staff-only Server-Sent Events feed: one `booking` event per saved booking (checkout, staff money
 * actions, PayPal webhooks). Browsers' EventSource can't send headers, so the scheduler reads this
 * with fetch() and a stream reader, passing the staff token in the Authorization header.
 */
export async function GET(request: Request) {
  try {
    requireStaff(request);
  } catch (err) {
    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between checks; stop() releases the listener and timer.
          stop();
        }
      };
      const unsubscribe = onBookingChange((booking) => {
        send(`event: booking\nid: ${booking.id}\ndata: ${JSON.stringify(staffBooking(booking))}\n\n`);
      });
      // Doubles as the keep-alive, and tells an open board when the database has fallen behind.
      const heartbeat = setInterval(() => send(`event: storage\ndata: ${JSON.stringify({ unsavedWrites: queuedWrites() })}\n\n`), HEARTBEAT_MS);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the client disconnected; nothing left to release.
        }
      };
      request.signal.addEventListener('abort', () => stop());
      send(': connected\n\n');
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
