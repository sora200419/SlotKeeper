// Git 闸门端到端测试：在临时仓库里真实执行 commit / push，验证 githooks/ 的拦截效果。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const HOOKS_DIR = path.join(ROOT, 'githooks');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-githooks-'));
const work = path.join(tmp, 'work');
const remote = path.join(tmp, 'remote.git');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(args, cwd = work) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
function mustGit(args, cwd) {
  const r = git(args, cwd);
  assert.ok(r.ok, `git ${args.join(' ')} 失败：\n${r.out}`);
  return r;
}
function write(rel, content) {
  const p = path.join(work, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function commit(files, msg) {
  mustGit(['add', '--', ...files]);
  return git(['commit', '-q', '-m', msg]);
}

const LEDGER = '# 项目\n\n# 错题与防范规程\n- **[2026-10-20] 示例**：改配置前先读 README。(F-001)\n';
const FAILURES = '# 翻车档案\n\n### F-001 · 2026-10-20 · 示例\n- **现象**：x\n';

test.before(() => {
  for (const f of fs.readdirSync(HOOKS_DIR)) fs.chmodSync(path.join(HOOKS_DIR, f), 0o755);
  mustGit(['init', '-q', '--bare', '-b', 'main', remote], tmp);
  mustGit(['init', '-q', '-b', 'main', work], tmp);
  for (const [k, v] of [['user.name', 'harness-test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', HOOKS_DIR]]) {
    mustGit(['config', k, v]);
  }
  // 模拟一个由脚手架生成的项目：带密钥特征库与账本体检
  for (const rel of ['.claude/hooks/harness-secret-patterns.txt', '.claude/harness/lint.js']) {
    write(rel, fs.readFileSync(path.join(ROOT, rel)));
  }
  write('CLAUDE.md', LEDGER);
  write('FAILURES.md', FAILURES);
  write('README.md', 'hello\n');
  assert.ok(commit(['.'], 'init').ok);
  mustGit(['remote', 'add', 'origin', remote]);
});

test('pre-commit：普通文件正常提交', () => {
  write('src/app.js', 'module.exports = 1;\n');
  assert.ok(commit(['src/app.js'], 'add app').ok);
});

test('pre-commit：拦截 .env，放行 .env.example', () => {
  write('.env', 'SECRET=1\n');
  const r = commit(['.env'], 'oops');
  assert.ok(!r.ok);
  assert.match(r.out, /\.env/);
  mustGit(['rm', '-q', '--cached', '.env']);
  fs.rmSync(path.join(work, '.env'));

  write('.env.example', 'SECRET=\n');
  assert.ok(commit(['.env.example'], 'env example').ok);
});

test('pre-commit：拦截硬编码密钥', () => {
  write('src/aws.js', `const key = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}";\n`);
  const r = commit(['src/aws.js'], 'key');
  assert.ok(!r.ok);
  assert.match(r.out, /密钥/);
  write('src/aws.js', 'const key = process.env.AWS_ACCESS_KEY_ID;\n');
  assert.ok(commit(['src/aws.js'], 'env key').ok);
});

test('pre-commit：拦截删除 Harness 关键文件', () => {
  mustGit(['rm', '-q', 'FAILURES.md']);
  const r = git(['commit', '-q', '-m', 'rm ledger']);
  assert.ok(!r.ok);
  assert.match(r.out, /关键文件/);
  mustGit(['reset', '-q', 'HEAD', '--', 'FAILURES.md']);
  mustGit(['checkout', '--', 'FAILURES.md']);
});

test('pre-commit：账本规则缺少出处时拦截', () => {
  write('CLAUDE.md', `${LEDGER}- **[2026-10-20] 无出处**：随手写的规则。\n`);
  const r = commit(['CLAUDE.md'], 'bad rule');
  assert.ok(!r.ok);
  assert.match(r.out, /F-编号/);
  write('CLAUDE.md', LEDGER);
  mustGit(['add', 'CLAUDE.md']);
});

test('pre-push：允许快进推送受保护分支', () => {
  assert.ok(git(['push', '-q', 'origin', 'main']).ok);
  write('b.txt', 'b\n');
  assert.ok(commit(['b.txt'], 'b').ok);
  assert.ok(git(['push', '-q', 'origin', 'main']).ok);
});

test('pre-push：拦截强推受保护分支', () => {
  write('b.txt', 'b2\n');
  mustGit(['add', 'b.txt']);
  mustGit(['commit', '-q', '--amend', '-m', 'b amended']);
  const r = git(['push', '-q', '--force', 'origin', 'main']);
  assert.ok(!r.ok);
  assert.match(r.out, /强推/);
});

test('pre-push：功能分支允许强推（AI 侧由 Claude 闸门要求确认）', () => {
  mustGit(['checkout', '-q', '-b', 'feature']);
  assert.ok(git(['push', '-q', 'origin', 'feature']).ok);
  write('c.txt', 'c\n');
  mustGit(['add', 'c.txt']);
  mustGit(['commit', '-q', '--amend', '-m', 'feature amended']);
  assert.ok(git(['push', '-q', '--force', 'origin', 'feature']).ok);
});

test('pre-push：拦截删除受保护分支', () => {
  const r = git(['push', '-q', 'origin', '--delete', 'main']);
  assert.ok(!r.ok);
  assert.match(r.out, /删除受保护分支/);
});
