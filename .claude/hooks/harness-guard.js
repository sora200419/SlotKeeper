#!/usr/bin/env node
// Harness 闸门（PreToolUse）：拦截高危 Shell 命令、.env 写入、硬编码密钥。
//   deny = 硬拦截，Claude 无法执行；ask = 弹出确认，由用户拍板；无输出 = 走正常权限流程。
// 这是基于规则的护栏，挡的是"幻觉式误操作"，不是沙箱：变量拼接、脚本文件间接执行等仍可能绕过。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROTECTED_BRANCHES = ['main', 'master'];
// 递归删除这些可再生目录时不打扰用户
const SAFE_ARTIFACT_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache',
  '.parcel-cache', 'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'tmp', '.tmp',
]);
const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'srm', 'remove-item', 'ri']);
const WRITE_PROGRAMS = new Set([
  'cp', 'mv', 'tee', 'truncate', 'install', 'ln', 'touch', 'copy', 'move', 'ren', 'rename',
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni',
  'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni',
]);
const INPLACE_EDITORS = new Set(['sed', 'perl']);
const DB_CLIENTS = new Set([
  'psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'mongo', 'mongosh', 'redis-cli',
  'clickhouse-client', 'cockroach', 'duckdb', 'sqlplus', 'isql',
]);
const WRAPPERS = new Set([
  'sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'builtin', 'env', 'xargs', 'nice', 'timeout',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '}', '!', 'call', 'start',
]);
const IS_WIN = process.platform === 'win32';

// ---------- 通用判定 ----------

function baseName(p) {
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

function isEnvFile(p) {
  const b = baseName(p).toLowerCase();
  if (!/^\.env(\.[\w.-]+)?$/.test(b)) return false;
  return !/\.(example|sample|template|dist|defaults?)$/.test(b);
}

function isHarnessFile(p) {
  const n = String(p).replace(/\\/g, '/');
  return /(^|\/)\.claude\/settings(\.local)?\.json$/.test(n)
    || /(^|\/)\.claude\/hooks(\/|$)/.test(n)
    || /(^|\/)githooks(\/|$)/.test(n);
}

function loadSecretPatterns() {
  try {
    return fs.readFileSync(path.join(__dirname, 'harness-secret-patterns.txt'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => new RegExp(l));
  } catch {
    return [];
  }
}

function findSecret(text) {
  if (!text) return null;
  for (const re of loadSecretPatterns()) {
    const m = String(text).match(re);
    if (m) return m[0].slice(0, 12) + '…';
  }
  return null;
}

// 把路径统一成可比较的绝对路径；Git Bash 的 /c/xxx 视为 C:/xxx
function normalizePath(p, cwd) {
  let s = String(p).replace(/\\/g, '/');
  if (IS_WIN && /^\/[a-z](\/|$)/i.test(s)) s = s[1] + ':' + (s.slice(2) || '/');
  let abs = path.resolve(cwd || process.cwd(), s).replace(/\\/g, '/');
  if (abs.length > 1) abs = abs.replace(/\/+$/, '');
  return IS_WIN ? abs.toLowerCase() : abs;
}

function isCatastrophicTarget(t, cwd) {
  const s = String(t).trim().replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  if (!s) return false;
  const lower = s.toLowerCase();
  const homeLike = /^(~|\$home|\$\{home\}|\$env:userprofile|\$env:homepath|%userprofile%|%homepath%)$/;
  if (['/', '*', '.', '..', '.*', '/*', './*', '../*'].includes(s)) return true;
  if (homeLike.test(lower) || homeLike.test(lower.replace(/\/\*?$/, ''))) return true;
  if (/^[a-z]:\/?\*?$/i.test(s)) return true; // C:  C:/  C:/*
  if (/^(\/mnt)?\/[a-z]\/?\*?$/i.test(s)) return true; // /c  /c/*  /mnt/c
  if (/(^|\/)\.git$/.test(s)) return true; // 仓库历史
  if (/^(\/|[a-z]:\/|\/[a-z]\/)(usr|etc|bin|sbin|lib|lib64|var|opt|boot|home|root|users|windows|program files|program files \(x86\)|programdata|system|library|applications)(\/\*)?$/i.test(s)) return true;
  // 目标等于当前目录或其祖先目录（例如项目根、用户主目录）
  if (cwd && !/[*?$%~]/.test(s)) {
    const abs = normalizePath(s, cwd);
    const here = normalizePath(cwd, cwd);
    if (here === abs || here.startsWith(abs.endsWith('/') ? abs : abs + '/')) return true;
  }
  return false;
}

function isSafeArtifact(t) {
  const s = String(t).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s || /[*?$%~]/.test(s) || s.startsWith('/') || /^[a-z]:/i.test(s)) return false;
  const parts = s.split('/').filter((x) => x && x !== '.');
  return parts.length > 0 && !parts.includes('..') && SAFE_ARTIFACT_DIRS.has(parts[parts.length - 1]);
}

// ---------- Shell 命令切分 ----------

// 切成"命令段"（按 ; && || | & 换行 括号 反引号），每段是去掉引号后的 token 列表。
// 重定向符 > / >> 作为独立 token 保留，便于识别写入目标。
function splitSegments(cmd, shell) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let inTok = false;
  let quote = null;
  const esc = shell === 'powershell' ? '`' : '\\';
  const pushTok = () => {
    if (inTok) tokens.push(cur);
    cur = '';
    inTok = false;
  };
  const pushSeg = () => {
    pushTok();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      // bash 双引号内的 \ 只转义 $ ` " \ 换行；Windows 路径里的 \ 要原样保留
      else if (c === esc && quote === '"' && i + 1 < cmd.length && (shell === 'powershell' || '$`"\\\n'.includes(cmd[i + 1]))) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inTok = true;
    } else if (c === esc && i + 1 < cmd.length) {
      if (cmd[i + 1] !== '\n') {
        cur += cmd[i + 1];
        inTok = true;
      }
      i++;
    } else if (c === '>') {
      pushTok();
      let op = '>';
      if (cmd[i + 1] === '>') { op = '>>'; i++; }
      if (cmd[i + 1] === '&') { // 2>&1 之类，不是写文件
        i++;
        while (/\d|-/.test(cmd[i + 1] || '')) i++;
        continue;
      }
      if (tokens.length && /^\d$/.test(tokens[tokens.length - 1])) tokens.pop();
      tokens.push(op);
    } else if (c === '<') {
      pushTok();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || (c === '`' && shell !== 'powershell')) {
      if (c === '(' && cur === '$') { cur = ''; inTok = false; }
      pushSeg();
    } else if (/\s/.test(c)) {
      pushTok();
    } else {
      cur += c;
      inTok = true;
    }
  }
  pushSeg();
  return segments;
}

function stripWrappers(tokens) {
  let i = 0;
  let afterWrapper = false;
  while (i < tokens.length) {
    const t = tokens[i];
    const low = t.toLowerCase();
    if (WRAPPERS.has(low)) { afterWrapper = true; i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (afterWrapper && (/^-/.test(t) || /^\d+[smhd]?$/.test(t))) { i++; continue; }
    break;
  }
  return tokens.slice(i);
}

function programName(tok) {
  return baseName(tok).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

// ---------- 规则 ----------

function checkDelete(prog, args, cwd, out) {
  const isCmdStyle = ['rd', 'rmdir', 'del', 'erase'].includes(prog);
  const valueFlags = new Set(['-include', '-exclude', '-filter', '-credential', '-stream', '-erroraction', '-ea', '-warningaction', '-wa']);
  const targets = [];
  let recursive = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const low = a.toLowerCase();
    if (valueFlags.has(low)) { i++; continue; }
    if (low === '--recursive' || /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(a) || (/^-[a-z]{1,4}$/i.test(a) && /r/i.test(a))) {
      recursive = true;
      continue;
    }
    if (isCmdStyle && /^\/s$/i.test(a)) { recursive = true; continue; }
    if (/^-/.test(a) || (isCmdStyle && /^\/[a-z]$/i.test(a))) continue;
    targets.push(a);
  }
  const bad = targets.find((t) => isCatastrophicTarget(t, cwd));
  if (bad) return out.deny(`删除目标 "${bad}" 是根目录 / 主目录 / 项目目录 / .git 等不可恢复的位置。`);
  const env = targets.find(isEnvFile);
  if (env) return out.deny(`不允许 AI 删除环境变量文件 "${env}"。`);
  const harness = targets.find(isHarnessFile);
  if (harness) return out.ask(`将删除 Harness 闸门文件 "${harness}"，这会削弱安全机制。`);
  if (recursive && !(targets.length && targets.every(isSafeArtifact))) {
    return out.ask(`递归删除：${targets.join(' ') || '(未识别目标)'}。删除后无法从回收站恢复。`);
  }
}

function checkWrites(prog, args, tokens, out) {
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i] === '>' || tokens[i] === '>>') && tokens[i + 1]) {
      const t = tokens[i + 1];
      if (isEnvFile(t)) out.deny(`不允许 AI 通过重定向写入环境变量文件 "${t}"。`);
      else if (isHarnessFile(t)) out.ask(`将改写 Harness 闸门文件 "${t}"。`);
    }
  }
  const inplace = INPLACE_EDITORS.has(prog) && args.some((a) => /^-i/.test(a) || a === '--in-place');
  if (!WRITE_PROGRAMS.has(prog) && !inplace) return;
  const env = args.find(isEnvFile);
  if (env) return out.deny(`不允许 AI 用 ${prog} 修改、移动或复制环境变量文件 "${env}"。需要改 .env 请让用户亲自操作。`);
  const harness = args.find(isHarnessFile);
  if (harness) out.ask(`将用 ${prog} 改动 Harness 闸门文件 "${harness}"。`);
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd || '.', 'branch', '--show-current'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function checkGit(args, cwd, out) {
  // 跳过 git 全局参数，找到子命令
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-c' && /core\.hookspath/i.test(args[i + 1] || '')) {
      return out.deny('git -c core.hooksPath=... 会临时绕过 Git 闸门。');
    }
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a) ? 2 : 1;
  }
  const sub = (args[i] || '').toLowerCase();
  const rest = args.slice(i + 1);
  const has = (...flags) => rest.some((a) => flags.includes(a));

  if (rest.includes('--no-verify') && ['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert', 'pull'].includes(sub)) {
    return out.deny('--no-verify 会跳过 Git 闸门（pre-commit / pre-push）。');
  }

  switch (sub) {
    case 'push': return checkGitPush(rest, cwd, out);
    case 'commit': {
      const valueFlags = new Set(['-m', '-F', '-C', '-c', '-t', '--author', '--date', '--message', '--file', '--template']);
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (valueFlags.has(a)) { j++; continue; }
        if (/^-[a-zA-Z]+$/.test(a)) {
          if (a.includes('n')) return out.deny('git commit -n 等同于 --no-verify，会跳过 pre-commit 闸门。');
          if (/[mFCct]$/.test(a)) j++; // 形如 -am "msg"，下一个 token 是参数值
        }
      }
      return;
    }
    case 'reset':
      if (has('--hard')) out.ask('git reset --hard 会丢弃所有未提交的修改，无法恢复。');
      return;
    case 'clean':
      if (!has('-n', '--dry-run') && rest.some((a) => a === '--force' || /^-[a-zA-Z]*f/.test(a))) {
        out.ask('git clean -f 会永久删除未跟踪文件。');
      }
      return;
    case 'checkout':
      if (rest.includes('--') || rest.includes('.') || has('-f', '--force')) {
        out.ask('git checkout 这种用法会丢弃工作区修改。');
      }
      return;
    case 'restore':
      if (!(has('--staged', '-S') && !has('--worktree', '-W'))) out.ask('git restore 会丢弃工作区修改。');
      return;
    case 'branch':
      if (has('-D') || (has('-d', '--delete') && has('-f', '--force'))) out.ask('强制删除分支，未合并的提交可能丢失。');
      return;
    case 'stash':
      if (['drop', 'clear'].includes((rest[0] || '').toLowerCase())) out.ask(`git stash ${rest[0]} 会永久丢弃暂存内容。`);
      return;
    case 'filter-branch':
    case 'filter-repo':
      out.ask(`git ${sub} 会改写整个仓库历史。`);
      return;
    case 'reflog':
      if ((rest[0] || '').toLowerCase() === 'expire') out.ask('git reflog expire 会清除恢复丢失提交的最后线索。');
      return;
    case 'gc':
      if (rest.some((a) => /^--prune=now$/i.test(a))) out.ask('git gc --prune=now 会立即清除不可达对象。');
      return;
    case 'update-ref':
      if (has('-d')) out.ask('git update-ref -d 会直接删除引用。');
      return;
    case 'config': {
      const k = rest.findIndex((a) => /^core\.hookspath$/i.test(a));
      const reading = has('--get', '--list', '-l');
      if (k !== -1 && !reading && (has('--unset', '--unset-all') || rest[k + 1] !== undefined)) {
        out.ask('修改 core.hooksPath 会改变或关闭 Git 闸门。');
      }
      return;
    }
    default:
  }
}

function checkGitPush(rest, cwd, out) {
  const valueFlags = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
  const positional = [];
  let force = false;
  let del = false;
  let mirror = false;
  let all = false;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (valueFlags.has(a)) { j++; continue; }
    if (a === '--force' || a.startsWith('--force-with-lease') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) force = true;
    else if (a === '--delete' || a === '-d') del = true;
    else if (a === '--mirror') mirror = true;
    else if (a === '--all' || a === '--branches') all = true;
    else if (!a.startsWith('-')) positional.push(a);
  }
  const refspecs = positional.slice(1);
  if (refspecs.some((r) => r.startsWith('+'))) force = true;
  const dests = [];
  const deleted = [];
  for (const r of refspecs) {
    const spec = r.replace(/^\+/, '');
    const dst = (spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec).replace(/^refs\/heads\//, '');
    const resolved = dst === 'HEAD' ? currentBranch(cwd) : dst;
    if (spec.startsWith(':') || del) deleted.push(resolved);
    else dests.push(resolved);
  }
  const isProtected = (b) => b && PROTECTED_BRANCHES.includes(b);

  if (deleted.some(isProtected)) return out.deny(`禁止删除受保护分支（${PROTECTED_BRANCHES.join('/')}）。`);
  if (deleted.length) return out.ask(`将删除远端分支：${deleted.join(', ')}。`);
  if (mirror) return out.deny('git push --mirror 会用本地状态覆盖远端全部引用（含受保护分支）。');
  if (!force) return;
  if (all || dests.some(isProtected)) return out.deny(`禁止强推受保护分支（${PROTECTED_BRANCHES.join('/')}）。`);
  if (refspecs.length === 0) {
    const b = currentBranch(cwd);
    if (isProtected(b)) return out.deny(`当前分支是受保护分支 ${b}，禁止强推。`);
    if (!b) return out.ask('强推，且无法确定目标分支。');
  }
  out.ask(`强推会覆盖远端历史：${dests.join(', ') || currentBranch(cwd) || '当前分支'}。`);
}

function checkDatabase(segments, raw, out) {
  const progs = segments.map((s) => programName(stripWrappers(s)[0] || ''));
  if (progs.includes('dropdb')) return out.deny('dropdb 会删除整个数据库。');
  if (progs.includes('mysqladmin') && /\bdrop\b/i.test(raw)) return out.deny('mysqladmin drop 会删除整个数据库。');
  if (/\b(prisma\s+migrate\s+reset|db:drop|db:reset|migrate:fresh|migrate:reset|manage\.py\s+flush|--force-reset)\b/i.test(raw)) {
    out.ask('这条命令会清空 / 重建数据库。');
  }
  if (!progs.some((p) => DB_CLIENTS.has(p))) return;
  if (/\bdrop\s+(database|schema)\b|\.dropDatabase\s*\(/i.test(raw)) return out.deny('DROP DATABASE / SCHEMA 会删除整个库。');
  if (/\bdrop\s+table\b|\btruncate\b|\bflushall\b|\bflushdb\b/i.test(raw)) out.ask('将删除或清空数据表 / 缓存数据。');
  if (/\bdelete\s+from\s+[\w."`[\]]+\s*(;|$|"|')/im.test(raw)) out.ask('DELETE FROM 没有 WHERE 条件，会删除整张表的数据。');
}

function analyzeCommand(cmd, shell, cwd, out, depth = 0) {
  if (!cmd || depth > 3) return;
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd)) return out.deny('检测到 fork 炸弹。');
  if (/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/i.test(cmd)) {
    out.ask('下载远程脚本并直接执行，内容未经审查。');
  }
  const segments = splitSegments(cmd, shell);
  checkDatabase(segments, cmd, out);
  for (const seg of segments) {
    const tokens = stripWrappers(seg);
    if (!tokens.length) continue;
    const prog = programName(tokens[0]);
    const args = tokens.slice(1);

    // 嵌套执行：bash -c "..." / powershell -Command "..." / cmd /c ... / eval / iex
    if (['bash', 'sh', 'zsh', 'dash'].includes(prog)) {
      const k = args.findIndex((a) => a === '-c' || /^-[a-z]*c$/.test(a));
      if (k !== -1 && args[k + 1]) analyzeCommand(args[k + 1], 'bash', cwd, out, depth + 1);
    } else if (['powershell', 'pwsh'].includes(prog)) {
      const k = args.findIndex((a) => /^-(c|command)$/i.test(a));
      if (k !== -1) analyzeCommand(args.slice(k + 1).join(' '), 'powershell', cwd, out, depth + 1);
    } else if (prog === 'cmd') {
      const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
      if (k !== -1) analyzeCommand(args.slice(k + 1).join(' '), 'powershell', cwd, out, depth + 1);
    } else if (['eval', 'iex', 'invoke-expression'].includes(prog)) {
      analyzeCommand(args.join(' '), shell, cwd, out, depth + 1);
    }

    if (/^mkfs/.test(prog) || ['diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition'].includes(prog)) {
      out.deny(`${prog} 会格式化或清空磁盘。`);
    }
    if (prog === 'format' && args.some((a) => /^[a-z]:$/i.test(a))) out.deny('format 会格式化磁盘分区。');
    if (prog === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) out.deny('dd 写入块设备会抹掉磁盘数据。');
    if (prog === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir') && /\brm\b|-delete/.test(args.join(' '))) {
      out.ask('find 批量删除文件。');
    }
    if (DELETE_PROGRAMS.has(prog)) checkDelete(prog, args, cwd, out);
    if (prog === 'git') checkGit(args, cwd, out);
    checkWrites(prog, args, tokens, out);
  }
}

function analyzeFileTool(input, out) {
  const p = input.file_path || input.notebook_path || input.path || '';
  if (isEnvFile(p)) return out.deny(`不允许 AI 修改环境变量文件 "${baseName(p)}"。需要新增变量时，改 .env.example 并请用户自己填 .env。`);
  const content = [input.content, input.new_string, input.new_source]
    .concat((input.edits || []).map((e) => e && e.new_string))
    .filter(Boolean)
    .join('\n');
  const secret = findSecret(content);
  if (secret) return out.deny(`写入内容疑似包含硬编码密钥（${secret}）。请改为读取环境变量，并在 .env.example 中放占位符。`);
  if (isHarnessFile(p)) out.ask(`将修改 Harness 闸门文件 "${p}"，这会改变安全机制本身。`);
}

// ---------- 入口 ----------

function decide(payload) {
  const findings = { deny: [], ask: [] };
  const out = {
    deny: (r) => { findings.deny.push(r); },
    ask: (r) => { findings.ask.push(r); },
  };
  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();
  if (tool === 'Bash' || tool === 'PowerShell') {
    analyzeCommand(String(input.command || ''), tool === 'PowerShell' ? 'powershell' : 'bash', cwd, out);
  } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    analyzeFileTool(input, out);
  }
  if (findings.deny.length) return { decision: 'deny', reasons: findings.deny };
  if (findings.ask.length) return { decision: 'ask', reasons: findings.ask };
  return { decision: 'allow', reasons: [] };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      process.stderr.write('[Harness 闸门] 无法解析 Hook 输入，按安全原则拦截。\n');
      process.exit(2);
    }
    const { decision, reasons } = decide(payload);
    if (decision === 'allow') process.exit(0);
    const reason = decision === 'deny'
      ? `[Harness 闸门·硬拦截] ${reasons.join(' ')} 不要换写法绕过；向用户说明情况，如确有必要请用户亲自在终端执行。`
      : `[Harness 闸门·需确认] ${reasons.join(' ')}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { decide, splitSegments, isEnvFile, isCatastrophicTarget, findSecret };
