import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const paypalDir = fileURLToPath(new URL('../../lib/paypal/', import.meta.url));

describe('server-only guard', () => {
  it('marks every PayPal module as server-only, so the secret can never reach a client bundle', () => {
    const modules = readdirSync(paypalDir, { recursive: true, encoding: 'utf8' })
      .map((name) => name.replaceAll('\\', '/'))
      .filter((name) => /\.tsx?$/.test(name));
    expect(modules.length).toBeGreaterThan(0);
    for (const name of modules) {
      const firstLine = readFileSync(paypalDir + name, 'utf8').split(/\r?\n/, 1)[0];
      expect(firstLine, `lib/paypal/${name}`).toBe("import 'server-only';");
    }
  });

  it('throws when resolved outside a server build (what a client bundle would hit)', () => {
    // Plain Node resolution, bypassing the test-only alias in vitest.config.mts.
    const require = createRequire(import.meta.url);
    expect(() => require('server-only')).toThrow(/Client Component/);
  });
});
