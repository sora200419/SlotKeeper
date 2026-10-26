import 'server-only';
import type { Booking } from './store';

type Listener = (booking: Booking) => void;

// Kept on globalThis like the store, so hot reloads don't orphan open SSE streams.
const state = globalThis as typeof globalThis & { __slotkeeperBookingListeners?: Set<Listener> };

function listeners(): Set<Listener> {
  return (state.__slotkeeperBookingListeners ??= new Set());
}

/** Subscribes to every saved booking (staff actions, checkout and webhooks). Returns the unsubscribe. */
export function onBookingChange(listener: Listener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

export function publishBookingChange(booking: Booking): void {
  for (const listener of listeners()) {
    try {
      listener(booking);
    } catch (err) {
      // One broken stream must not stop the save or the other listeners.
      console.error('[events] booking listener failed', {
        bookingId: booking.id,
        error: err instanceof Error ? `${err.name}: ${err.message.split('\n', 1)[0]}` : 'unknown',
      });
    }
  }
}
