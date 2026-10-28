# 翻车档案（FAILURES.md）

> 这里记录每次翻车的完整经过。本文件**不会**被自动加载进上下文（省 token）；
> `CLAUDE.md` 的《错题与防范规程》只保留一句话规则，并用 `F-编号` 指回这里。

## 条目格式

```markdown
### F-001 · YYYY-MM-DD · 一句话标题
- **现象**：用户看到了什么错误 / 哪一步出了问题
- **根因**：为什么当时会这样做（缺信息？错误假设？没验证？没读规则？）
- **修复**：怎么修的，对应提交或文件
- **规则去向**：项目 CLAUDE.md / 全局 ~/.claude/CLAUDE.md / 已自动化为 `<文件路径>`
- **复发记录**：无（复发一次就说明 Prompt 规则不够用，应改为自动化）
```

## 记录

### F-001 · 2026-10-24 · Bash heredoc 写多行文件反复解析失败
- **现象**：用 Bash 的 `cat > file <<'EOF' … EOF` 一次写入多个含引号、反引号、`${}` 的 TS/TSX 文件时，三次报 `unexpected EOF while looking for matching '`，整段脚本一行都没执行，只能返工改用文件工具重写。
- **根因**：错误假设——以为带引号定界符的 heredoc 在这个 Bash 工具里总是按字面处理；实际上长脚本里多段 heredoc 加嵌入的 python 片段会让外层解析出错，而且出错时整段都不执行。第一次失败后没有换方法，又重复了两次。
- **修复**：改用 Write / Edit 工具写入 `components/`、`app/book/`、`tests/paypal/deposits.test.ts` 等文件；Bash 只用来跑命令。
- **规则去向**：全局 ~/.claude/CLAUDE.md
- **复发记录**：无

### F-002 · 2026-10-25 · 原样重抛 SDK 错误导致鉴权头泄露到日志
- **现象**：OAuth 令牌请求遇到 TLS 拦截时，Next.js 把整个 axios 错误打印到开发服务器日志，包含 `Authorization: Basic <clientId:secret>`。复核又发现另一条路径：SDK 的 `ResponseValidationError` 没有被识别，原样抛出，同样携带鉴权头。
- **根因**：错误假设——以为 SDK 抛出的错误只有 ApiError 一种，且只要不是网络错误就"按原样抛出"是安全的。实际上 SDK 的错误对象会保留 request 及其鉴权头，而 Next.js 会完整打印错误对象。修第一条时没有追问还有哪些错误类型会走到同一个 `throw err` 分支。
- **修复**：`lib/paypal/errors.ts` 新增 `sanitizeError`（只保留名称和首行信息）；health、deposits、响应助手的所有兜底分支改用它；新增用例断言密钥不出现在返回值、堆栈、JSON 或 console 输出中。
- **规则去向**：全局 ~/.claude/CLAUDE.md
- **复发记录**：第二次（ResponseValidationError）在同一功能里被复核发现，因此规则改为全局并附测试要求。

### F-003 · 2026-10-26 · 资金动作"读 → await → 写回旧副本"导致并发丢写
- **现象**：裁判审查用并发复现证明：capture 与 void 同时执行时，void 的 4xx 分支写回 await 之前读到的旧 booking，PayPal 已扣款但记录仍是 `deposit_held` 且没有 capture；两笔退款同时执行时共用同一个 PayPal-Request-Id，并记录了错误金额。
- **根因**：错误假设——只考虑了单个请求内的幂等和重放，默认同一预约不会被同时操作；没有追问"await 期间别的请求改了这条记录会怎样"。
- **修复**：`lib/paypal/deposit-actions.ts` 加每个预约一把进程内锁 `withBookingLock`，在锁内读取预约；退款也校验 PayPal 返回金额；`tests/paypal/deposit-actions.test.ts` 新增并发用例。
- **规则去向**：全局 ~/.claude/CLAUDE.md
- **复发记录**：2026-10-26 提示词 4（同日）：webhook 处理器在锁外先读 PayPal 对象，等锁后再写入这份旧快照，乱序事件能把 COMPLETED 写回 PENDING（审查 R1）。规则写的是"在锁内读取预约"，没覆盖"锁外读到的外部状态"。已修为锁内重读（`withFreshRead`）。复发说明靠 Prompt 规则管不住；可自动化方案（如 lint 检查 `withBookingLock` 回调外的 SDK 读）改动较大，已向用户提议。

### F-004 · 2026-10-26 · 竞态回归测试在撤掉修复后依然通过
- **现象**：为 R1 写的回归测试把事件 A 排在锁里 B 之前，坏的顺序根本没发生；裁判把修复改回去（突变）后测试仍然绿，R1 因此第二轮未关闭。
- **根因**：没验证——写完测试只看它在修复后通过，没确认它在没有修复时会失败。
- **修复**：测试改为先完整应用 B，再放行 A 的旧读取；临时把 `lib/paypal/webhook-events.ts` 的重读改成 `const fresh = first;`，确认测试失败（Received "PENDING"）后还原。
- **规则去向**：全局 ~/.claude/CLAUDE.md
- **复发记录**：无

### F-005 · 2026-10-28 · 新增扣款入口没守住"总额 ≤ 押金"，两个方向各漏一次
- **现象**：提示词 5 的已保存钱包扣款，第一版没有次数和总额上限，成功后重试会再扣一次（审查 R1）；补上"已 capture 计入上限"后，审查又发现反方向：先在 deposit_held 扣钱包，再 capture 授权，客户付两倍押金（R8）。
- **根因**：错误假设——只在新入口（钱包扣款）里检查限额，没把已有的扣款入口（`captureDeposit`）当成同一笔钱的另一扇门；"重试成功后的请求"也没算进幂等范围。
- **修复**：钱包扣款只允许在押金流程结束后（completed / no_show_charged，capture 是 final），每个预约最多一次，且与已 capture 合计不超过押金；测试覆盖两种顺序，并用突变确认测试会失败。
- **规则去向**：全局 ~/.claude/CLAUDE.md
- **复发记录**：无

## 精简记录

| 日期 | 动作（删除 / 合并 / 自动化 / 升级为全局） | 涉及条目 | 说明 |
| --- | --- | --- | --- |
