import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('security headers', () => {
  it('sends them on every path and hides the framework header', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('/:path*');
    const headers = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
    expect(headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': expect.stringContaining('max-age='),
    });
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('never restricts scripts, frames or the opener that the PayPal SDK needs', async () => {
    const [{ headers }] = await nextConfig.headers!();
    const csp = headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    expect(csp).not.toMatch(/script-src|default-src|frame-src|form-action/);
    expect(headers.map((h) => h.key)).not.toContain('Cross-Origin-Opener-Policy');
  });
});

describe('production build', () => {
  it('uses webpack: Turbopack needs far more memory than Render allows a build (F-013)', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { build: string } };
    expect(scripts.build).toContain('--webpack');
  });
});
