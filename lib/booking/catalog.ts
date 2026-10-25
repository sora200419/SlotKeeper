import 'server-only';

/** Money in minor units (cents) so arithmetic never touches floats. */
export interface Money {
  currency: 'USD';
  cents: number;
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  price: Money;
  /** Held on the customer's PayPal account when they book. */
  deposit: Money;
}

/**
 * The source of truth for prices. The browser only ever sends a service id; amounts sent to PayPal
 * are always looked up here.
 */
const SERVICES: readonly Service[] = [
  {
    id: 'haircut',
    name: 'Haircut',
    durationMinutes: 45,
    price: { currency: 'USD', cents: 4500 },
    deposit: { currency: 'USD', cents: 1000 },
  },
  {
    id: 'color',
    name: 'Hair color',
    durationMinutes: 120,
    price: { currency: 'USD', cents: 12000 },
    deposit: { currency: 'USD', cents: 3000 },
  },
  {
    id: 'physio',
    name: 'Physio session',
    durationMinutes: 60,
    price: { currency: 'USD', cents: 8000 },
    deposit: { currency: 'USD', cents: 2000 },
  },
];

export function listServices(): readonly Service[] {
  return SERVICES;
}

export function findService(id: string): Service | undefined {
  return SERVICES.find((service) => service.id === id);
}

/** PayPal wants amounts as decimal strings with two places, e.g. "10.00". */
export function formatAmount(money: Money): string {
  if (!Number.isInteger(money.cents) || money.cents < 0) {
    throw new Error(`Invalid amount in cents: ${money.cents}`);
  }
  const whole = Math.floor(money.cents / 100);
  const fraction = String(money.cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}
