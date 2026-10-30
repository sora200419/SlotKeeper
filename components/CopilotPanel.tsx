'use client';

import { useState, type FormEvent } from 'react';
import { dollars, stepTitle, type AuditEntry, type BoardBooking, type BoardStaff, type Plan, type PlanStep } from '@/lib/board/view';

interface Props {
  bookings: BoardBooking[];
  staff: BoardStaff[];
  plan: Plan | undefined;
  onPlan: (plan: Plan | undefined) => void;
  /** Sends a staff API request; rejects with a message the owner can read. */
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const EXAMPLES = ['Maria is sick tomorrow. Move her clients to Ken, refund anyone who cannot move.', 'Who has not paid a deposit yet?'];

const isMoney = (step: PlanStep) => step.type !== 'move_booking';

function ResultLine({ plan, index }: { plan: Plan; index: number }) {
  const result = plan.results?.find((r) => r.index === index);
  if (!result) return null;
  return (
    <p className={`sk-step-result sk-step-${result.outcome}`}>
      {result.outcome === 'done' ? 'Done' : result.outcome === 'skipped' ? 'Skipped' : 'Failed'}
      {result.paypal ? ` · ${Object.values(result.paypal).join(', ')}` : ''}
      {result.error ? ` · ${result.error.message}` : ''}
    </p>
  );
}

export function CopilotPanel({ bookings, staff, plan, onPlan, api }: Props) {
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'asking' | 'approving' | 'rejecting' | null>(null);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy('asking');
    setError(null);
    setReply(null);
    try {
      const result = await api<{ reply: string; plan?: Plan }>('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      setReply(result.reply);
      onPlan(result.plan);
      setMessage('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function decide(decision: 'approve' | 'reject') {
    if (!plan || busy) return;
    setBusy(decision === 'approve' ? 'approving' : 'rejecting');
    setError(null);
    try {
      onPlan(await api<Plan>(`/api/copilot/plans/${plan.id}/${decision}`, { method: 'POST' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const open = plan?.status === 'proposed';
  const moneySteps = plan?.steps.filter(isMoney).length ?? 0;

  return (
    <section className="sk-copilot" aria-label="Copilot">
      <form onSubmit={ask}>
        <label htmlFor="sk-copilot-input">Tell the copilot what changed</label>
        <textarea
          id="sk-copilot-input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder={EXAMPLES[0]}
        />
        <button type="submit" className="sk-primary" disabled={!message.trim() || busy !== null}>
          {busy === 'asking' ? 'Planning…' : 'Plan it'}
        </button>
      </form>

      {error && <p role="alert" className="sk-error">{error}</p>}
      {reply && <p className="sk-reply">{reply}</p>}

      {plan && (
        <article className={`sk-plan sk-plan-${plan.status}`}>
          <header>
            <h2>{open ? 'Proposed plan' : `Plan ${plan.status}`}</h2>
            <p>{plan.summary}</p>
          </header>
          <ol>
            {plan.steps.map((step, index) => (
              <li key={index} className={isMoney(step) ? 'sk-step-money' : 'sk-step-move'}>
                <strong>{stepTitle(step, bookings, staff)}</strong>
                <p>{step.why}</p>
                <ResultLine plan={plan} index={index} />
              </li>
            ))}
          </ol>
          {open ? (
            <footer>
              <p>
                {moneySteps > 0
                  ? `Nothing has run yet. ${moneySteps} step${moneySteps === 1 ? ' moves' : 's move'} money through PayPal when you approve.`
                  : 'Nothing has run yet.'}
              </p>
              <div className="sk-actions">
                <button type="button" className="sk-primary" onClick={() => decide('approve')} disabled={busy !== null}>
                  {busy === 'approving' ? 'Running…' : 'Approve and run'}
                </button>
                <button type="button" onClick={() => decide('reject')} disabled={busy !== null}>
                  {busy === 'rejecting' ? 'Rejecting…' : 'Reject'}
                </button>
              </div>
            </footer>
          ) : (
            <footer>
              <button type="button" onClick={() => onPlan(undefined)}>Dismiss</button>
            </footer>
          )}
        </article>
      )}
    </section>
  );
}

const ACTION: Record<PlanStep['type'], string> = {
  move_booking: 'Moved booking',
  capture_deposit: 'Captured deposit',
  void_deposit: 'Released hold',
  reauthorize_deposit: 'Renewed hold',
  refund_deposit: 'Refunded',
  charge_saved_wallet: 'Charged saved wallet',
  run_payouts: 'Paid staff',
};

export function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="sk-empty">Every action the copilot runs is recorded here with its PayPal id.</p>;
  return (
    <ol className="sk-audit">
      {entries.map((entry) => (
        <li key={`${entry.planId}-${entry.stepIndex}`} className={`sk-audit-${entry.outcome}`}>
          <div>
            <strong>{ACTION[entry.action]}</strong>
            {entry.amountCents !== undefined && <span> {dollars(entry.amountCents)}</span>}
            <time dateTime={entry.at}>{new Date(entry.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</time>
          </div>
          <p>{entry.why}</p>
          {entry.paypal && <code>{Object.entries(entry.paypal).map(([k, v]) => `${k}: ${v}`).join(' · ')}</code>}
          {entry.error && <p className="sk-error">{entry.error.message}</p>}
        </li>
      ))}
    </ol>
  );
}
