import { notFound } from 'next/navigation';
import { DepositCheckout } from '@/components/DepositCheckout';
import { findService, formatAmount } from '@/lib/booking/catalog';
import { getBookingStore, type BookingStatus } from '@/lib/booking/store';

export const dynamic = 'force-dynamic';

const STATUS_TEXT: Record<Exclude<BookingStatus, 'awaiting_deposit'>, string> = {
  deposit_held: 'Deposit held',
  deposit_pending: 'Deposit pending PayPal review',
  deposit_needs_review: 'Deposit needs staff review',
};

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = getBookingStore().get(id);
  if (!booking) notFound();
  const service = findService(booking.serviceId);
  const depositLabel = `${formatAmount(booking.deposit)} ${booking.deposit.currency}`;

  return (
    <main>
      <h1>{service?.name ?? 'Booking'}</h1>
      <p>
        {booking.customerName} · {new Date(booking.startsAt).toUTCString()}
      </p>
      {booking.status === 'awaiting_deposit' ? (
        <DepositCheckout
          bookingId={booking.id}
          currency={booking.deposit.currency}
          depositLabel={depositLabel}
        />
      ) : (
        <p role="status">
          {STATUS_TEXT[booking.status]} ({depositLabel}). Authorization{' '}
          <code>{booking.hold?.authorizationId}</code>.
        </p>
      )}
    </main>
  );
}
