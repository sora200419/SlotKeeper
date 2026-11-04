#!/usr/bin/env node
// Harness ledger check: keeps CLAUDE.md from bloating and every rule traceable to a real mishap.
//   node .claude/harness/lint.js            checks ./CLAUDE.md (each rule needs an F-number that exists in FAILURES.md)
//   node .claude/harness/lint.js --global   checks ~/.claude/CLAUDE.md (each rule needs a source)
//   node .claude/harness/lint.js <file>     checks the given file
// Exits with code 1 when there are errors (the pre-commit hook then blocks the commit).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITS = {
  fileLinesWarn: 150,
  fileLinesError: 250,
  rulesWarn: 20,
  rulesError: 30,
  // The same two sentences take 2-3 times as many characters in English as in Chinese.
  ruleChars: 200,
  ruleCharsLatin: 450,
  reviewAfterDays: 90,
};

// Ledger headings. The Chinese ones are kept so ledgers written before the English rename still pass.
const TITLES = {
  project: ['Mishaps and Prevention Rules', '错题与防范规程'],
  global: ['Global Mishap Ledger', '全局错题集'],
};

function parseArgs(argv) {
  const global = argv.includes('--global');
  const fileArg = argv.find((a) => !a.startsWith('--'));
  const file = fileArg
    ? path.resolve(fileArg)
    : global
      ? path.join(os.homedir(), '.claude', 'CLAUDE.md')
      : path.resolve('CLAUDE.md');
  return { global, file };
}

// The lines under a top-level heading, up to the next top-level heading.
function section(lines, title) {
  const start = lines.findIndex((l) => l.trim() === `# ${title}`);
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^# /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).map((text, i) => ({ text, line: start + 2 + i }));
}

function lint({ global, file }) {
  const errors = [];
  const warnings = [];
  const infos = [];
  if (!fs.existsSync(file)) {
    errors.push(`Cannot find ${file}`);
    return { errors, warnings, infos, rules: 0 };
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rel = path.basename(file);

  if (lines.length > LIMITS.fileLinesError) errors.push(`${rel} has ${lines.length} lines, over the limit of ${LIMITS.fileLinesError}. Run harness-prune to trim it.`);
  else if (lines.length > LIMITS.fileLinesWarn) warnings.push(`${rel} has ${lines.length} lines, close to the limit; consider trimming it.`);

  const titles = global ? TITLES.global : TITLES.project;
  const body = titles.map((t) => section(lines, t)).find(Boolean);
  if (!body) {
    errors.push(`${rel} is missing the top-level heading "# ${titles[0]}".`);
    return { errors, warnings, infos, rules: 0 };
  }

  const rules = body.filter((l) => /^\s*-\s+/.test(l.text));
  if (rules.length > LIMITS.rulesError) errors.push(`${rules.length} rules, over the limit of ${LIMITS.rulesError}. Merge, automate or delete rules before adding new ones.`);
  else if (rules.length > LIMITS.rulesWarn) warnings.push(`${rules.length} rules, close to the limit of ${LIMITS.rulesError}; run harness-prune soon.`);

  let failures = null;
  if (!global) {
    const fp = path.join(path.dirname(file), 'FAILURES.md');
    failures = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
    if (failures === null && rules.length) errors.push('Cannot find FAILURES.md next to it, so rules cannot be traced to their source.');
  }

  const seenIds = new Map();
  const now = Date.now();
  for (const { text, line } of rules) {
    const where = `${rel}:${line}`;
    const m = text.match(/^\s*-\s+\*\*\[(\d{4}-\d{2}-\d{2})\]\s*(.+?)\*\*\s*[:：]\s*(.+)$/);
    if (!m) {
      errors.push(`${where} should look like "- **[YYYY-MM-DD] Title**: rule. (source)"`);
      continue;
    }
    const [, date, , rule] = m;
    // A rule counts as Chinese when a fifth of it is Chinese, so an English rule quoting one word keeps the English limit.
    const cjk = (rule.match(/[一-鿿]/g) || []).length;
    const maxChars = cjk * 5 >= rule.length ? LIMITS.ruleChars : LIMITS.ruleCharsLatin;
    if (text.length > maxChars) warnings.push(`${where} rule is too long (${text.length} characters); keep it to 2 sentences.`);
    const sentences = rule.replace(/\([^)]*\)|（[^）]*）|`[^`]*`/g, '').split(/[。！？!?]|\.\s/).filter((s) => s.trim()).length;
    if (sentences > 2) warnings.push(`${where} has more than 2 sentences; keep only "trigger → required action".`);

    if (global) {
      if (!/(来源|Source)\s*[:：]/.test(text)) errors.push(`${where} has no source; use "(Source: project F-number)".`);
    } else {
      const ids = text.match(/\bF-\d{3,}\b/g) || [];
      if (!ids.length) errors.push(`${where} has no F-number, so it cannot say which real mishap it prevents.`);
      for (const id of ids) {
        if (failures !== null && !new RegExp(`###\\s+${id}\\b`).test(failures)) errors.push(`${where} cites ${id}, which is not in FAILURES.md.`);
        if (seenIds.has(id)) warnings.push(`${where} cites the same ${id} as line ${seenIds.get(id)}; consider merging them.`);
        seenIds.set(id, line);
      }
    }
    const age = (now - Date.parse(date)) / 86400000;
    if (age > LIMITS.reviewAfterDays) infos.push(`${where} is ${Math.floor(age)} days old; at review, confirm it still prevents a real mishap.`);
  }
  return { errors, warnings, infos, rules: rules.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { errors, warnings, infos, rules } = lint(opts);
  const label = opts.global ? 'global ledger' : 'project ledger';
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const i of infos) console.log(`  · ${i}`);
  console.log(`[Harness lint] ${label} ${opts.file}: ${rules} rules, ${errors.length} errors, ${warnings.length} warnings.`);
  process.exit(errors.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { lint, LIMITS, TITLES };
