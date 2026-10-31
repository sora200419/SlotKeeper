import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production build', () => {
  it('uses webpack: Turbopack needs far more memory than Render allows a build (F-013)', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { build: string } };
    expect(scripts.build).toContain('--webpack');
  });
});
