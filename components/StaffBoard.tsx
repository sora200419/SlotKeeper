'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  addDays,
  applyLiveMessage,
  boardEvents,
  boardResources,
  createSseParser,
  dayHours,
  dayInZone,
  LEGEND,
  nextBookedDay,
  planDay,
  type AuditEntry,
  type BoardData,
  type Plan,
} from '@/lib/board/view';
import { BookingScheduler } from './BookingScheduler';
import { AuditList, CopilotPanel } from './CopilotPanel';

const TOKEN_KEY = 'slotkeeper-staff-token';
const MAX_RECONNECT_MS = 15_000;

/** The token is kept for this browser tab only (sessionStorage), never in the URL. */
function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // Storage blocked (private mode): the token simply isn't remembered.
    return '';
  }
}

function writeToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the board still works until the tab reloads.
  }
}

type Live = 'connecting' | 'live' | 'reconnecting';

export function StaffBoard() {
  const [token, setToken] = useState('');
  const [draft, setDraft] = useState('');
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState('');
  const [plan, setPlan] = useState<Plan | undefined>();
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [tab, setTab] = useState<'copilot' | 'audit'>('copilot');
  const [live, setLive] = useState<Live>('connecting');
  const dayRef = useRef(day);
  dayRef.current = day;

  // Set after mount: the page is prerendered, and sessionStorage belongs to the browser.
  useEffect(() => setToken(readToken()), []);

  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      const body = (await response.json().catch(() => ({}))) as T & { message?: string };
      if (response.status === 401) {
        writeToken('');
        setToken('');
      }
      if (!response.ok) throw new Error(body.message ?? `Request failed (HTTP ${response.status}).`);
      return body;
    },
    [token],
  );

  const loadBoard = useCallback(async () => {
    const board = await api<BoardData>('/api/staff/board');
    setData(board);
    setDay((current) => current || dayInZone(new Date(), board.timeZone));
    setError(null);
  }, [api]);

  const loadAudit = useCallback(async () => {
    setAudit((await api<{ entries: AuditEntry[] }>('/api/copilot/audit')).entries);
  }, [api]);

  useEffect(() => {
    if (!token) return;
    Promise.all([loadBoard(), loadAudit()]).catch((err: Error) => setError(err.message));
  }, [token, loadBoard, loadAudit]);

  // The live feed. Events sent before it connected are gone, so every connection reloads the board.
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let attempt = 0;

    async function listen() {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch('/api/bookings/events', {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`Live feed answered HTTP ${response.status}.`);
          await loadBoard();
          attempt = 0;
          setLive('live');
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          const parse = createSseParser();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const message of parse(value)) {
              setData((current) => (current ? applyLiveMessage(current, message) : current));
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.error('[board] live feed dropped', err instanceof Error ? err.message : err);
        }
        setLive('reconnecting');
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), MAX_RECONNECT_MS)));
      }
    }
    void listen();
    return () => controller.abort();
  }, [token, loadBoard]);

  const handlePlan = useCallback(
    (next: Plan | undefined) => {
      setPlan(next);
      if (next?.status === 'proposed' && data) {
        // Go to the day the plan is about, or its preview would be off screen.
        const target = planDay(next, data.bookings, data.timeZone);
        if (target) setDay(target);
      } else if (next) {
        setTab('copilot');
        loadAudit().catch((err: Error) => setError(err.message));
      }
    },
    [loadAudit, data],
  );

  const events = useMemo(() => (data ? boardEvents(data.bookings, data.services, plan) : []), [data, plan]);
  const resources = useMemo(() => (data ? boardResources(data.staff, events) : []), [data, events]);
  const hours = useMemo(() => (data && day ? dayHours(events, day, data.timeZone) : { open: 8, close: 20 }), [data, day, events]);
  const nextDay = data && day ? nextBookedDay(data.bookings, day, data.timeZone) : undefined;

  function signIn(event: FormEvent) {
    event.preventDefault();
    writeToken(draft);
    setToken(draft);
    setDraft('');
  }

  if (!token) {
    return (
      <main className="sk-gate">
        <form onSubmit={signIn}>
          <h1>SlotKeeper</h1>
          <p>Staff board</p>
          <label htmlFor="sk-token">Staff token</label>
          <input id="sk-token" type="password" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" required />
          <button type="submit" className="sk-primary">Open the board</button>
          {error && <p role="alert" className="sk-error">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <div className="sk-board">
      <header className="sk-top">
        <div className="sk-brand">
          <strong>SlotKeeper</strong>
          <span className={`sk-live sk-live-${live}`}>{live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Reconnecting'}</span>
        </div>
        {data && day && (
          <nav className="sk-days" aria-label="Day">
            <button type="button" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">‹</button>
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Date" />
            <button type="button" onClick={() => setDay(addDays(day, 1))} aria-label="Next day">›</button>
            <button type="button" onClick={() => setDay(dayInZone(new Date(), data.timeZone))}>Today</button>
            {nextDay && <button type="button" onClick={() => setDay(nextDay)}>Next booking</button>}
          </nav>
        )}
        <ul className="sk-legend" aria-label="Deposit colours">
          {LEGEND.map(({ state, label }) => (
            <li key={state} className={`sk-key sk-money-${state}`}>{label}</li>
          ))}
        </ul>
      </header>

      {error && <p role="alert" className="sk-error sk-banner">{error}</p>}
      {data && data.unsavedWrites > 0 && (
        <p role="alert" className="sk-error sk-banner">
          The database is behind: {data.unsavedWrites} recent change{data.unsavedWrites === 1 ? ' is' : 's are'} not saved yet and would be lost in a restart.
        </p>
      )}

      <main className="sk-main">
        <div className="sk-schedule">
          {data && day ? (
            <BookingScheduler staff={resources} events={events} day={day} hours={hours} timeZone={data.timeZone} />
          ) : (
            !error && <p className="sk-empty">Loading the schedule…</p>
          )}
          {data && <p className="sk-zone">Times in {data.timeZone}</p>}
        </div>
        <aside className="sk-side">
          <div className="sk-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'copilot'} onClick={() => setTab('copilot')}>Copilot</button>
            <button type="button" role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>Audit log{audit.length > 0 ? ` (${audit.length})` : ''}</button>
          </div>
          {tab === 'copilot' && data ? (
            <CopilotPanel bookings={data.bookings} staff={data.staff} plan={plan} onPlan={handlePlan} api={api} />
          ) : tab === 'audit' ? (
            <AuditList entries={audit} />
          ) : null}
        </aside>
      </main>
    </div>
  );
}
