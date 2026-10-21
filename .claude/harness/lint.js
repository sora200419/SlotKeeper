#!/usr/bin/env node
// Harness 账本体检：防止 CLAUDE.md 膨胀、规则失去出处。
//   node .claude/harness/lint.js            检查项目 ./CLAUDE.md（规则须带 F-编号，且在 FAILURES.md 中存在）
//   node .claude/harness/lint.js --global   检查 ~/.claude/CLAUDE.md（规则须带"来源"）
//   node .claude/harness/lint.js <文件>      检查指定文件
// 有 error 时退出码为 1（pre-commit 会因此拦截提交）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITS = {
  fileLinesWarn: 150,
  fileLinesError: 250,
  rulesWarn: 20,
  rulesError: 30,
  ruleChars: 200,
  reviewAfterDays: 90,
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

// 取出某个一级标题下的内容（到下一个一级标题为止）
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
    errors.push(`找不到 ${file}`);
    return { errors, warnings, infos, rules: 0 };
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rel = path.basename(file);

  if (lines.length > LIMITS.fileLinesError) errors.push(`${rel} 共 ${lines.length} 行，超过上限 ${LIMITS.fileLinesError}。运行 harness-prune 精简。`);
  else if (lines.length > LIMITS.fileLinesWarn) warnings.push(`${rel} 共 ${lines.length} 行，接近上限，建议精简。`);

  const title = global ? '全局错题集' : '错题与防范规程';
  const body = section(lines, title);
  if (!body) {
    errors.push(`${rel} 缺少一级标题 "# ${title}"。`);
    return { errors, warnings, infos, rules: 0 };
  }

  const rules = body.filter((l) => /^\s*-\s+/.test(l.text));
  if (rules.length > LIMITS.rulesError) errors.push(`规则 ${rules.length} 条，超过上限 ${LIMITS.rulesError}。先合并 / 自动化 / 删除，再新增。`);
  else if (rules.length > LIMITS.rulesWarn) warnings.push(`规则 ${rules.length} 条，接近上限 ${LIMITS.rulesError}，建议近期运行 harness-prune。`);

  let failures = null;
  if (!global) {
    const fp = path.join(path.dirname(file), 'FAILURES.md');
    failures = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
    if (failures === null && rules.length) errors.push('找不到同目录下的 FAILURES.md，规则无法追溯出处。');
  }

  const seenIds = new Map();
  const now = Date.now();
  for (const { text, line } of rules) {
    const where = `${rel}:${line}`;
    const m = text.match(/^\s*-\s+\*\*\[(\d{4}-\d{2}-\d{2})\]\s*(.+?)\*\*\s*[:：]\s*(.+)$/);
    if (!m) {
      errors.push(`${where} 格式应为 "- **[YYYY-MM-DD] 标题**：规则。(出处)"`);
      continue;
    }
    const [, date, , rule] = m;
    if (text.length > LIMITS.ruleChars) warnings.push(`${where} 规则过长（${text.length} 字符），应压缩到 2 句以内。`);
    const sentences = rule.replace(/\([^)]*\)|（[^）]*）|`[^`]*`/g, '').split(/[。！？!?]|\.\s/).filter((s) => s.trim()).length;
    if (sentences > 2) warnings.push(`${where} 超过 2 句，应只保留"触发条件 → 必须动作"。`);

    if (global) {
      if (!/来源\s*[:：]/.test(text)) errors.push(`${where} 缺少出处，格式 "(来源: 项目名 F-编号)"。`);
    } else {
      const ids = text.match(/\bF-\d{3,}\b/g) || [];
      if (!ids.length) errors.push(`${where} 缺少 F-编号，回答不了"它防的是哪次真实翻车"。`);
      for (const id of ids) {
        if (failures !== null && !new RegExp(`###\\s+${id}\\b`).test(failures)) errors.push(`${where} 引用的 ${id} 在 FAILURES.md 中不存在。`);
        if (seenIds.has(id)) warnings.push(`${where} 与第 ${seenIds.get(id)} 行引用同一个 ${id}，考虑合并。`);
        seenIds.set(id, line);
      }
    }
    const age = (now - Date.parse(date)) / 86400000;
    if (age > LIMITS.reviewAfterDays) infos.push(`${where} 已 ${Math.floor(age)} 天，复审时确认它是否仍在防真实翻车。`);
  }
  return { errors, warnings, infos, rules: rules.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { errors, warnings, infos, rules } = lint(opts);
  const label = opts.global ? '全局账本' : '项目账本';
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const i of infos) console.log(`  · ${i}`);
  console.log(`[Harness lint] ${label} ${opts.file}：${rules} 条规则，${errors.length} 个错误，${warnings.length} 个警告。`);
  process.exit(errors.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { lint, LIMITS };
