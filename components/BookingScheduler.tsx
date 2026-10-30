'use client';

import { useEffect, useRef, useState } from 'react';
import type { Scheduler, EventModel } from '@bryntum/scheduler';
import { wallClock, type BoardEvent, type BoardStaff } from '@/lib/board/view';

interface Props {
  staff: BoardStaff[];
  events: BoardEvent[];
  day: string;
  hours: { open: number; close: number };
  timeZone: string;
}

/** The scheduler works in local dates, and events reach it as business wall-clock time (wallClock). */
function span(day: string, hours: Props['hours']): { startDate: Date; endDate: Date } {
  const [y, m, d] = day.split('-').map(Number);
  return { startDate: new Date(y, m - 1, d, hours.open), endDate: new Date(y, m - 1, d, hours.close) };
}

const custom = (event: EventModel) => event as EventModel & BoardEvent;

/** Plain text through DomConfig, never HTML: customer names are typed by customers. */
function renderEvent({ eventRecord, renderData }: { eventRecord: EventModel; renderData: { cls: unknown } }) {
  const e = custom(eventRecord);
  const cls = renderData.cls as Record<string, boolean>;
  cls[`sk-money-${e.moneyState}`] = true;
  cls['sk-ghost'] = Boolean(e.ghost);
  cls['sk-moving-away'] = Boolean(e.movingAway);
  return {
    className: 'sk-event-body',
    children: [
      { className: 'sk-event-title', text: e.ghost ? `${e.name} · proposed` : e.name },
      { className: 'sk-event-meta', text: e.serviceName },
      { className: 'sk-event-meta', text: `${e.moneyLabel} ${e.amount}`.trim() },
      e.planNote ? { className: 'sk-event-plan', text: e.planNote } : null,
      e.viaAgent ? { className: 'sk-event-agent', text: 'AI', title: 'Booked by a customer\'s AI assistant' } : null,
    ],
  };
}

/** The Bryntum Scheduler. It keeps its own store, so changes are applied to records, which animate. */
export function BookingScheduler({ staff, events, day, hours, timeZone }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scheduler = useRef<Scheduler | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef({ staff, events, day, hours });
  latest.current = { staff, events, day, hours };

  const applyEvents = (instance: Scheduler, next: BoardEvent[]) => {
    const store = instance.eventStore;
    const wanted = new Set(next.map((e) => e.id));
    const stale = store.allRecords.filter((record) => !wanted.has(String(record.id)));
    if (stale.length > 0) store.remove(stale as EventModel[]);
    for (const event of next) {
      // Every field on every event, even when empty: Bryntum only exposes fields it saw in the first
      // record, and a cleared preview has to overwrite the old value.
      const local = {
        planNote: '',
        ghost: false,
        movingAway: false,
        ...event,
        startDate: wallClock(event.startDate, timeZone),
        endDate: wallClock(event.endDate, timeZone),
      };
      const record = store.getById(event.id) as EventModel | undefined;
      if (record) record.set(local);
      else store.add(local);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let created: Scheduler | undefined;
    // Imported here: Bryntum touches the DOM on load, so it must never run during server rendering.
    import('@bryntum/scheduler')
      .then(({ Scheduler: SchedulerClass }) => {
        if (cancelled || !host.current) return;
        created = new SchedulerClass({
          appendTo: host.current,
          height: '100%',
          readOnly: true,
          viewPreset: 'hourAndDay',
          // The whole working day on one screen: a ghost must never land out of view.
          forceFit: true,
          ...span(latest.current.day, latest.current.hours),
          rowHeight: 130,
          barMargin: 6,
          eventStyle: 'filled',
          zoomOnMouseWheel: false,
          zoomOnTimeAxisDoubleClick: false,
          columns: [{ text: 'Staff', field: 'name', width: 130 }],
          resources: latest.current.staff,
          eventRenderer: renderEvent as never,
          features: {
            eventTooltip: {
              template: ({ eventRecord }: { eventRecord: EventModel }) => {
                const e = custom(eventRecord);
                return {
                  children: [
                    { tag: 'strong', text: e.name },
                    { tag: 'div', text: e.serviceName },
                    { tag: 'div', text: [e.moneyLabel, e.amount].filter(Boolean).join(' · ') },
                    e.viaAgent ? { tag: 'div', text: 'Booked by an AI assistant' } : null,
                    e.planNote ? { tag: 'div', text: e.planNote } : null,
                  ],
                };
              },
            },
          } as never,
        });
        scheduler.current = created;
        applyEvents(created, latest.current.events);
      })
      .catch((err: unknown) => {
        console.error('[board] the scheduler could not load', err instanceof Error ? err.message : err);
        if (!cancelled) setFailed('The schedule could not be loaded. Reload the page to try again.');
      });
    return () => {
      cancelled = true;
      created?.destroy();
      scheduler.current = null;
    };
    // The instance lives for the page; its data is updated by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeZone]);

  useEffect(() => {
    if (scheduler.current) scheduler.current.resources = staff as never;
  }, [staff]);

  useEffect(() => {
    if (scheduler.current) applyEvents(scheduler.current, events);
  }, [events]);

  useEffect(() => {
    if (!scheduler.current) return;
    const { startDate, endDate } = span(day, hours);
    scheduler.current.setTimeSpan(startDate, endDate);
  }, [day, hours]);

  if (failed) return <p role="alert">{failed}</p>;
  return <div ref={host} className="sk-scheduler" />;
}
