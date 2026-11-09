import { describe, expect, it } from 'vitest';
import { describeForwarding, maskAddress } from '@/lib/api/forwarding-diagnostic';

const SALT = new Uint8Array(16).fill(7);

function request(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/mcp', { method: 'POST', headers });
}

describe('forwarding diagnostic', () => {
  it('never logs an address in full', () => {
    const out = describeForwarding(
      request({
        'x-forwarded-for': '198.51.100.23, 203.0.113.77',
        'x-real-ip': '198.51.100.23',
        'cf-connecting-ip': '2001:db8:85a3::8a2e:370:7334',
      }),
      SALT,
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain('198.51.100.23');
    expect(text).not.toContain('203.0.113.77');
    expect(text).not.toContain('8a2e:370:7334');
    expect(out.xff[0]).toMatch(/^198\.51\.\*\.\*#[0-9a-f]{8}$/);
    expect(out.cfConnectingIp).toMatch(/^2001:db8:\*#[0-9a-f]{8}$/);
  });

  it('R1: values that are not a bare address (ports, lists, for=) never show the address', () => {
    const v4 = '198.51.100.23';
    const cases: [string, RegExp][] = [
      [`${v4}:51234`, /^\?v4port#[0-9a-f]{8}$/],
      ['[2001:db8::1]:443', /^\?v6port#[0-9a-f]{8}$/],
      [`${v4}, 2001:db8::1`, /^\?list#[0-9a-f]{8}$/],
      [`2001:db8::1, ${v4}`, /^\?list#[0-9a-f]{8}$/],
      [`for=${v4}:80`, /^\?other#[0-9a-f]{8}$/],
      [`::ffff:${v4}`, /^::\*#[0-9a-f]{8}$/],
    ];
    for (const [value, expected] of cases) {
      const masked = maskAddress(value, SALT);
      expect(masked, value).toMatch(expected);
      expect(masked, value).not.toContain(v4);
      expect(masked, value).not.toContain('100.23');
    }
    const out = describeForwarding(request({ 'x-real-ip': `${v4}, 2001:db8::1`, 'x-forwarded-for': `${v4}:51234` }), SALT);
    expect(JSON.stringify(out)).not.toContain(v4);
  });

  it('R3: keeps only the last five X-Forwarded-For entries but counts all of them', () => {
    const list = Array.from({ length: 50 }, (_, i) => `198.51.100.${i}`).join(', ');
    const out = describeForwarding(request({ 'x-forwarded-for': list }), SALT);
    expect(out.xffCount).toBe(50);
    expect(out.xff).toHaveLength(5);
    expect(out.xff[4]).toBe(maskAddress('198.51.100.49', SALT));
  });

  it('gives equal addresses equal tags and different addresses different tags', () => {
    expect(maskAddress('203.0.113.77', SALT)).toBe(maskAddress(' 203.0.113.77 ', SALT));
    expect(maskAddress('203.0.113.77', SALT)).not.toBe(maskAddress('203.0.113.78', SALT));
  });

  it('counts the X-Forwarded-For entries and reports missing headers as null', () => {
    const out = describeForwarding(request({ 'x-forwarded-for': '198.51.100.23, 10.0.0.1, 203.0.113.77' }), SALT);
    expect(out.xffCount).toBe(3);
    expect(out.xRealIp).toBeNull();
    expect(out.trueClientIp).toBeNull();
    expect(out.forwarded).toBe(false);
    expect(describeForwarding(request({}), SALT).xffCount).toBe(0);
  });
});
