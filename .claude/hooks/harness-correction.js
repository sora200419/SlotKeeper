#!/usr/bin/env node
// Harness 纠错探测（UserPromptSubmit）：用户消息像是在纠正 AI 时，注入提醒，让 AI 修完后执行复盘入账。
// 只注入上下文、永不拦截；误判的代价只是一句可忽略的提醒。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PATTERNS = [
  /错了|搞错|弄错|写错|改错|看错|理解错|不对(?!称)|不是这样|不是我要的|不是让你|我说的是|我让你|谁让你|别再|又犯|又错|又忘|翻车|踩坑|漏了|没按|没有按|违反了|乱改|瞎改|白做|返工|回滚|撤销你/,
  /你把.{0,12}(删|弄坏|搞坏|改坏|覆盖)/,
  /\b(that'?s|this is|it'?s|you'?re) (wrong|incorrect|not right)\b/i,
  /\byou (broke|forgot|missed|deleted|ignored|skipped)\b/i,
  /\bnot what i (asked|wanted|meant)\b/i,
  /\bi (told|asked) you\b|\bwhy did you\b|\bdon'?t do that\b|\bstop doing\b/i,
];

// 全局层已安装时，项目层副本让位，避免同一条提醒注入两次
function shadowedByGlobal() {
  const globalCopy = path.join(os.homedir(), '.claude', 'hooks', 'harness', 'harness-correction.js');
  return path.resolve(__filename) !== path.resolve(globalCopy) && fs.existsSync(globalCopy);
}

function detect(prompt) {
  for (const re of PATTERNS) {
    const m = String(prompt || '').match(re);
    if (m) return m[0];
  }
  return null;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let prompt = '';
    try {
      prompt = JSON.parse(raw).prompt || '';
    } catch {
      process.exit(0);
    }
    const hit = detect(prompt);
    if (!hit || shadowedByGlobal()) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          `[Harness] 用户这条消息可能是在纠正你（命中「${hit}」）。先把问题修好并验证；` +
          '修完后执行 harness-postmortem 技能：分析根因 → 判定全局通用还是项目特有 → ' +
          '把一条不超过 2 句的防范规则写入对应账本，并把规则原文展示给用户。如果这条消息并非纠错，忽略本提示。',
      },
    }));
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { detect };
