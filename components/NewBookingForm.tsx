'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { newBookingBody } from '@/lib/booking/zoned-time';

interface ServiceOption {
  id: string;
  label: string;
}

/**
 * The time field is read in the business time zone (`timeZone`), not the visitor's browser zone, so
 * "10:00" means 10:00 at the shop wherever the customer is. `defaultStartsAt` comes from the server,
 * so server and browser render the same value.
 */
export function NewBookingForm({
  services,
  timeZone,
  defaultStartsAt,
}: {
  services: ServiceOption[];
  timeZone: string;
  defaultStartsAt: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          newBookingBody({ serviceId: form.get('serviceId'), customerName: form.get('customerName'), startsAt: form.get('startsAt') }, timeZone),
        ),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!response.ok || !data.id) {
        throw new Error(data.message ?? `Booking failed (HTTP ${response.status}).`);
      }
      router.push(`/book/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="site-form">
      <label className="site-field">
        Service{' '}
        <select name="serviceId" required>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.label}
            </option>
          ))}
        </select>
      </label>
      <label className="site-field">
        Your name <input name="customerName" required maxLength={80} />
      </label>
      <label className="site-field">
        Time{' '}
        <input name="startsAt" type="datetime-local" required defaultValue={defaultStartsAt} aria-describedby="startsAt-hint" />
      </label>
      <small id="startsAt-hint" className="site-hint">
        Times are shop time: {timeZone}.
      </small>
      <button type="submit" className="site-button site-button-primary" disabled={submitting}>
        {submitting ? 'Booking…' : 'Book and hold deposit'}
      </button>
      {error && (
        <p role="alert" className="site-alert">
          {error}
        </p>
      )}
    </form>
  );
}
