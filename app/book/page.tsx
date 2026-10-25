import { NewBookingForm } from '@/components/NewBookingForm';
import { formatAmount, listServices } from '@/lib/booking/catalog';

export default function BookPage() {
  const services = listServices().map((service) => ({
    id: service.id,
    label: `${service.name} — deposit ${formatAmount(service.deposit)} ${service.deposit.currency}`,
  }));
  return (
    <main>
      <h1>Book a slot</h1>
      <p>Bookings are held with a PayPal deposit (sandbox). You can book up to 3 days ahead.</p>
      <NewBookingForm services={services} />
    </main>
  );
}
