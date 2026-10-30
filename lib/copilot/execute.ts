import 'server-only';
import { BookingInputError, moveBooking } from '@/lib/booking/bookings';
import { BookingBusyError, withBookingLock } from '@/lib/booking/locks';
import type { Booking, BookingStore } from '@/lib/booking/store';
import {
  captureDeposit,
  chargeSavedWallet,
  reauthorizeDeposit,
  refundDeposit,
  voidDeposit,
  type DepositPayments,
  type WalletPayPal,
} from '@/lib/paypal/deposit-actions';
import { PayPalConfigError } from '@/lib/paypal/config';
import { DepositError } from '@/lib/paypal/deposits';
import { sanitizeError } from '@/lib/paypal/errors';
import { PayoutError, runDailyPayouts, type PayoutBatchRecord, type PayoutDeps } from '@/lib/paypal/payouts';
import { flushWrites, takeConflict } from '@/lib/storage/records';
import type { AuditLog, Plan, PlanStep, PlanStore, StepResult } from './plan';

export class PlanError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_proposed' | 'plan_expired' | 'storage_unavailable',
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

export interface ExecuteDeps {
  bookings: BookingStore;
  plans: PlanStore;
  audit: AuditLog;
  payments: DepositPayments;
  wallet: WalletPayPal;
  /** Built only if the plan has a run_payouts step (payout settings can fail on their own). */
  payouts: () => PayoutDeps;
}

/** A plan reflects the bookings when it was made; after this long the owner should ask again. */
export const PLAN_TTL_MS = 30 * 60 * 1000;

function load(plans: PlanStore, id: string): Plan {
  const plan = plans.get(id);
  if (!plan) throw new PlanError('not_found', 404, 'Plan not found.');
  return plan;
}

/** PayPal ids to keep in the audit log for a step's result. */
function paypalIds(step: PlanStep, result: Booking | PayoutBatchRecord): Record<string, string> {
  if ('senderBatchId' in result) {
    // payoutState tells the owner whether anything was sent (e.g. nothing_to_pay, needs_review).
    return {
      senderBatchId: result.senderBatchId,
      payoutState: result.state,
      ...(result.payoutBatchId ? { payoutBatchId: result.payoutBatchId } : {}),
    };
  }
  const hold = result.hold;
  const ids: Record<string, string> = {};
  if (hold?.paypalOrderId) ids.orderId = hold.paypalOrderId;
  if (hold?.authorizationId) ids.authorizationId = hold.authorizationId;
  if (step.type === 'capture_deposit' && hold?.capture) ids.captureId = hold.capture.captureId;
  if (step.type === 'refund_deposit' && hold?.refunds?.length) {
    ids.captureId = hold.capture?.captureId ?? '';
    ids.refundId = hold.refunds[hold.refunds.length - 1].refundId;
  }
  if (step.type === 'reauthorize_deposit' && hold?.previousAuthorizationIds?.length) {
    ids.previousAuthorizationId = hold.previousAuthorizationIds[hold.previousAuthorizationIds.length - 1];
  }
  if (step.type === 'charge_saved_wallet' && hold?.walletCharges?.length) {
    const charge = hold.walletCharges[hold.walletCharges.length - 1];
    ids.walletOrderId = charge.orderId;
    ids.walletCaptureId = charge.captureId;
  }
  return ids;
}

async function runStep(deps: ExecuteDeps, step: PlanStep, now: Date): Promise<Booking | PayoutBatchRecord> {
  switch (step.type) {
    case 'move_booking':
      return moveBooking(deps.bookings, step.bookingId, { staffId: step.staffId, startsAt: step.startsAt }, now);
    case 'capture_deposit':
      return captureDeposit(deps.payments, deps.bookings, step.bookingId, { reason: step.reason, amountCents: step.amountCents }, now);
    case 'void_deposit':
      return voidDeposit(deps.payments, deps.bookings, step.bookingId, now);
    case 'reauthorize_deposit':
      return reauthorizeDeposit(deps.payments, deps.bookings, step.bookingId, now);
    case 'refund_deposit':
      return refundDeposit(deps.payments, deps.bookings, step.bookingId, { amountCents: step.amountCents }, now);
    case 'charge_saved_wallet':
      return chargeSavedWallet(deps.wallet, deps.bookings, step.bookingId, { amountCents: step.amountCents }, now);
    case 'run_payouts':
      return runDailyPayouts(deps.payouts(), step.day, now);
  }
}

/**
 * Every failure becomes a step error the owner can read, so the plan is always closed out (marked
 * failed, results saved, audited) instead of being left "executing" with steps that ran unrecorded.
 * Unexpected errors keep only their name and first line (they can carry request headers, F-002).
 */
function stepError(err: unknown): { code: string; message: string } {
  if (err instanceof DepositError || err instanceof PayoutError) return { code: err.code, message: err.message };
  if (err instanceof BookingBusyError) return { code: err.code, message: err.message };
  if (err instanceof BookingInputError) return { code: 'invalid_input', message: err.message };
  if (err instanceof PayPalConfigError) return { code: 'missing_config', message: err.message };
  return { code: 'unexpected_error', message: sanitizeError(err, 'Plan step').message };
}

/**
 * The owner approved the plan: run its steps in order, each through the same functions (and the same
 * idempotency keys and locks) as the staff routes, and stop at the first failure so nothing runs on top
 * of an unexpected state. Every executed step is written to the audit log with its PayPal ids. A plan
 * runs at most once.
 */
export function approvePlan(deps: ExecuteDeps, planId: string, now: Date = new Date()): Promise<Plan> {
  return withBookingLock(`plan-${planId}`, async () => {
    const plan = load(deps.plans, planId);
    if (plan.status !== 'proposed') throw new PlanError('not_proposed', 409, `This plan is already ${plan.status}.`);
    if (now.getTime() - Date.parse(plan.createdAt) > PLAN_TTL_MS) {
      throw new PlanError('plan_expired', 409, 'This plan is more than 30 minutes old; ask the copilot again.');
    }
    // Marked, and saved to the database, before anything runs: if the process dies mid-plan it can't be
    // approved a second time. A plan must not start moving money while that can't be guaranteed.
    deps.plans.save({ ...plan, status: 'executing', decidedAt: now.toISOString() });
    if (!(await flushWrites())) {
      deps.plans.save(plan);
      throw new PlanError('storage_unavailable', 503, 'The database is not answering, so nothing was run. Try again in a moment.');
    }
    // Another server instance approved it first (deploys overlap): only one may run it.
    if (takeConflict('plan', planId)) throw new PlanError('not_proposed', 409, 'Another server is already running this plan.');

    const results: StepResult[] = [];
    let failed = false;
    for (const [index, step] of plan.steps.entries()) {
      if (failed) {
        results.push({ index, type: step.type, outcome: 'skipped' });
        continue;
      }
      const base = {
        at: new Date().toISOString(),
        planId,
        stepIndex: index,
        action: step.type,
        why: step.why,
        ...('bookingId' in step ? { bookingId: step.bookingId } : { day: step.day }),
        ...('amountCents' in step && step.amountCents !== undefined ? { amountCents: step.amountCents } : {}),
      };
      try {
        const result = await runStep(deps, step, now);
        const paypal = step.type === 'move_booking' ? undefined : paypalIds(step, result);
        deps.audit.append({ ...base, outcome: 'done', paypal });
        results.push({ index, type: step.type, outcome: 'done', paypal });
      } catch (err) {
        const error = stepError(err);
        failed = true;
        console.error('[copilot] plan step failed', { planId, index, type: step.type, code: error.code });
        deps.audit.append({ ...base, outcome: 'failed', error });
        results.push({ index, type: step.type, outcome: 'failed', error });
      }
    }

    const done: Plan = { ...plan, status: failed ? 'failed' : 'executed', decidedAt: now.toISOString(), results };
    deps.plans.save(done);
    return done;
  });
}

export function rejectPlan(plans: PlanStore, planId: string, now: Date = new Date()): Promise<Plan> {
  return withBookingLock(`plan-${planId}`, async () => {
    const plan = load(plans, planId);
    if (plan.status !== 'proposed') throw new PlanError('not_proposed', 409, `This plan is already ${plan.status}.`);
    const rejected: Plan = { ...plan, status: 'rejected', decidedAt: now.toISOString() };
    plans.save(rejected);
    await flushWrites();
    if (takeConflict('plan', planId)) throw new PlanError('not_proposed', 409, 'Another server is already running this plan.');
    return rejected;
  });
}
