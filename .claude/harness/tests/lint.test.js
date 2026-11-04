// Ledger lint: the English headings and the older Chinese ones are both accepted, and a missing heading still fails.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lint } = require('../lint.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lint-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const RULE = '- **[2026-10-20] Example**: read the README before changing config. (F-001)';
const FAILURES = '# Failures\n\n### F-001 · 2026-10-20 · Example\n';

function project(name, ledger) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), ledger);
  fs.writeFileSync(path.join(dir, 'FAILURES.md'), FAILURES);
  return lint({ global: false, file: path.join(dir, 'CLAUDE.md') });
}

test('accepts the English project heading and checks its rules', () => {
  const r = project('en', `# Project\n\n# Mishaps and Prevention Rules\n${RULE}\n`);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.rules, 1);
});

test('still accepts the older Chinese project heading', () => {
  const r = project('zh', `# Project\n\n# 错题与防范规程\n${RULE}\n`);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.rules, 1);
});

test('rules under the English heading are still checked for an F-number', () => {
  const r = project('bad', '# Project\n\n# Mishaps and Prevention Rules\n- **[2026-10-20] No source**: a rule.\n');
  assert.match(r.errors.join('\n'), /has no F-number/);
});

test('fails when neither heading is present', () => {
  const r = project('none', `# Project\n\n## Rules\n${RULE}\n`);
  assert.match(r.errors.join('\n'), /missing the top-level heading "# Mishaps and Prevention Rules"/);
});

test('global ledger: either heading, and either source tag', () => {
  const file = path.join(tmp, 'global.md');
  for (const [heading, source] of [['Global Mishap Ledger', 'Source'], ['全局错题集', '来源']]) {
    fs.writeFileSync(file, `# Global\n\n# ${heading}\n- **[2026-10-20] Example**: a rule. (${source}: PayPal F-001)\n`);
    assert.deepStrictEqual(lint({ global: true, file }).errors, [], heading);
  }
  fs.writeFileSync(file, '# Global\n\n# Global Mishap Ledger\n- **[2026-10-20] Example**: a rule.\n');
  assert.match(lint({ global: true, file }).errors.join('\n'), /has no source/);
});

test('rule length: 200 characters for Chinese rules, 450 for English ones', () => {
  const file = path.join(tmp, 'length.md');
  const check = (rule) => {
    fs.writeFileSync(file, `# Global\n\n# Global Mishap Ledger\n- **[2026-10-20] Example**: ${rule} (Source: PayPal F-001)\n`);
    return lint({ global: true, file }).warnings.some((w) => /too long/.test(w));
  };
  assert.strictEqual(check(`${'a'.repeat(300)}.`), false);
  assert.strictEqual(check(`${'a'.repeat(460)}.`), true);
  assert.strictEqual(check(`${'规'.repeat(190)}。`), true);
  assert.strictEqual(check(`${'规'.repeat(120)}。`), false);
  // An English rule that quotes one Chinese word is still an English rule.
  assert.strictEqual(check(`Do not say "已完成" early ${'a'.repeat(300)}.`), false);
});
