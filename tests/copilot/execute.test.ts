import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import { BookingBusyError } from '@/lib/booking/locks';
import { createMemoryBookingStore, type Booking, type BookingStore } from '@/lib/booking/store';
import { approvePlan, rejectPlan, type ExecuteDeps } from '@/lib/copilot/execute';
import { buildPlan, createMemoryAuditLog, createMemoryPlanStore, type PlanStore } from '@/lib/copilot/plan';
import { stubPayPal, type Reply } from '../helpers/paypal-stub';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T09:00:00.000Z');

function held(store: BookingStore, serviceId = 'haircut'): Booking {
  const b = createBooking(store, { serviceId, customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' }, NOW);
  const booking: Booking = {
    ...b,
    status: 'deposit_held',
    hold: { paypalOrderId: 'O-1', orderAttempt: 1, orderCreatedAt: NOW.toISOString(), authorizationId: 'AUTH-1', expiresAt: '2026-11-30T00:00:00Z' },
  };
  store.save(booking);
  return booking;
}

function setup(...replies: Reply[]) {
  const bookings = createMemoryBookingStore();
  const plans = createMemoryPlanStore();
  const audit = createMemoryAuditLog();
  const paypal = stubPayPal(...replies);
  const payouts = vi.fn(() => {
    throw new Error('payouts must not be built for this plan');
  });
  const deps: ExecuteDeps = {
    bookings,
    plans,
    audit,
    payments: paypal.payments,
    wallet: { orders: paypal.orders, vault: paypal.vault },
    payouts,
  };
  return { deps, bookings, plans, audit, paypal, payouts };
}

function propose(plans: PlanStore, bookings: BookingStore, steps: unknown[], now = NOW) {
  const plan = buildPlan({ summary: 's', steps }, 'owner request', bookings, now);
  plans.save(plan);
  return plan;
}

const captured = (value: string): Reply => ({
  status: 201,
  body: { id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value } },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('approvePlan', () => {
  it('runs the steps in order and audits each with its PayPal ids', async () => {
    const { deps, bookings, plans, audit, paypal, payouts } = setup({ status: 204 }, captured('4.00'));
    const moveAndVoid = held(bookings);
    const noShow = held(bookings, 'physio');
    const plan = propose(plans, bookings, [
      { type: 'move_booking', bookingId: moveAndVoid.id, staffId: 'ken', why: 'Maria is sick.' },
      { type: 'void_deposit', bookingId: moveAndVoid.id, why: 'Customer cancelled.' },
      { type: 'capture_deposit', bookingId: noShow.id, reason: 'no_show', amountCents: 400, why: 'Did not show up.' },
    ]);

    const done = await approvePlan(deps, plan.id, NOW);

    expect(done.status).toBe('executed');
    expect(done.results!.map((r) => r.outcome)).toEqual(['done', 'done', 'done']);
    expect(paypal.requests.map((r) => r.url)).toEqual([
      'https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH-1/void',
      'https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH-1/capture',
    ]);
    expect(bookings.get(moveAndVoid.id)).toMatchObject({ staffId: 'ken', status: 'cancelled' });
    expect(bookings.get(noShow.id)).toMatchObject({ status: 'no_show_charged' });

    const entries = audit.list();
    expect(entries.map((e) => [e.stepIndex, e.action, e.outcome])).toEqual([
      [2, 'capture_deposit', 'done'],
      [1, 'void_deposit', 'done'],
      [0, 'move_booking', 'done'],
    ]);
    expect(entries[0]).toMatchObject({ planId: plan.id, bookingId: noShow.id, amountCents: 400, paypal: { authorizationId: 'AUTH-1', captureId: 'CAP-1' } });
    expect(entries[1].paypal).toMatchObject({ authorizationId: 'AUTH-1', orderId: 'O-1' });
    expect(entries[2].paypal).toBeUndefined();
    expect(payouts).not.toHaveBeenCalled();
  });

  it('stops at the first failure: later steps are skipped and never reach PayPal', async () => {
    const { deps, bookings, plans, audit, paypal } = setup();
    const b = held(bookings);
    const plan = propose(plans, bookings, [
      { type: 'refund_deposit', bookingId: b.id, why: 'Nothing was captured yet, so this fails.' },
      { type: 'void_deposit', bookingId: b.id, why: 'Would run next.' },
    ]);

    const done = await approvePlan(deps, plan.id, NOW);

    expect(done.status).toBe('failed');
    expect(done.results).toMatchObject([
      { outcome: 'failed', error: { code: 'invalid_state' } },
      { outcome: 'skipped' },
    ]);
    expect(paypal.requests).toHaveLength(0);
    expect(audit.list().map((e) => e.outcome)).toEqual(['failed']);
    expect(bookings.get(b.id)!.status).toBe('deposit_held');
  });

  it('runs a plan at most once, even with two approvals at the same time', async () => {
    const { deps, bookings, plans, paypal } = setup({ status: 204 });
    const b = held(bookings);
    const plan = propose(plans, bookings, [{ type: 'void_deposit', bookingId: b.id, why: 'Cancelled.' }]);

    const [first, second] = await Promise.allSettled([approvePlan(deps, plan.id, NOW), approvePlan(deps, plan.id, NOW)]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: expect.any(BookingBusyError) });
    await expect(approvePlan(deps, plan.id, NOW)).rejects.toMatchObject({ code: 'not_proposed', httpStatus: 409 });
    expect(paypal.requests).toHaveLength(1);
  });

  it('refuses a plan older than 30 minutes, and a rejected plan', async () => {
    const { deps, bookings, plans, paypal } = setup();
    const b = held(bookings);
    const old = propose(plans, bookings, [{ type: 'void_deposit', bookingId: b.id, why: 'w' }]);
    await expect(approvePlan(deps, old.id, new Date(NOW.getTime() + 31 * 60 * 1000))).rejects.toMatchObject({ code: 'plan_expired' });

    const turnedDown = propose(plans, bookings, [{ type: 'void_deposit', bookingId: b.id, why: 'w' }]);
    expect((await rejectPlan(plans, turnedDown.id, NOW)).status).toBe('rejected');
    await expect(approvePlan(deps, turnedDown.id, NOW)).rejects.toMatchObject({ code: 'not_proposed' });
    await expect(approvePlan(deps, 'no-such-plan', NOW)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    expect(paypal.requests).toHaveLength(0);
  });

  it('R7: a move that breaks a time rule is refused while the plan is made', () => {
    const { bookings, plans } = setup();
    const b = held(bookings);
    expect(() =>
      propose(plans, bookings, [{ type: 'move_booking', bookingId: b.id, startsAt: '2026-12-25T10:00:00.000Z', why: 'Push to Christmas.' }]),
    ).toThrow('at most 3 days ahead');
  });

  it('a move that is no longer allowed at approval time fails as a readable step error', async () => {
    const { deps, bookings, plans } = setup();
    const b = held(bookings);
    const plan = propose(plans, bookings, [{ type: 'move_booking', bookingId: b.id, staffId: 'ken', why: 'Maria is sick.' }]);
    // Between proposal and approval the booking was cancelled by staff.
    bookings.save({ ...bookings.get(b.id)!, status: 'cancelled' });
    const done = await approvePlan(deps, plan.id, NOW);
    expect(done.results![0]).toMatchObject({ outcome: 'failed', error: { code: 'invalid_input' } });
    expect(bookings.get(b.id)!.staffId).toBe('maria');
  });

  it('R1: an unexpected error in a later step still closes the plan out, with every step audited', async () => {
    const { deps, bookings, plans, audit } = setup({ status: 204 });
    const b = held(bookings);
    const plan = propose(plans, bookings, [
      { type: 'void_deposit', bookingId: b.id, why: 'Cancelled.' },
      { type: 'run_payouts', day: '2026-10-31', why: 'Pay staff for yesterday.' },
    ]);
    const { PayPalConfigError } = await import('@/lib/paypal/config');
    deps.payouts = () => {
      throw new PayPalConfigError('STAFF_PAYOUT_EMAILS is broken', ['STAFF_PAYOUT_EMAILS']);
    };

    const done = await approvePlan(deps, plan.id, NOW);

    expect(done.status).toBe('failed');
    expect(done.results).toMatchObject([{ outcome: 'done' }, { outcome: 'failed', error: { code: 'missing_config' } }]);
    expect(plans.get(plan.id)!.status).toBe('failed');
    expect(audit.list().map((e) => [e.action, e.outcome])).toEqual([
      ['run_payouts', 'failed'],
      ['void_deposit', 'done'],
    ]);
  });

  it('R1: an error that is not one of ours is recorded without leaking request details', async () => {
    const { deps, bookings, plans, audit } = setup();
    held(bookings);
    const plan = propose(plans, bookings, [{ type: 'run_payouts', day: '2026-10-31', why: 'Pay staff.' }]);
    deps.payouts = () => {
      throw new TypeError('boom\nAuthorization: Bearer secret-token');
    };
    const done = await approvePlan(deps, plan.id, NOW);
    expect(done.results![0]).toMatchObject({ outcome: 'failed', error: { code: 'unexpected_error' } });
    expect(JSON.stringify([done, audit.list()])).not.toContain('secret-token');
  });
});

describe('approvePlan: PayPal ids in the audit log for every money step (R2)', () => {
  function withCapture(bookings: BookingStore, amountCents: number, extra: Partial<NonNullable<Booking['hold']>> = {}) {
    const b = held(bookings);
    const captured: Booking = {
      ...b,
      status: 'no_show_charged',
      hold: {
        ...b.hold!,
        capture: { captureId: 'CAP-1', amountCents, status: 'COMPLETED', reason: 'no_show', capturedAt: NOW.toISOString() },
        ...extra,
      },
    };
    bookings.save(captured);
    return captured;
  }

  it('refund: capture and refund ids', async () => {
    const { deps, bookings, plans, audit } = setup({
      status: 201,
      body: { id: 'REF-9', status: 'COMPLETED', amount: { currency_code: 'USD', value: '4.00' } },
    });
    const b = withCapture(bookings, 400);
    const plan = propose(plans, bookings, [{ type: 'refund_deposit', bookingId: b.id, why: 'Goodwill.' }]);
    await approvePlan(deps, plan.id, NOW);
    expect(audit.list()[0].paypal).toMatchObject({ captureId: 'CAP-1', refundId: 'REF-9' });
  });

  it('reauthorize: the new and the previous authorization ids', async () => {
    const { deps, bookings, plans, audit } = setup({
      status: 201,
      body: { id: 'AUTH-2', status: 'CREATED', amount: { currency_code: 'USD', value: '10.00' }, expiration_time: '2026-12-01T00:00:00Z' },
    });
    const b = held(bookings);
    const plan = propose(plans, bookings, [{ type: 'reauthorize_deposit', bookingId: b.id, why: 'Renew the hold.' }]);
    await approvePlan(deps, plan.id, NOW);
    expect(audit.list()[0].paypal).toMatchObject({ authorizationId: 'AUTH-2', previousAuthorizationId: 'AUTH-1' });
  });

  it('charge_saved_wallet: the wallet order and capture ids', async () => {
    const { deps, bookings, plans, audit } = setup({
      status: 201,
      body: {
        id: 'ORDER-W',
        status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ id: 'CAP-W', status: 'COMPLETED', amount: { currency_code: 'USD', value: '6.00' } }] } }],
      },
    });
    const b = withCapture(bookings, 400, {
      savedWallet: { vaultId: 'VAULT-1', status: 'VAULTED', customerId: 'CUST-1', savedAt: NOW.toISOString() },
    });
    const plan = propose(plans, bookings, [{ type: 'charge_saved_wallet', bookingId: b.id, why: 'Rest of the no-show fee.' }]);
    await approvePlan(deps, plan.id, NOW);
    expect(audit.list()[0]).toMatchObject({ outcome: 'done', paypal: { walletOrderId: 'ORDER-W', walletCaptureId: 'CAP-W' } });
  });

  it('run_payouts: batch ids and the payout state (so "nothing to pay" is visible)', async () => {
    const { deps, bookings, plans, audit } = setup();
    const { createMemoryPayoutStore } = await import('@/lib/paypal/payouts');
    deps.payouts = () => ({
      rest: { request: async () => { throw new Error('no PayPal call expected'); } },
      bookings,
      payouts: createMemoryPayoutStore(),
      emails: new Map(),
      timeZone: 'UTC',
    });
    const plan = propose(plans, bookings, [{ type: 'run_payouts', day: '2026-10-30', why: 'Pay staff.' }]);
    await approvePlan(deps, plan.id, NOW);
    expect(audit.list()[0].paypal).toEqual({ senderBatchId: 'slotkeeper-payouts-2026-10-30', payoutState: 'nothing_to_pay' });
  });
});
