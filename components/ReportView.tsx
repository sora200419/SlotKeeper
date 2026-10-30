'use client';

import { useEffect, useState, type FormEvent } from 'react';

interface Row {
  transactionId: string;
  date: string;
  bookingId: string;
  kind: 'deposit_captured' | 'no_show_fee' | 'refund';
  amountCents: number;
  status: string;
}

interface Report {
  from: string;
  to: string;
  windows: unknown[];
  rows: Row[];
  totals: {
    depositsCapturedCents: number;
    noShowFeesCents: number;
    refundsCents: number;
    netCents: number;
    pendingCount: number;
  };
  dataRefreshedAt?: string;
  lagNotice: string;
}

const LABEL: Record<Row['kind'], string> = {
  deposit_captured: 'Deposit captured',
  no_show_fee: 'No-show fee',
  refund: 'Refund',
};

const STATUS: Record<string, string> = { S: 'completed', P: 'pending', V: 'reversed', D: 'denied' };

const dollars = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** PayPal writes offsets as +0000; normalise to +00:00 so every browser parses it, then show UTC. */
function utc(value: string): string {
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`;
}

/** The staff token is kept for this browser tab only (sessionStorage), never in the URL. */
function readToken(): string {
  try {
    return sessionStorage.getItem('slotkeeper-staff-token') ?? '';
  } catch {
    // Storage blocked (private mode): the token simply isn't remembered.
    return '';
  }
}

export function ReportView() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [token, setToken] = useState('');
  // Set after mount: the page is prerendered, so dates and sessionStorage belong to the browser.
  useEffect(() => {
    const today = new Date();
    setFrom(isoDay(new Date(today.getTime() - 29 * 86_400_000)));
    setTo(isoDay(today));
    setToken(readToken());
  }, []);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      try {
        sessionStorage.setItem('slotkeeper-staff-token', token);
      } catch {
        // Storage blocked: the report still loads, the token is just not remembered.
      }
      const response = await fetch(`/api/reports/transactions?from=${from}&to=${to}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await response.json().catch(() => ({}))) as Report & { message?: string };
      if (!response.ok) throw new Error(data.message ?? `Request failed (HTTP ${response.status}).`);
      setReport(data);
    } catch (err) {
      setReport(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <p role="note">
        <strong>Heads-up:</strong> PayPal can take up to 3 hours to show new transactions in Transaction Search, so the
        last few hours may be missing. Dates are in UTC.
      </p>
      <form onSubmit={load}>
        <label>
          From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required />
        </label>{' '}
        <label>
          To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
        </label>{' '}
        <label>
          Staff token <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" />
        </label>{' '}
        <button type="submit" disabled={loading}>
          {loading ? 'Loading…' : 'Show report'}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}

      {report && (
        <>
          <h2>
            {report.from} to {report.to}
          </h2>
          <ul>
            <li>Deposits captured: {dollars(report.totals.depositsCapturedCents)}</li>
            <li>No-show fees: {dollars(report.totals.noShowFeesCents)}</li>
            <li>Refunds: {dollars(-report.totals.refundsCents)}</li>
            <li>
              <strong>Net: {dollars(report.totals.netCents)}</strong>
            </li>
            {report.totals.pendingCount > 0 && <li>{report.totals.pendingCount} still pending (not in the totals)</li>}
          </ul>
          <p>
            {report.lagNotice}
            {report.dataRefreshedAt ? ` PayPal data last refreshed ${utc(report.dataRefreshedAt)}.` : ''}
          </p>
          {report.rows.length === 0 ? (
            <p>No SlotKeeper transactions in this range.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Booking</th>
                  <th>PayPal transaction</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.transactionId}>
                    <td>{row.date ? utc(row.date) : ''}</td>
                    <td>{LABEL[row.kind]}</td>
                    <td>{dollars(row.kind === 'refund' ? -row.amountCents : row.amountCents)}</td>
                    <td>{STATUS[row.status] ?? row.status}</td>
                    <td>
                      <code>{row.bookingId.slice(0, 8)}</code>
                    </td>
                    <td>
                      <code>{row.transactionId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
