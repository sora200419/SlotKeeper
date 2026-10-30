import 'server-only';
import { randomUUID } from 'node:crypto';
import { moveTimeProblem } from '@/lib/booking/bookings';
import { findStaff } from '@/lib/booking/staff';
import type { BookingStore } from '@/lib/booking/store';
import { loadedRecords, persist, registerStore } from '@/lib/storage/records';

/**
 * One step of an owner-approved plan. Each money step maps onto one function from the payment
 * layer (prompts 3, 5, 6), so its fields mirror what that function accepts: amounts in cents
 * (turned into PayPal Money by the payment layer), capture reasons, a business day for payouts.
 */
export type PlanStep =
  | { type: 'move_booking'; bookingId: string; staffId?: string; startsAt?: string; why: string }
  | { type: 'capture_deposit'; bookingId: string; reason: 'completed' | 'no_show'; amountCents?: number; why: string }
  | { type: 'void_deposit'; bookingId: string; why: string }
  | { type: 'reauthorize_deposit'; bookingId: string; why: string }
  | { type: 'refund_deposit'; bookingId: string; amountCents?: number; why: string }
  | { type: 'charge_saved_wallet'; bookingId: string; amountCents?: number; why: string }
  | { type: 'run_payouts'; day: string; why: string };

export const MONEY_STEPS = new Set<PlanStep['type']>([
  'capture_deposit',
  'void_deposit',
  'reauthorize_deposit',
  'refund_deposit',
  'charge_saved_wallet',
  'run_payouts',
]);

export interface StepResult {
  index: number;
  type: PlanStep['type'];
  outcome: 'done' | 'failed' | 'skipped';
  /** PayPal ids the step produced or acted on (capture, refund, authorization, order, payout batch). */
  paypal?: Record<string, string>;
  error?: { code: string; message: string };
}

export interface Plan {
  id: string;
  /** What the owner asked, verbatim. */
  request: string;
  summary: string;
  steps: PlanStep[];
  status: 'proposed' | 'executing' | 'executed' | 'failed' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  results?: StepResult[];
}

export interface PlanStore {
  get(id: string): Plan | undefined;
  save(plan: Plan): void;
}

export function createMemoryPlanStore(): PlanStore {
  const plans = new Map<string, Plan>();
  return {
    get: (id) => structuredClone(plans.get(id)),
    save: (plan) => void plans.set(plan.id, structuredClone(plan)),
  };
}

/** One executed action, kept for the owner and for reconciling with PayPal. */
export interface AuditEntry {
  at: string;
  planId: string;
  stepIndex: number;
  action: PlanStep['type'];
  bookingId?: string;
  day?: string;
  amountCents?: number;
  outcome: 'done' | 'failed';
  why: string;
  paypal?: Record<string, string>;
  error?: { code: string; message: string };
}

export interface AuditLog {
  append(entry: AuditEntry): void;
  /** Newest first. */
  list(limit?: number): AuditEntry[];
}

export function createMemoryAuditLog(): AuditLog {
  const entries: AuditEntry[] = [];
  return {
    append: (entry) => void entries.push(structuredClone(entry)),
    list: (limit = 100) => entries.slice(-limit).reverse().map((e) => structuredClone(e)),
  };
}

/** Longer than any plan runs: 50 steps at a few PayPal round trips each. */
const PLAN_RUN_LIMIT_MS = 30 * 60 * 1000;

const globalCopilot = globalThis as typeof globalThis & {
  __slotkeeperPlans?: PlanStore;
  __slotkeeperAudit?: AuditLog;
};

export function getPlanStore(): PlanStore {
  if (!globalCopilot.__slotkeeperPlans) {
    const memory = createMemoryPlanStore();
    const store: PlanStore = {
      get: (id) => memory.get(id),
      save: (plan) => {
        memory.save(plan);
        persist('plan', plan.id, plan);
      },
    };
    registerStore('plan', { apply: (data) => memory.save(data as Plan) });
    // A plan left "executing" means the server stopped mid-plan: nothing will finish it, and the audit
    // log shows what ran. But during a deploy the old instance may still be running it, so a recent
    // one gets until the plan could possibly have finished before it is written off.
    const writeOff = (plan: Plan) => store.save({ ...plan, status: 'failed', results: plan.results ?? [] });
    for (const plan of loadedRecords<Plan>('plan')) {
      memory.save(plan);
      if (plan.status !== 'executing') continue;
      const age = Date.now() - Date.parse(plan.decidedAt ?? '');
      if (!(age < PLAN_RUN_LIMIT_MS)) writeOff(plan);
      else {
        setTimeout(() => {
          const current = memory.get(plan.id);
          if (current?.status === 'executing') writeOff(current);
        }, PLAN_RUN_LIMIT_MS - age).unref();
      }
    }
    globalCopilot.__slotkeeperPlans = store;
  }
  return globalCopilot.__slotkeeperPlans;
}

export function getAuditLog(): AuditLog {
  if (!globalCopilot.__slotkeeperAudit) {
    const memory = createMemoryAuditLog();
    for (const entry of loadedRecords<AuditEntry>('audit')) memory.append(entry);
    registerStore('audit', { apply: (data) => memory.append(data as AuditEntry) });
    globalCopilot.__slotkeeperAudit = {
      list: (limit) => memory.list(limit),
      append: (entry) => {
        memory.append(entry);
        persist('audit', `${entry.planId}-${entry.stepIndex}`, entry);
      },
    };
  }
  return globalCopilot.__slotkeeperAudit;
}

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

const MAX_STEPS = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns the model's propose_plan input into a Plan. The model's output is untrusted: every field is
 * checked here, and every booking must exist, so a bad plan is sent back to the model to fix instead
 * of reaching the owner. (State checks such as "is this deposit still held" happen again when the
 * step runs, against the booking as it is then.)
 */
export function buildPlan(input: unknown, request: string, store: BookingStore, now: Date): Plan {
  const raw = input as { summary?: unknown; steps?: unknown };
  if (typeof raw?.summary !== 'string' || !raw.summary.trim()) throw new PlanValidationError('summary is required.');
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new PlanValidationError('steps must be a non-empty list.');
  if (raw.steps.length > MAX_STEPS) throw new PlanValidationError(`A plan has at most ${MAX_STEPS} steps.`);

  const steps = raw.steps.map((value, index): PlanStep => {
    const step = value as Record<string, unknown>;
    const at = `step ${index + 1}`;
    const why = typeof step?.why === 'string' && step.why.trim() ? step.why.trim().slice(0, 300) : undefined;
    if (!why) throw new PlanValidationError(`${at}: "why" is required.`);
    const bookingId = () => {
      if (typeof step.bookingId !== 'string' || !store.get(step.bookingId)) {
        throw new PlanValidationError(`${at}: bookingId must be an existing booking id.`);
      }
      return step.bookingId;
    };
    const amount = (): number | undefined => {
      if (step.amountCents === undefined || step.amountCents === null) return undefined;
      if (typeof step.amountCents !== 'number' || !Number.isInteger(step.amountCents) || step.amountCents < 1) {
        throw new PlanValidationError(`${at}: amountCents must be a positive whole number of cents.`);
      }
      return step.amountCents;
    };
    const optionalString = (key: string) => {
      const v = step[key];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string') throw new PlanValidationError(`${at}: ${key} must be a string.`);
      return v;
    };

    switch (step.type) {
      case 'move_booking': {
        const staffId = optionalString('staffId');
        const startsAt = optionalString('startsAt');
        if (staffId !== undefined && !findStaff(staffId)) throw new PlanValidationError(`${at}: unknown staffId "${staffId}".`);
        if (staffId === undefined && startsAt === undefined) throw new PlanValidationError(`${at}: give staffId and/or startsAt.`);
        const id = bookingId();
        if (startsAt !== undefined) {
          // Same rules as moveBooking, checked now so the model can fix the plan before the owner sees it.
          const problem = moveTimeProblem(store.get(id)!, startsAt, now);
          if (problem) throw new PlanValidationError(`${at}: ${problem}`);
        }
        return { type: 'move_booking', bookingId: id, staffId, startsAt, why };
      }
      case 'capture_deposit':
        if (step.reason !== 'completed' && step.reason !== 'no_show') {
          throw new PlanValidationError(`${at}: reason must be "completed" or "no_show".`);
        }
        return { type: 'capture_deposit', bookingId: bookingId(), reason: step.reason, amountCents: amount(), why };
      case 'void_deposit':
        return { type: 'void_deposit', bookingId: bookingId(), why };
      case 'reauthorize_deposit':
        return { type: 'reauthorize_deposit', bookingId: bookingId(), why };
      case 'refund_deposit':
        return { type: 'refund_deposit', bookingId: bookingId(), amountCents: amount(), why };
      case 'charge_saved_wallet':
        return { type: 'charge_saved_wallet', bookingId: bookingId(), amountCents: amount(), why };
      case 'run_payouts':
        if (typeof step.day !== 'string' || !DAY.test(step.day)) throw new PlanValidationError(`${at}: day must look like 2026-11-01.`);
        return { type: 'run_payouts', day: step.day, why };
      default:
        throw new PlanValidationError(`${at}: unknown step type ${JSON.stringify(step?.type)}.`);
    }
  });

  return {
    id: randomUUID(),
    request: request.slice(0, 2000),
    summary: raw.summary.trim().slice(0, 1000),
    steps,
    status: 'proposed',
    createdAt: now.toISOString(),
  };
}
