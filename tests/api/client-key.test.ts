import { describe, expect, it } from 'vitest';
import { clientKey } from '@/lib/api/client-key';

const request = (headers: Record<string, string>) => new Request('https://example.test/api/mcp', { method: 'POST', headers });

describe('clientKey', () => {
  it('uses the address Cloudflare saw, not the changing last X-Forwarded-For hop', () => {
    const a = request({ 'cf-connecting-ip': '175.141.10.20', 'x-forwarded-for': '175.141.10.20, 104.23.1.9' });
    const b = request({ 'cf-connecting-ip': '175.141.10.20', 'x-forwarded-for': '175.141.10.20, 104.23.7.3' });
    expect(clientKey(a)).toBe('175.141.10.20');
    expect(clientKey(b)).toBe(clientKey(a));
  });

  it('trims the header and ignores an empty one', () => {
    expect(clientKey(request({ 'cf-connecting-ip': '  198.51.100.7 ' }))).toBe('198.51.100.7');
    expect(clientKey(request({ 'cf-connecting-ip': '   ', 'x-forwarded-for': '203.0.113.1' }))).toBe('203.0.113.1');
  });

  it('falls back to the last X-Forwarded-For entry, then to unknown', () => {
    expect(clientKey(request({ 'x-forwarded-for': '1.1.1.1, 203.0.113.1' }))).toBe('203.0.113.1');
    expect(clientKey(request({}))).toBe('unknown');
  });

  it('cuts a very long value so a key cannot be used to bloat the limiter map', () => {
    expect(clientKey(request({ 'cf-connecting-ip': 'a'.repeat(500) }))).toHaveLength(64);
    expect(clientKey(request({ 'x-forwarded-for': 'b'.repeat(500) }))).toHaveLength(64);
  });
});
