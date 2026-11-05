import { notFound } from 'next/navigation';
import { DepositCheckout } from '@/components/DepositCheckout';
import { SiteShell } from '@/components/SiteShell';
import { findService, formatAmount } from '@/lib/booking/catalog';
import { getBookingStore, type BookingStatus } from '@/lib/booking/store';
import { formatInZone } from '@/lib/booking/zoned-time';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';

export const dynamic = 'force-dynamic';

const STATUS_TEXT: Record<Exclude<BookingStatus, 'awaiting_deposit'>, string> = {
  deposit_held: 'Deposit held',
  deposit_pending: 'Deposit pending PayPal review',
  deposit_needs_review: 'Deposit needs staff review',
  completed: 'Appointment completed; deposit captured',
  no_show_charged: 'No-show fee charged; the rest of the hold was released',
  cancelled: 'Cancelled; the deposit hold was released',
  partially_refunded: 'Deposit partly refunded',
  refunded: 'Deposit refunded',
};

const BALANCE_DUE = new Set<BookingStatus>(['awaiting_deposit', 'deposit_held', 'deposit_pending', 'completed']);

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = getBookingStore().get(id);
  if (!booking) notFound();
  const service = findService(booking.serviceId);
  const depositLabel = `${formatAmount(booking.deposit)} ${booking.deposit.currency}`;
  const timeZone = readBusinessTimeZone();
  // The deposit counts toward the price; only the deposit goes through PayPal, the rest is paid in person.
  const balance = service && BALANCE_DUE.has(booking.status)
    ? { currency: booking.deposit.currency, cents: Math.max(0, service.price.cents - booking.deposit.cents) }
    : undefined;

  return (
    <SiteShell>
      <div className="site-narrow">
        <h1 className="site-page-title">{service?.name ?? 'Booking'}</h1>
        <p className="site-sub">
          {booking.customerName} · {formatInZone(booking.startsAt, timeZone)}
        </p>
        {service && balance && (
          <p className="site-sub">
            Price {formatAmount(service.price)} {service.price.currency} · deposit {depositLabel} through PayPal ·{' '}
            {formatAmount(balance)} {balance.currency} paid at the shop
          </p>
        )}
        <div className="site-card">
          {booking.status === 'awaiting_deposit' ? (
            <DepositCheckout
              bookingId={booking.id}
              currency={booking.deposit.currency}
              depositLabel={depositLabel}
              timeZone={timeZone}
            />
          ) : (
            <p role="status" className="site-status">
              {STATUS_TEXT[booking.status]} ({depositLabel}). Authorization{' '}
              <code>{booking.hold?.authorizationId}</code>.
            </p>
          )}
        </div>
      </div>
    </SiteShell>
  );
}
