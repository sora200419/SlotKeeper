'use client';

import { useReducer } from 'react';
import {
  actionRequest,
  bookingEvent,
  dollars,
  MONEY,
  PANEL_START,
  panelReducer,
  panelView,
  walletSummary,
  type BoardAction,
  type BoardBooking,
  type BoardService,
  type BoardStaff,
} from '@/lib/board/view';

interface Props {
  booking: BoardBooking | undefined;
  services: BoardService[];
  staff: BoardStaff[];
  timeZone: string;
  /** Sends a staff API request; rejects with a message the owner can read. */
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** The booking as PayPal left it, so the board shows it before the live feed catches up. */
  onBooking: (booking: BoardBooking) => void;
}

const RETRY_LABEL: Record<string, string> = {
  capture: 'capture',
  void: 'release',
  reauthorize: 'renewal',
  refund: 'refund',
  wallet_charge: 'wallet charge',
};

function buttonLabel(action: BoardAction): string {
  switch (action.kind) {
    case 'capture':
      return `Capture ${dollars(action.cents)}`;
    case 'no_show':
      return 'Charge no-show fee';
    case 'void':
      return 'Release hold';
    case 'refund':
      return 'Refund';
    case 'wallet':
      return 'Charge saved wallet';
    case 'retry':
      return `Retry the ${RETRY_LABEL[action.pending] ?? action.pending}`;
  }
}

/** What confirming will do, in words the owner checks before money moves. */
function confirmText(action: BoardAction, name: string): string {
  switch (action.kind) {
    case 'capture':
      return `Capture the whole ${dollars(action.cents)} deposit from ${name}?`;
    case 'no_show':
      return `Charge ${name} a no-show fee? The rest of the hold is released.`;
    case 'void':
      return `Release ${name}'s hold? Nothing is charged.`;
    case 'refund':
      return `Refund ${name}?`;
    case 'wallet':
      return `Charge ${name}'s saved PayPal wallet without them present?`;
    case 'retry':
      return 'PayPal never confirmed this call. Send it again? It carries the same request id, so it cannot happen twice.';
  }
}

export function BookingPanel({ booking, services, staff, timeZone, api, onBooking }: Props) {
  const [state, dispatch] = useReducer(panelReducer, PANEL_START);

  if (!booking) {
    return <p className="sk-empty">Click a booking on the schedule to see its deposit and act on it.</p>;
  }

  const view = panelView(state, booking);
  const { actions, chosen, amount, parsed, sending, message } = view;
  const event = bookingEvent(booking, services);
  const hold = booking.hold;
  const when = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(booking.startsAt));
  const who = staff.find((s) => s.id === booking.staffId)?.name ?? 'Unassigned';

  async function confirm(target: BoardBooking, action: BoardAction, cents: number | undefined) {
    const { path, body } = actionRequest(action, target.id, cents);
    dispatch({ type: 'start', bookingId: target.id });
    try {
      const updated = await api<BoardBooking>(path, {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      onBooking(updated);
      dispatch({ type: 'finish', bookingId: target.id, ok: true, text: `Done. ${MONEY[updated.status].label}.` });
    } catch (err) {
      dispatch({ type: 'finish', bookingId: target.id, ok: false, text: (err as Error).message });
    }
  }

  return (
    <section className="sk-booking" aria-label="Booking">
      <header>
        <h2>{booking.customerName}</h2>
        <p>
          {event.serviceName} · {when} · {who}
          {booking.source === 'agent' && <span className="sk-tag">Booked by an AI assistant</span>}
        </p>
        <p className={`sk-key sk-money-${event.moneyState}`}>{[event.moneyLabel, event.amount].filter(Boolean).join(' · ')}</p>
      </header>

      <dl>
        <dt>Deposit</dt>
        <dd>{dollars(booking.deposit.cents)}</dd>
        {hold?.capture && (
          <>
            <dt>Captured</dt>
            <dd>{dollars(hold.capture.amountCents)}</dd>
          </>
        )}
        {(hold?.refunds?.length ?? 0) > 0 && (
          <>
            <dt>Refunds</dt>
            <dd>{hold!.refunds!.map((r) => `${dollars(r.amountCents)}${r.status && r.status !== 'COMPLETED' ? ` (${r.status.toLowerCase()})` : ''}`).join(', ')}</dd>
          </>
        )}
        {hold?.savedWallet && (
          <>
            <dt>Saved wallet</dt>
            <dd>{walletSummary(hold)}</dd>
          </>
        )}
      </dl>

      {booking.status === 'deposit_needs_review' && <p className="sk-note">Check this payment in the PayPal dashboard before acting on it.</p>}
      {hold?.authorizeOutcomeUnknown && <p className="sk-note">PayPal has not confirmed this deposit yet; it is checked again on the next checkout or webhook.</p>}
      {view.expired && <p className="sk-note">PayPal never confirmed the last {RETRY_LABEL[hold!.pendingAction!.kind] ?? 'call'} and no longer recognises it. Check the payment in PayPal before doing anything else.</p>}

      {actions.length === 0 ? (
        <p className="sk-empty">No money action is open for this booking.</p>
      ) : (
        <div className="sk-actions sk-wrap">
          {actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className={action.kind === 'void' || action.kind === 'retry' ? undefined : 'sk-primary'}
              aria-pressed={chosen?.kind === action.kind}
              onClick={() => dispatch({ type: 'choose', bookingId: booking.id, action })}
              disabled={sending}
            >
              {buttonLabel(action)}
            </button>
          ))}
        </div>
      )}

      {chosen && (
        <div className="sk-confirm" role="group" aria-label="Confirm">
          <p>{confirmText(chosen, booking.customerName)}</p>
          {'maxCents' in chosen && (
            <label>
              Amount (up to {dollars(chosen.maxCents)})
              <input
                value={amount}
                onChange={(e) => dispatch({ type: 'amount', value: e.target.value })}
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={parsed ? !parsed.ok : undefined}
              />
            </label>
          )}
          {parsed && !parsed.ok && <p className="sk-error">{parsed.message}</p>}
          <div className="sk-actions">
            <button
              type="button"
              className="sk-primary"
              onClick={() => void confirm(booking, chosen, parsed?.ok ? parsed.cents : undefined)}
              disabled={sending || (parsed ? !parsed.ok : false)}
            >
              {sending ? 'Sending to PayPal…' : parsed?.ok ? `Confirm ${dollars(parsed.cents)}` : 'Confirm'}
            </button>
            <button type="button" onClick={() => dispatch({ type: 'cancel' })} disabled={sending}>Cancel</button>
          </div>
        </div>
      )}

      {sending && !chosen && <p role="status" className="sk-empty">Sending to PayPal…</p>}
      {message?.kind === 'error' && <p role="alert" className="sk-error">{message.text}</p>}
      {message?.kind === 'done' && <p role="status" className="sk-done">{message.text}</p>}
    </section>
  );
}
