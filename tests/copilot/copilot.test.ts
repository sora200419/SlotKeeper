import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import { createMemoryBookingStore, type Booking, type BookingStore } from '@/lib/booking/store';
import { createCopilotModel, DEFAULT_COPILOT_MODEL, readCopilotModel, runCopilot, type CopilotModel } from '@/lib/copilot/copilot';
import { buildPlan, createMemoryPlanStore, PlanValidationError } from '@/lib/copilot/plan';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T09:00:00.000Z');

type Block = Anthropic.Beta.BetaContentBlock;
const message = (content: Block[], stop: Anthropic.Beta.BetaStopReason = 'tool_use') =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop }) as unknown as Anthropic.Beta.BetaMessage;
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as unknown as Block;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Block;

/** A scripted model: returns the replies in order and records every request. */
function fakeModel(...replies: Array<Anthropic.Beta.BetaMessage | Error>) {
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const model: CopilotModel = {
    beta: {
      messages: {
        create: async (params) => {
          requests.push(structuredClone(params));
          const reply = replies.shift();
          if (!reply) throw new Error('unexpected model call');
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  };
  return { model, requests };
}

function booking(store: BookingStore, serviceId = 'haircut', status: Booking['status'] = 'deposit_held'): Booking {
  const b = createBooking(store, { serviceId, customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' }, NOW);
  const held: Booking = {
    ...b,
    status,
    hold: { paypalOrderId: 'O-1', orderAttempt: 1, orderCreatedAt: NOW.toISOString(), authorizationId: 'AUTH-1', expiresAt: '2026-11-30T00:00:00Z' },
  };
  store.save(held);
  return held;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runCopilot', () => {
  it('reads with tools, then stores the proposed plan without running anything', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store);
    const plans = createMemoryPlanStore();
    const { model, requests } = fakeModel(
      message([toolUse('t1', 'list_bookings', { staffId: 'maria' })]),
      message([
        text('Here is the plan.'),
        toolUse('t2', 'propose_plan', {
          summary: 'Move Ana to Ken and release her deposit.',
          steps: [
            { type: 'move_booking', bookingId: b.id, staffId: 'ken', why: 'Maria is off sick.' },
            { type: 'void_deposit', bookingId: b.id, why: 'She cannot come.' },
          ],
        }),
      ]),
    );

    const result = await runCopilot({ model, bookings: store, plans, timeZone: 'UTC' }, 'Maria is sick tomorrow', NOW);

    expect(result.reply).toBe('Here is the plan.');
    expect(result.plan).toMatchObject({ status: 'proposed', request: 'Maria is sick tomorrow', steps: [{ type: 'move_booking' }, { type: 'void_deposit' }] });
    expect(plans.get(result.plan!.id)!.status).toBe('proposed');
    // Nothing moved: the booking is untouched.
    expect(store.get(b.id)).toMatchObject({ status: 'deposit_held', staffId: 'maria' });

    // Request shape: Haiku by default, adaptive thinking, explicit effort, our tools. Haiku 5.5 has no
    // server-side fallback, so neither the parameter nor its beta header is sent.
    expect(requests[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect(requests[0]).not.toHaveProperty('fallbacks');
    expect(requests[0]).not.toHaveProperty('betas');
    expect(requests[0].tools!.map((t) => (t as { name: string }).name)).toEqual([
      'list_bookings',
      'get_booking',
      'list_staff',
      'daily_earnings',
      'propose_plan',
    ]);
    // The read tool's result went back to the model, without vault or PayPal customer ids.
    const toolResult = (requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    expect(toolResult.tool_use_id).toBe('t1');
    const listed = JSON.parse(toolResult.content as string);
    expect(listed.bookings).toMatchObject([{ id: b.id, staffId: 'maria', status: 'deposit_held', depositCents: 1000 }]);
  });

  it('never shows the model vault, PayPal customer, order or authorization ids', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store);
    store.save({
      ...b,
      hold: {
        ...b.hold!,
        paypalOrderId: 'ORDER-SECRET',
        authorizationId: 'AUTH-SECRET',
        savedWallet: { vaultId: 'VAULT-SECRET', customerId: 'CUST-SECRET', status: 'VAULTED', savedAt: NOW.toISOString() },
      },
    });
    const { model, requests } = fakeModel(
      message([toolUse('t1', 'list_bookings', {}), toolUse('t2', 'get_booking', { bookingId: b.id })]),
      message([text('Done.')], 'end_turn'),
    );
    await runCopilot({ model, bookings: store, plans: createMemoryPlanStore(), timeZone: 'UTC' }, 'x', NOW);

    const results = JSON.stringify(requests[1].messages[2].content);
    // Both tools answered, and told the model a wallet is saved without saying which one.
    expect(results.match(new RegExp(b.id, 'g'))!.length).toBeGreaterThanOrEqual(2);
    expect(results).toContain('savedWallet');
    for (const secret of ['VAULT-SECRET', 'CUST-SECRET', 'ORDER-SECRET', 'AUTH-SECRET']) expect(results).not.toContain(secret);
  });

  it('sends an invalid plan back to the model to fix', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store);
    const plans = createMemoryPlanStore();
    const { model, requests } = fakeModel(
      message([toolUse('t1', 'propose_plan', { summary: 'x', steps: [{ type: 'refund_deposit', bookingId: 'made-up', why: 'y' }] })]),
      message([toolUse('t2', 'propose_plan', { summary: 'x', steps: [{ type: 'void_deposit', bookingId: b.id, why: 'y' }] })]),
    );
    const result = await runCopilot({ model, bookings: store, plans, timeZone: 'UTC' }, 'cancel Ana', NOW);
    const feedback = (requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    expect(feedback).toMatchObject({ is_error: true });
    expect(String(feedback.content)).toContain('bookingId must be an existing booking id');
    expect(result.plan!.steps).toEqual([{ type: 'void_deposit', bookingId: b.id, why: 'y', amountCents: undefined }].map(({ amountCents: _a, ...s }) => s));
  });

  it('R4: keeps only the first plan of a turn; a second one is refused, not saved', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store);
    const plans = createMemoryPlanStore();
    const step = { type: 'void_deposit', bookingId: b.id, why: 'w' };
    const { model } = fakeModel(
      message([
        toolUse('t1', 'propose_plan', { summary: 'first', steps: [step] }),
        toolUse('t2', 'propose_plan', { summary: 'second', steps: [step] }),
      ]),
    );
    const save = vi.spyOn(plans, 'save');
    const result = await runCopilot({ model, bookings: store, plans, timeZone: 'UTC' }, 'cancel Ana', NOW);
    expect(result.plan!.summary).toBe('first');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('answers a question without a plan', async () => {
    const { model } = fakeModel(message([text('Maria has 2 bookings tomorrow.')], 'end_turn'));
    const result = await runCopilot(
      { model, bookings: createMemoryBookingStore(), plans: createMemoryPlanStore(), timeZone: 'UTC' },
      'How busy is Maria?',
      NOW,
    );
    expect(result).toEqual({ reply: 'Maria has 2 bookings tomorrow.' });
  });

  it('maps refusals, truncation and API failures to clear errors', async () => {
    const deps = (m: CopilotModel) => ({ model: m, bookings: createMemoryBookingStore(), plans: createMemoryPlanStore(), timeZone: 'UTC' });
    await expect(runCopilot(deps(fakeModel(message([], 'refusal')).model), 'x', NOW)).rejects.toMatchObject({ code: 'model_refused', httpStatus: 422 });
    await expect(runCopilot(deps(fakeModel(message([], 'max_tokens')).model), 'x', NOW)).rejects.toMatchObject({ code: 'model_error' });
    const apiError = new Anthropic.InternalServerError(500, { error: { message: 'overloaded' } }, 'overloaded', new Headers());
    await expect(runCopilot(deps(fakeModel(apiError).model), 'x', NOW)).rejects.toMatchObject({ code: 'model_error', httpStatus: 502 });
  });

  it('gives up after a bounded number of turns', async () => {
    const replies = Array.from({ length: 8 }, (_, i) => message([toolUse(`t${i}`, 'list_staff', {})]));
    const { model, requests } = fakeModel(...replies);
    await expect(
      runCopilot({ model, bookings: createMemoryBookingStore(), plans: createMemoryPlanStore(), timeZone: 'UTC' }, 'loop', NOW),
    ).rejects.toMatchObject({ code: 'no_plan' });
    expect(requests).toHaveLength(8);
  });

  it('is disabled without ANTHROPIC_API_KEY', () => {
    expect(() => createCopilotModel({})).toThrow(expect.objectContaining({ code: 'missing_config', httpStatus: 500 }));
  });
});

describe('which model the copilot runs on', () => {
  const ask = (model: CopilotModel) =>
    runCopilot({ model, bookings: createMemoryBookingStore(), plans: createMemoryPlanStore(), timeZone: 'UTC' }, 'x', NOW);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to Haiku 5.5 when COPILOT_MODEL is unset or blank', () => {
    expect(readCopilotModel({})).toEqual({ id: 'claude-haiku-5-5', fallback: false });
    expect(readCopilotModel({ COPILOT_MODEL: '  ' })).toEqual({ id: 'claude-haiku-5-5', fallback: false });
    expect(DEFAULT_COPILOT_MODEL).toBe('claude-haiku-5-5');
  });

  it.each(['claude-sonnet-5-5', 'claude-opus-5-5'])('%s is selectable and asks for the refusal fallback', async (id) => {
    vi.stubEnv('COPILOT_MODEL', id);
    const { model, requests } = fakeModel(message([text('ok')], 'end_turn'));
    await ask(model);
    expect(requests[0]).toMatchObject({ model: id, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  });

  it('Haiku never gets the fallback parameter: the API rejects or ignores it there', async () => {
    vi.stubEnv('COPILOT_MODEL', 'claude-haiku-5-5');
    const { model, requests } = fakeModel(message([text('ok')], 'end_turn'));
    await ask(model);
    expect(requests[0]).not.toHaveProperty('fallbacks');
    expect(requests[0]).not.toHaveProperty('betas');
  });

  it.each(['gpt-5', 'claude-opus-4-1', '__proto__', 'constructor'])('an unknown model "%s" stops the copilot before any request', async (id) => {
    vi.stubEnv('COPILOT_MODEL', id);
    const { model, requests } = fakeModel(message([text('ok')], 'end_turn'));
    await expect(ask(model)).rejects.toMatchObject({ code: 'missing_config', httpStatus: 500, message: expect.stringContaining('claude-haiku-5-5') });
    expect(requests).toHaveLength(0);
  });

  it('a refusal on Haiku stays a clear error: nothing re-runs it elsewhere', async () => {
    const { model, requests } = fakeModel(message([], 'refusal'));
    await expect(ask(model)).rejects.toMatchObject({ code: 'model_refused', httpStatus: 422 });
    expect(requests).toHaveLength(1);
  });
});

describe('buildPlan', () => {
  const store = createMemoryBookingStore();
  const b = booking(store);
  const plan = (steps: unknown[]) => buildPlan({ summary: 's', steps }, 'r', store, NOW);

  it.each([
    [[], 'non-empty'],
    [[{ type: 'void_deposit', bookingId: b.id }], '"why" is required'],
    [[{ type: 'teleport', bookingId: b.id, why: 'w' }], 'unknown step type'],
    [[{ type: 'capture_deposit', bookingId: b.id, reason: 'maybe', why: 'w' }], 'reason must be'],
    [[{ type: 'refund_deposit', bookingId: b.id, amountCents: 2.5, why: 'w' }], 'amountCents'],
    [[{ type: 'move_booking', bookingId: b.id, staffId: 'bob', why: 'w' }], 'unknown staffId'],
    [[{ type: 'move_booking', bookingId: b.id, why: 'w' }], 'staffId and/or startsAt'],
    [[{ type: 'run_payouts', day: 'yesterday', why: 'w' }], 'day must look like'],
  ])('rejects %j', (steps, message) => {
    expect(() => plan(steps)).toThrow(PlanValidationError);
    expect(() => plan(steps)).toThrow(message);
  });

  it('rejects too many steps', () => {
    expect(() => plan(Array.from({ length: 51 }, () => ({ type: 'void_deposit', bookingId: b.id, why: 'w' })))).toThrow('at most 50');
  });
});
