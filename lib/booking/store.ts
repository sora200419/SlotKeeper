import 'server-only';
import type { Money } from './catalog';

export type BookingStatus =
  /** Created; waiting for the customer to approve the PayPal deposit hold. */
  | 'awaiting_deposit'
  /** PayPal is holding the deposit (authorization CREATED). */
  | 'deposit_held'
  /** PayPal accepted the authorization but it is still being reviewed (PENDING). */
  | 'deposit_pending'
  /**
   * PayPal holds funds but the authorization doesn't match the booking (e.g. a different amount).
   * The authorization id is kept so staff (or the void step) can release it.
   */
  | 'deposit_needs_review';

export interface DepositHold {
  paypalOrderId: string;
  /** Increments when an expired order is replaced; part of the PayPal-Request-Id. */
  orderAttempt: number;
  orderCreatedAt: string;
  /**
   * The order can't be approved again (PayPal declined it or it already carries an authorization);
   * the next checkout must start a new order.
   */
  orderSpent?: boolean;
  /** Part of the authorize PayPal-Request-Id; bumped after a definite failure so a retry isn't served the stored failure. */
  authorizeAttempt?: number;
  /** An authorize call may have succeeded at PayPal but we never saw the response. Replay it before anything else. */
  authorizeOutcomeUnknown?: boolean;
  authorizationId?: string;
  /** PayPal authorization status, e.g. CREATED or PENDING. */
  authorizationStatus?: string;
  /** When PayPal will release the hold if it isn't captured. */
  expiresAt?: string;
  heldAt?: string;
}

export interface Booking {
  id: string;
  serviceId: string;
  customerName: string;
  startsAt: string;
  deposit: Money;
  status: BookingStatus;
  hold?: DepositHold;
  createdAt: string;
}

export interface BookingStore {
  get(id: string): Booking | undefined;
  save(booking: Booking): void;
}

/**
 * In-memory store. Temporary: data is lost on restart and isn't shared between server instances.
 * The Postgres store from PLAN.md replaces it behind the same interface.
 */
export function createMemoryBookingStore(): BookingStore {
  const bookings = new Map<string, Booking>();
  return {
    get: (id) => {
      const booking = bookings.get(id);
      return booking ? structuredClone(booking) : undefined;
    },
    save: (booking) => {
      bookings.set(booking.id, structuredClone(booking));
    },
  };
}

// Kept on globalThis so `next dev` hot reloads don't wipe bookings mid-test.
const globalStore = globalThis as typeof globalThis & { __slotkeeperBookings?: BookingStore };

export function getBookingStore(): BookingStore {
  globalStore.__slotkeeperBookings ??= createMemoryBookingStore();
  return globalStore.__slotkeeperBookings;
}
