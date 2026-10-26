import { describe, expect, it } from 'vitest';
import { BookingBusyError, withBookingLock } from '@/lib/booking/locks';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('withBookingLock', () => {
  it('reject mode fails fast while another holder runs', async () => {
    let release!: () => void;
    const first = withBookingLock('b-1', () => new Promise<void>((resolve) => (release = resolve)));
    await expect(withBookingLock('b-1', async () => 'second')).rejects.toBeInstanceOf(BookingBusyError);
    release();
    await first;
    expect(await withBookingLock('b-1', async () => 'after')).toBe('after');
  });

  it('wait mode runs holders one after another, in arrival order', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withBookingLock(
      'b-2',
      async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => (release = resolve));
        order.push('first:end');
      },
      'wait',
    );
    const second = withBookingLock('b-2', async () => void order.push('second'), 'wait');
    const third = withBookingLock('b-2', async () => void order.push('third'), 'wait');
    await tick();
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

  it('a failed holder releases the lock for the next one', async () => {
    const failed = withBookingLock('b-3', async () => {
      throw new Error('boom');
    }, 'wait');
    const next = withBookingLock('b-3', async () => 'ran', 'wait');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ran');
  });

  it('different bookings never block each other', async () => {
    let release!: () => void;
    const held = withBookingLock('b-4', () => new Promise<void>((resolve) => (release = resolve)));
    expect(await withBookingLock('b-5', async () => 'other')).toBe('other');
    release();
    await held;
  });
});
