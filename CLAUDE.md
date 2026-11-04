# CLAUDE.md: SlotKeeper (PayPal AI Hackathon)

> Claude Code loads this file at the start of every session. This file is the single source of truth for scope and progress; incident details go in `FAILURES.md`.
> Every rule must be able to answer "which real mishap does it prevent?" Rules that cannot answer are deleted during `harness-prune`.
> After finishing each task, update Section 7 (Progress).

## 1. Project Overview
- **Project name**: SlotKeeper
- **One-line summary**: An AI front desk for small appointment businesses (salons, physio, tutors, groomers). Every booking, whether made by a person or by a customer's AI assistant, is backed by a PayPal sandbox deposit hold. An owner copilot proposes day plans that the owner approves.
- **Type**: Hackathon (PayPal AI Hackathon on Devpost, submission ID 1246964, solo)
- **Deadline**: Thu 2026-11-12 12:00 PT (= Fri 11-13 04:00 UTC+8). Internal target: submit on 11-11. Feature freeze 11-07 (PLAN.md §7). Demo must stay free and working until judging ends on 12-15.
- **Current stage**: Live on Render; preparing the demo and submission (video, screenshots, Devpost form).

## 2. Goals and Success Criteria
- **End goal**: A submitted Devpost entry that passes Stage One (PayPal + AI meaningfully used; public repo with MIT license; hosted demo; video under 3 minutes; testing instructions) and competes for the grand prize, Best Use of Agentic Commerce / PayPal + AI, and Best Use of Bryntum.
- **Main flow that must work end to end**:
  1. A customer (or their AI assistant over MCP) books a slot and approves a PayPal deposit; PayPal holds it (Orders v2 `AUTHORIZE`).
  2. The booking appears on the staff board, coloured by deposit state and updated live from PayPal webhooks over SSE.
  3. The owner captures, charges a no-show fee, releases or refunds from the board, or describes a change to the copilot, previews its plan on the schedule, approves it, and finds every money action in the audit log with its PayPal ids.

## 3. Scope
**In scope (by priority)**
1. Deposit lifecycle on PayPal sandbox: authorize, capture, no-show partial capture, void, reauthorize, refund; verified webhooks.
2. Staff board (Bryntum Scheduler) with money-action buttons, the owner copilot (plan → approve → execute, audited), and the MCP booking server.
3. Saved wallet (Vault), end-of-day Payouts, Transaction Search report (already built).

**Out of scope (prevents feature creep)**
- Real money / PayPal live environment: sandbox only.
- More than one app instance (locks and write queue live in the process; `numInstances: 1`).
- Customer chat assistant (PLAN P0 #5): TBC whether it is formally dropped in favour of the MCP server.
- Waitlist backfill, invoicing for balance and tips, risk-based deposits, multi-currency: listed in devpost "What's next"; TBC that none is attempted before submission.

## 4. Tech Stack
| Layer | Choice |
|---|---|
| Frontend | Next.js 16.4.2 App Router, React 19.3.1, Bryntum Scheduler 7.3.7 (trial, npm alias `@bryntum/scheduler`), PayPal JS SDK v6 |
| Backend | Next.js route handlers, TypeScript 5.9.3 (strict), Node 22.15 |
| Database | Postgres on Render (`slotkeeper-db`, basic-256mb); write-through `records` table with revisions (`lib/storage/records.ts`); PGlite in tests |
| Third-party services / APIs | `@paypal/paypal-server-sdk` 2.5.0 (Orders, Payments, Vault, Payouts, Transaction Search, Webhooks); Anthropic API via `@anthropic-ai/sdk` (copilot, default `claude-haiku-5-5`); `@modelcontextprotocol/sdk` (MCP server) |
| Deployment | Render Blueprint (`render.yaml`): web service `slotkeeper` (starter, oregon, 1 instance, `autoDeploy: false`) + `slotkeeper-db`. Live: https://slotkeeper-93dy.onrender.com |

**Known constraints**: PayPal sandbox only; an authorization's honor period is 3 days; Render stops builds at 8 GB, so the build uses webpack (Turbopack peaked at 21 GB); `NEXT_PUBLIC_*` values are baked in at build time; local runs behind HTTPS-inspecting antivirus need `NODE_OPTIONS=--use-system-ca`.

## 5. File Structure
```
PayPal/
├── app/            pages (/, /book, /book/[id], /staff, /staff/report) and api/ route handlers
├── components/     React components (StaffBoard, BookingScheduler, BookingPanel, ...)
├── lib/            agent/ (MCP), api/, board/ (pure board logic), booking/, copilot/, paypal/ (server-only), storage/
├── tests/          Vitest suites; helpers/paypal-stub.ts stubs the PayPal SDK transport
├── docs/           devpost.md (submission text), apimatic-prompts.md
├── githooks/       pre-commit / pre-push gates (secrets, .env, ledger lint)
├── .claude/        harness: agents, hooks, skills, lint.js
├── render.yaml     Render Blueprint
├── PLAN.md         original hackathon plan
├── FAILURES.md     incident log (F-001 to F-014)
└── CLAUDE.md       this file
```

## 6. Documentation Index (read as needed before starting)
- `PLAN.md` (repo root): what we are building, for whom, why, schedule, risks
- `README.md`: architecture, PayPal API → code map, env vars, local run, deploy, judge test steps
- `docs/devpost.md`: Devpost submission text and the pre-submit checklist
- `docs/apimatic-prompts.md`: prompts used with the APIMatic Context Plugin
- `FAILURES.md`: past mishaps and their prevention rules
- PRD / TRD / APP-FLOW / UI-UX: none yet
- `docs/database/`: none yet

## 7. Progress (update after every task)
**Done**
- [x] Booking + deposit hold: JS SDK v6, Orders v2 AUTHORIZE (10-25)
- [x] Staff capture / no-show fee / void / reauthorize / refund routes (10-26)
- [x] Verified PayPal webhooks + staff SSE feed (10-26)
- [x] Render Blueprint and deploy steps (10-27)
- [x] Vault: save wallet at checkout, charge it later (10-28)
- [x] End-of-day staff Payouts (10-30)
- [x] Owner copilot: plan, approve, execute, audit log (10-30)
- [x] MCP booking server for customers' assistants (10-30)
- [x] Deposits report from Transaction Search (10-30)
- [x] Negative-path tests + opt-in sandbox suite; replay limits and unknown outcomes (10-30/31)
- [x] Staff board, copilot UI, Postgres storage, revision checks for overlapping instances (10-31)
- [x] Webpack build for Render memory; follow-redirects security fix; copilot on Haiku 5.5 (10-31)
- [x] README + Devpost submission copy; agent-tools positioning (11-04)
- [x] Board money-action buttons with confirmations (11-04, 6306bff); deployed to Render 11-04, storage loaded from Postgres
- [x] Copilot budget guard: effort `medium`, at most `COPILOT_DAILY_LIMIT` (default 40) requests per rolling 24 h, in memory (11-04); deployed 11-04 (890c4af), first live Haiku answer worked
- [x] Copilot gets the current date, time and UTC offset in `BUSINESS_TIME_ZONE` with every request (11-04); not deployed yet

**In progress**
- [ ] Nothing in progress.

**To do (by priority)**
- [ ] Rotate the PayPal secret and STAFF_API_TOKEN; add ANTHROPIC_API_KEY with a spending cap (Render + `.env.local`)
- [ ] Live copilot plan → approve → audit log run (a question already works); check the "Persistence Check" booking survived a restart (it is dated 11-02, before today); MCP smoke test with a real client
- [ ] Decide whether judges get a staff token (docs/devpost.md checklist item 1)
- [ ] Video (under 3 min), screenshots, one sourced no-show statistic
- [ ] GitHub About fields (description, website, topics)
- [ ] Discord questions: AI API credits; Bryntum trial validity through 12-15
- [ ] Submit on Devpost by 11-11

**Known issues**
- The copilot has answered one live question; a live plan and approval has not run yet.
- Locally the copilot uses UTC unless `.env.local` sets `BUSINESS_TIME_ZONE` (Render sets America/Los_Angeles).
- MCP: not confirmed live that PayPal returns the approval link for an order created with `return=minimal`.
- Bryntum trial watermark; trial validity through judging: TBC.
- During a deploy two instances overlap; a write clash becomes a conflict record and the booking goes to staff review.
- The board can briefly show an older booking state if a slow action response lands after a newer live update; a Retry button stays visible on a panel left open past the replay window (the server refuses it safely).
- Payouts carry a tip field, but nothing creates tips yet.

## 8. Working Rules (Claude must follow these)
1. Work on one task at a time. Report when it's done and wait for my confirmation before continuing.
2. Before making changes, state the plan: which files will change and why.
3. Do not modify anything under "Done" unless I explicitly ask.
4. Do not add anything listed as out of scope in Section 3, and do not add features outside the scope on your own.
5. If something is unclear, ask me. Do not guess.
6. Do not add new dependencies without explaining why and getting my approval.
7. Never put secrets, tokens, or passwords in code or commit them to git. Use environment variables.
8. After every change, tell me: what changed, how to test it, and what is still incomplete.

## 9. Code Conventions
- Language / style: TypeScript (strict). No linter or formatter configured.
- Naming: kebab-case files in `lib/` (e.g. `deposit-actions.ts`), PascalCase React components, camelCase variables.
- Comments: short comments on key logic only.
- Error handling: every external call (PayPal, Anthropic, Postgres) handles failure; PayPal money calls use a stable `PayPal-Request-Id` and keep outcome-unknown calls pending for replay.
- Every file in `lib/paypal/` starts with `import 'server-only'` (enforced by `tests/paypal/server-only.test.ts`).
- Testing: `npm test` (Vitest). Fixed clocks, never the real date. Stub PayPal through the SDK's axios adapter (`tests/helpers/paypal-stub.ts`). Regression tests are mutation-checked (revert the fix, see the test fail, restore).

## 10. Database Rules
- Schema changes must go through migrations. Never edit the live database directly. (Today the schema is created in code by `lib/storage/records.ts`.)
- Every new table must first be documented in `docs/database/DATA-MODEL.md` and `SCHEMA.md` (none yet).
- Tables holding user data must have access rules (RLS or equivalent). (The database only accepts connections from Render services in this account: `ipAllowList: []`.)
- Use seed data only for testing. Never use real user data.

## 11. Common Commands
```
npm install                      # install dependencies
npm run dev                      # local dev (needs .env.local, see .env.example)
npm test                         # unit tests; npm run test:sandbox for the opt-in sandbox suite
npm run typecheck                # tsc --noEmit
npm run build                    # production build (webpack)
node .claude/harness/lint.js     # harness ledger check; node --test ".claude/harness/tests/*.test.js"
```
Deploy: Render dashboard → `slotkeeper` → Manual Deploy → Deploy latest commit.

## 12. Start-of-Session Checklist
1. Read this entire file.
2. Compare it against the existing code and tell me where the code and the docs/plan disagree.
3. Start from the first item under "In progress" or "To do" in Section 7.

## 13. End-of-Session Checklist
1. Update Section 7 (Progress).
2. Record any new issues or decisions.
3. Tell me where the next session should pick up.

## 14. Decision Log
| Date | Decision | Reason |
|---|---|---|
| 2026-10-20 | Build SlotKeeper; target Bryntum sponsor prize | Least crowded sponsor prize; fits "agent books and pays" (PLAN.md §4, §6) |
| 2026-10-27 | Render paid plans (starter web, basic-256mb Postgres) | Free instances sleep and drop webhooks; free Postgres expires before 12-15 |
| 2026-10-27 | `autoDeploy: false` | Old and new instances overlap during a deploy; deploy when quiet |
| 2026-10-31 | Postgres write-through records with revisions | Bookings must survive restarts; overlapping instances must not overwrite each other |
| 2026-10-31 | Build with webpack, not Turbopack | Turbopack peaked at 21 GB; Render stops builds at 8 GB |
| 2026-10-31 | Copilot defaults to Claude Haiku 5.5 (`COPILOT_MODEL`) | Lower cost during judging; Sonnet/Opus still selectable |
| 2026-11-04 | Repo Markdown in English; ledger heading renamed | lint.js accepts the new heading and the older Chinese one |
| 2026-11-04 | No PayPal agent-toolkit runtime dependency | Its tools lack authorize/void/reauthorize/Payouts/Vault; money steps stay in our tested functions |

## 15. Harness Workflow (mandatory)
1. **Log every mishap**: after a correction or a pitfall that caused rework, fix it, then run `harness-postmortem` and write one rule of at most 2 sentences into the right ledger (global or this file).
2. **Pass the referee before delivery**: after writing or refactoring code, run `harness-review` (independent subagent `harness-reviewer`) before declaring it done or committing.
3. **Fix it or show evidence**: every review issue is fixed or closed with the passing test command and output. Never edit tests to make them pass.
4. **Gates cannot be bypassed**: if a hook blocks you, do not work around it; explain and let the user decide.
5. **Automate instead of prompting**: a rule enforceable by a hook / lint / test becomes code and is only recorded in `FAILURES.md`.

# Mishaps and Prevention Rules
