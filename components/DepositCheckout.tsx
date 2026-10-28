'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'working'; message: string }
  | { kind: 'held'; authorizationId: string; expiresAt?: string }
  | { kind: 'error'; message: string };

interface Props {
  bookingId: string;
  currency: string;
  depositLabel: string;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) {
    throw new Error(data.message ?? `Request failed (HTTP ${response.status}).`);
  }
  return data as T;
}

function loadSdkScript(src: string): Promise<void> {
  if (window.paypal) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Could not load the PayPal SDK.')), {
      once: true,
    });
    if (!existing) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

interface HeldBooking {
  hold: { authorizationId: string; expiresAt?: string };
}

/** PayPal JS SDK v6 button that places a deposit hold (Orders v2 AUTHORIZE) for one booking. */
export function DepositCheckout({ bookingId, currency, depositLabel }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // Opt-in: save the customer's PayPal wallet so later deposits and no-show fees need no popup.
  const [savePayment, setSavePayment] = useState(false);
  const sessionRef = useRef<PayPalOneTimePaymentSession | null>(null);
  const buttonRef = useRef<HTMLElement | null>(null);

  const createOrder = useCallback(
    () => postJson<{ orderId: string }>(`/api/bookings/${bookingId}/deposit/order`, { savePayment }),
    [bookingId, savePayment],
  );

  useEffect(() => {
    let cancelled = false;
    // SDK callbacks can fire after this component unmounts (popup closed late, navigation).
    const update = (next: Phase) => {
      if (!cancelled) setPhase(next);
    };

    async function setUp() {
      // Re-run when the save-wallet choice changes: the v6 session takes it at creation.
      update({ kind: 'loading' });
      try {
        const configResponse = await fetch('/api/paypal/config');
        const config = (await configResponse.json()) as {
          clientId?: string;
          sdkUrl?: string;
          message?: string;
        };
        if (!configResponse.ok || !config.clientId || !config.sdkUrl) {
          throw new Error(config.message ?? 'PayPal is not configured.');
        }

        await loadSdkScript(config.sdkUrl);
        if (!window.paypal) throw new Error('The PayPal SDK did not initialise.');

        const sdk = await window.paypal.createInstance({
          clientId: config.clientId,
          components: ['paypal-payments'],
          pageType: 'checkout',
        });
        const methods = await sdk.findEligibleMethods({ currencyCode: currency });
        if (!methods.isEligible('paypal')) {
          throw new Error('PayPal is not available for this payment.');
        }

        const session = sdk.createPayPalOneTimePaymentSession({
          onApprove: async ({ orderId }) => {
            update({ kind: 'working', message: 'Holding your deposit…' });
            try {
              const booking = await postJson<HeldBooking>(
                `/api/bookings/${bookingId}/deposit/authorize`,
                { orderId },
              );
              update({
                kind: 'held',
                authorizationId: booking.hold.authorizationId,
                expiresAt: booking.hold.expiresAt,
              });
            } catch (err) {
              update({ kind: 'error', message: (err as Error).message });
            }
          },
          onCancel: () => update({ kind: 'ready' }),
          onError: (error) =>
            update({ kind: 'error', message: error.message ?? 'PayPal reported an error.' }),
          ...(savePayment ? { savePayment: true } : {}),
        });
        if (cancelled) return;
        sessionRef.current = session;

        // Redirect presentation mode brings the buyer back here; resume fires the callbacks above.
        if (session.hasReturned()) {
          await session.resume();
        } else {
          update({ kind: 'ready' });
        }
      } catch (err) {
        update({ kind: 'error', message: (err as Error).message });
      }
    }

    void setUp();
    return () => {
      cancelled = true;
    };
  }, [bookingId, currency, savePayment]);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || phase.kind !== 'ready') return;
    const onClick = async () => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        // v6: the second argument is a promise resolving to { orderId }.
        await session.start({ presentationMode: 'auto' }, createOrder());
      } catch (err) {
        setPhase({ kind: 'error', message: (err as Error).message });
      }
    };
    button.addEventListener('click', onClick);
    return () => button.removeEventListener('click', onClick);
  }, [phase.kind, createOrder]);

  return (
    <section>
      <p>
        Deposit to hold this slot: <strong>{depositLabel}</strong>. PayPal only holds it now;
        nothing is charged unless you miss the appointment.
      </p>
      {phase.kind === 'loading' && <p>Loading PayPal…</p>}
      {(phase.kind === 'ready' || phase.kind === 'loading') && (
        <label>
          <input
            type="checkbox"
            checked={savePayment}
            disabled={phase.kind === 'loading'}
            onChange={(event) => setSavePayment(event.target.checked)}
          />{' '}
          Save my PayPal account with SlotKeeper, so future deposits and no-show fees can be charged
          without asking me again.
        </label>
      )}
      <paypal-button ref={buttonRef} type="pay" class="paypal-gold" hidden={phase.kind !== 'ready'} />
      {phase.kind === 'working' && <p>{phase.message}</p>}
      {phase.kind === 'held' && (
        <p role="status">
          Deposit held. Authorization <code>{phase.authorizationId}</code>
          {phase.expiresAt ? `, valid until ${new Date(phase.expiresAt).toLocaleString()}` : ''}.
        </p>
      )}
      {phase.kind === 'error' && (
        <p role="alert">
          {phase.message}{' '}
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </p>
      )}
    </section>
  );
}
