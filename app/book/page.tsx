import { NewBookingForm } from '@/components/NewBookingForm';
import { SiteShell } from '@/components/SiteShell';
import { formatAmount, listServices } from '@/lib/booking/catalog';
import { defaultSlotIn } from '@/lib/booking/zoned-time';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';

// Read BUSINESS_TIME_ZONE when the page is served, not once at build time.
export const dynamic = 'force-dynamic';

export default function BookPage() {
  const timeZone = readBusinessTimeZone();
  const services = listServices().map((service) => ({
    id: service.id,
    label: `${service.name} — deposit ${formatAmount(service.deposit)} ${service.deposit.currency}`,
  }));
  return (
    <SiteShell>
      <div className="site-narrow">
        <h1 className="site-page-title">Book a slot</h1>
        <p className="site-sub">Bookings are held with a PayPal deposit (sandbox). You can book up to 3 days ahead.</p>
        <div className="site-card">
          <NewBookingForm services={services} timeZone={timeZone} defaultStartsAt={defaultSlotIn(new Date(), timeZone)} />
        </div>
      </div>
    </SiteShell>
  );
}
