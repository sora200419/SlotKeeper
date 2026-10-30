import 'server-only';
import { PayPalConfigError } from '@/lib/paypal/config';

export interface StaffMember {
  id: string;
  name: string;
  /** Commission on the money a booking brought in, in basis points (4000 = 40%). */
  commissionBps: number;
  /** Services this person does by default; a booking for one of them is assigned to them. */
  services: readonly string[];
}

/** Demo staff until the scheduler (Bryntum) lets the owner manage them. */
const STAFF: readonly StaffMember[] = [
  { id: 'maria', name: 'Maria', commissionBps: 4000, services: ['haircut', 'color'] },
  { id: 'ken', name: 'Ken', commissionBps: 5000, services: ['physio'] },
];

export function listStaff(): readonly StaffMember[] {
  return STAFF;
}

export function findStaff(id: string): StaffMember | undefined {
  return STAFF.find((member) => member.id === id);
}

export function defaultStaffFor(serviceId: string): StaffMember | undefined {
  return STAFF.find((member) => member.services.includes(serviceId));
}

const EMAIL = /^[^\s@,=]+@[^\s@,=]+\.[^\s@,=]+$/;

/**
 * Where each staff member is paid: STAFF_PAYOUT_EMAILS="maria=a@example.com,ken=b@example.com".
 * In sandbox these are the owner's sandbox personal accounts (sandbox Payouts has no PHONE type).
 * Staff without an entry are left out of payouts and reported, not guessed.
 */
export function readPayoutEmails(env: Record<string, string | undefined> = process.env): Map<string, string> {
  const raw = env.STAFF_PAYOUT_EMAILS?.trim();
  const emails = new Map<string, string>();
  if (!raw) return emails;
  for (const entry of raw.split(',')) {
    const [id, email, extra] = entry.split('=').map((part) => part.trim());
    if (!id || !email || extra !== undefined || !EMAIL.test(email)) {
      throw new PayPalConfigError(
        `STAFF_PAYOUT_EMAILS must look like "maria=a@example.com,ken=b@example.com"; bad entry "${entry.trim()}".`,
        ['STAFF_PAYOUT_EMAILS'],
      );
    }
    if (!findStaff(id)) {
      throw new PayPalConfigError(`STAFF_PAYOUT_EMAILS names unknown staff member "${id}".`, ['STAFF_PAYOUT_EMAILS']);
    }
    emails.set(id, email);
  }
  return emails;
}
