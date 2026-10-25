'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

interface ServiceOption {
  id: string;
  label: string;
}

/** Default slot: tomorrow at 10:00 local time (inside the 3-day deposit window). */
function defaultSlot(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`;
}

export function NewBookingForm({ services }: { services: ServiceOption[] }) {
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
        body: JSON.stringify({
          serviceId: form.get('serviceId'),
          customerName: form.get('customerName'),
          startsAt: new Date(String(form.get('startsAt'))).toISOString(),
        }),
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
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '0.75rem', maxWidth: 360 }}>
      <label>
        Service{' '}
        <select name="serviceId" required>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Your name <input name="customerName" required maxLength={80} />
      </label>
      <label>
        Time <input name="startsAt" type="datetime-local" required defaultValue={defaultSlot()} />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? 'Booking…' : 'Book and hold deposit'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
