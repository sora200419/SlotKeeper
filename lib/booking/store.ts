import 'server-only';
import { loadedRecords, persist } from '@/lib/storage/records';
import type { Money } from './catalog';
import { publishBookingChange } from './events';

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
  | 'deposit_needs_review'
  /** Service delivered; the full deposit was captured. */
  | 'completed'
  /** Customer didn't show; the no-show fee was captured and the rest of the hold released. */
  | 'no_show_charged'
  /** Cancelled within policy; the hold was voided, nothing charged. */
  | 'cancelled'
  /** Part of the captured money was refunded. */
  | 'partially_refunded'
  /** All captured money was refunded. */
  | 'refunded';

export type MoneyActionKind = 'capture' | 'void' | 'reauthorize' | 'refund' | 'wallet_charge';

/** The customer's PayPal wallet, saved in PayPal's vault during their deposit checkout (opt-in). */
export interface SavedWallet {
  /** PayPal payment token id; later orders are charged with it while the customer is away. */
  vaultId?: string;
  /** PayPal vault status, e.g. VAULTED (usable) or APPROVED (not yet stored). */
  status?: string;
  /** PayPal's customer id for the vault, needed to list or delete the customer's tokens. */
  customerId?: string;
  savedAt: string;
}

/** A merchant-initiated charge of the saved wallet (a separate PayPal order, captured at once). */
export interface WalletCharge {
  orderId: string;
  captureId: string;
  amountCents: number;
  /** PayPal capture status, e.g. COMPLETED or PENDING. */
  status: string;
  chargedAt: string;
  /** When a PENDING charge later completed (webhook); payouts count it on that day. */
  settledAt?: string;
}

/**
 * A money call whose outcome we never saw (5xx, no response, unreadable 2xx). It must be replayed
 * with the same PayPal-Request-Id and parameters before any other money call on the booking.
 */
export interface PendingMoneyAction {
  kind: MoneyActionKind;
  requestId: string;
  amountCents?: number;
  reason?: 'completed' | 'no_show';
  since: string;
}

export interface DepositCapture {
  captureId: string;
  amountCents: number;
  /** PayPal capture status, e.g. COMPLETED or PENDING. */
  status: string;
  /** "external": captured outside SlotKeeper (e.g. the PayPal dashboard), learned from a webhook. */
  reason: 'completed' | 'no_show' | 'external';
  capturedAt: string;
  /** When a PENDING capture later completed (webhook); payouts count it on that day. */
  settledAt?: string;
}

export interface DepositRefund {
  refundId: string;
  amountCents: number;
  /** PayPal refund status, e.g. COMPLETED or PENDING. */
  status: string;
  refundedAt: string;
  /** When a PENDING refund later completed (webhook); payouts count it on that day. */
  settledAt?: string;
}

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
  /** When the current unknown authorize began; replays stop once PayPal has forgotten its request id. */
  authorizeUnknownSince?: string;
  authorizationId?: string;
  /** PayPal authorization status, e.g. CREATED or PENDING. */
  authorizationStatus?: string;
  /** When PayPal will release the hold if it isn't captured. */
  expiresAt?: string;
  heldAt?: string;
  /** Authorizations replaced by a reauthorization, oldest first. */
  previousAuthorizationIds?: string[];
  capture?: DepositCapture;
  refunds?: DepositRefund[];
  voidedAt?: string;
  pendingAction?: PendingMoneyAction;
  /** Part of each money call's PayPal-Request-Id; bumped after a definite failure. */
  actionAttempts?: Partial<Record<MoneyActionKind, number>>;
  /** The order was created asking PayPal to save the wallet (the customer opted in). */
  savePayment?: boolean;
  /** PayPal's payer-action link for this order, for customers who approve outside our page (MCP). */
  approveUrl?: string;
  savedWallet?: SavedWallet;
  walletCharges?: WalletCharge[];
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
  /** Who does the appointment; their commission is paid out at the end of the day. */
  staffId?: string;
  /** "agent": booked by a customer's AI assistant through the MCP server. */
  source?: 'web' | 'agent';
  /** When an unpaid booking last claimed its slot (defaults to createdAt); the claim lasts 30 minutes. */
  slotHeldAt?: string;
  /**
   * SHA-256 of the booking token handed to the customer's assistant once (hold_slot). Later MCP
   * calls for this booking must present the token; the token itself is never stored.
   */
  accessTokenHash?: string;
  /**
   * Tip for the staff member, paid out with their commission. Nothing sets it yet: the invoice step
   * must only set it once the tip money was actually received (F-005), or payouts would pay it unpaid.
   */
  tipCents?: number;
}

export interface BookingStore {
  get(id: string): Booking | undefined;
  save(booking: Booking): void;
  /** Every booking (copies). */
  list(): Booking[];
}

/** In-memory store. getBookingStore adds Postgres behind it (lib/storage/records.ts). */
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
    list: () => [...bookings.values()].map((booking) => structuredClone(booking)),
  };
}

// Kept on globalThis so `next dev` hot reloads don't wipe bookings mid-test.
const globalStore = globalThis as typeof globalThis & { __slotkeeperBookings?: BookingStore };

/** Wraps a store so every save is pushed to live listeners (the staff SSE feed). */
export function withChangeEvents(store: BookingStore): BookingStore {
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    save: (booking) => {
      store.save(booking);
      publishBookingChange(structuredClone(booking));
    },
  };
}

/** Wraps a store so every save also goes to Postgres, and seeds it with what was saved before. */
export function withPersistence(store: BookingStore): BookingStore {
  for (const booking of loadedRecords<Booking>('booking')) store.save(booking);
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    save: (booking) => {
      store.save(booking);
      persist('booking', booking.id, booking);
    },
  };
}

export function getBookingStore(): BookingStore {
  globalStore.__slotkeeperBookings ??= withChangeEvents(withPersistence(createMemoryBookingStore()));
  return globalStore.__slotkeeperBookings;
}
