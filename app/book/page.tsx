import { NewBookingForm } from '@/components/NewBookingForm';
import { SiteShell } from '@/components/SiteShell';
import { firstFreeSlotFrom } from '@/lib/booking/availability';
import { formatAmount, listServices } from '@/lib/booking/catalog';
import { getBookingStore } from '@/lib/booking/store';
import { defaultSlotIn, wallTimeIn, zonedWallTimeToUtc } from '@/lib/booking/zoned-time';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';

// Read BUSINESS_TIME_ZONE when the page is served, not once at build time.
export const dynamic = 'force-dynamic';

/**
 * The time the form starts with: tomorrow 10:00 shop time if the first service is free then, else the
 * next free slot after it (or the first free one from now). Visitors share one demo, so a fixed
 * default would soon be taken.
 */
function defaultStartsAt(serviceId: string | undefined, timeZone: string, now: Date): string {
  const preferred = defaultSlotIn(now, timeZone);
  if (!serviceId) return preferred;
  const store = getBookingStore();
  const slot =
    firstFreeSlotFrom(store, serviceId, zonedWallTimeToUtc(preferred, timeZone), timeZone, now) ??
    firstFreeSlotFrom(store, serviceId, now.toISOString(), timeZone, now);
  return slot ? wallTimeIn(slot, timeZone) : preferred;
}

export default function BookPage() {
  const timeZone = readBusinessTimeZone();
  const catalog = listServices();
  const services = catalog.map((service) => ({
    id: service.id,
    label: `${service.name} — ${formatAmount(service.price)} ${service.price.currency}, deposit ${formatAmount(service.deposit)}`,
  }));
  return (
    <SiteShell>
      <div className="site-narrow">
        <h1 className="site-page-title">Book a slot</h1>
        <p className="site-sub">
          Bookings are held with a PayPal deposit (sandbox) that counts toward the price; the rest is paid at the shop. You
          can book up to 3 days ahead.
        </p>
        <div className="site-card">
          <NewBookingForm
            services={services}
            timeZone={timeZone}
            defaultStartsAt={defaultStartsAt(catalog[0]?.id, timeZone, new Date())}
          />
        </div>
      </div>
    </SiteShell>
  );
}
