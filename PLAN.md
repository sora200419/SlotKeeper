# PayPal AI Hackathon — Entry Plan (PLAN)

## Context
- You are entering the PayPal AI Hackathon on Devpost solo (submission ID 1246964). The goal is to pick the direction with the best odds and ship a prize-worthy project before the deadline.
- Basis: the rules, resources page and sponsor pages you pasted; the four official videos (I read the full captions of the first one, and used your summaries for the other three); and research on the Devpost site and sponsor pages on Oct 20.
- This file is the battle plan, saved as `PLAN.md` in the project folder. No code is written until you say go.
- Everything you need to open yourself is listed in Section 11. Section 12 summarizes what the PayPal developer docs say and how it changes the build.

---

## 0. One-page summary
| Item | Conclusion |
|---|---|
| Deadline | **Thu Nov 12, 2026, 12:00 PT = Fri Nov 13, 04:00 UTC+8**. Today is Oct 20, 23 days left |
| Internal deadline | **Submit on the evening of Wed Nov 11**; Nov 12 is only a buffer |
| Recommended project | **SlotKeeper (working name)**: an AI front desk for small appointment-based businesses (hair, physio, tutoring, pet grooming). Every booking, including ones made by a customer's AI assistant, is backed by a PayPal deposit. One sentence re-plans the whole day and the money follows automatically |
| Target prizes | A Grand Prize or **Best Use of Agentic Commerce / Best Use of PayPal + AI**, plus the **Best Use of Bryntum** sponsor prize |
| Tech stack | TypeScript + Next.js, Bryntum Scheduler, PayPal JS SDK v6 + TypeScript Server SDK, Claude (tool use), a self-built MCP server, hosted on Render |
| First thing to do | Section 11, items 1–4: set up the sandbox accounts and app, create the GitHub repo, open the Devpost draft, claim the Render credits |

---

## 1. What this hackathon is
- Hosted by PayPal, run by Devpost. Online and open worldwide. The theme is **PayPal + AI**. There are no tracks; the five directions below are only inspiration:
  1. AI Agents / Automation
  2. Money Movement
  3. Business Solutions
  4. Consumer
  5. Social Impact
- **The only hard requirement**: the project must "meaningfully" use both PayPal and AI. In the organizers' words, adding a PayPal button to an unrelated app is not enough; PayPal must be central. Any AI tool or model is fine.
- Free sandbox only, no real money. Existing projects may enter, but they must have been significantly updated after Oct 1 and you must explain what changed. You may submit more than one project, but they must be substantially different.
- Timeline:
  - Submission period: Oct 1 – Nov 12, 12:00 PT
  - Judging: Dec 1 – Dec 15
  - Winners announced: around Dec 21
- ⚠️ In the first video the speaker says "Nov 12, 2:00pm PT", which conflicts with the rules' 12:00pm. **The rules win; treat the deadline as 12:00 PT.**

## 2. Hard requirements checklist (Stage One is pass/fail; missing any item means out)
- [ ] The app uses real PayPal sandbox APIs/SDKs plus AI, and PayPal is central
- [ ] English text description: features, plus **Tools: list which AI tools/models you used and how you used them**
- [ ] A working demo: a hosted URL (recommended), or complete setup-and-run instructions in the repo. A mockup or static prototype does not count
- [ ] A public GitHub repo with an open-source LICENSE (MIT is fine), visible in the repo's About section
- [ ] A public YouTube video **under 3 minutes** showing the project actually running. No copyrighted music or third-party trademarks
- [ ] Testing instructions: hosted URL, sandbox test buyer account, steps to trigger each flow. **Never submit real secrets** (judges have no Anthropic key, so host the demo and keep the key on the server)
- [ ] The demo must stay **free and unrestricted until judging ends on Dec 15**
- [ ] All materials in English
- The Devpost form asks for: project name, elevator pitch, project story (inspiration, how it was built, tools used, why), repo link, video link, text description, tool list, testing instructions

## 3. Judging and prize strategy
- **Five equally weighted criteria**: technical implementation, design, potential impact, innovation, presentation. Ties are broken in that order, so **technical implementation comes first**.
- **Presentation is one fifth of the score**, and Best Demo Delivery is a separate $5k prize. The video must not be left to the last minute.
- **Judges may not run your project at all**; they can score from the text, images and video alone, and AI-driven analysis may be used. So the README and Devpost description must stand on their own and map point by point to the five criteria (Section 9 has a template).
- Prize stacking: at most **one Grand Prize or one Honorable Mention, plus one sponsor prize**. Using several sponsor tools makes you eligible for each of those sponsor prizes, but you can only win one of them.
- Judges (from research): 6 from PayPal (DevRel, engineering, product) and 7 from sponsors (AG Grid, APIMatic, the **Bryntum CEO**, Channel3, Elastic, Postman, Render).

## 4. Competitive landscape (research as of Oct 20; all numbers are lower bounds)
- **17,062 people** registered. **At least 280** projects are already public, about 92% of them solo.
- Already crowded themes, **to avoid**:
  - AI agent payment guardrails and spending-limit authorization (Writ, PayGuard, Leash, etc.)
  - Invoice-collection agents (about 33)
  - Shopping agents (about 33)
  - AI escrow release (15)
  - Dispute evidence (15)
  - Refunds, freelancer tools, negotiation
  - Generic payments dashboards
  - Milestone payments on a Bryntum Gantt (3 already)
- Sponsor tags among existing projects:

| Tag | Projects |
|---|---|
| ag-grid | 65 |
| render | 61 |
| channel3 | 15 |
| apimatic | 12 |
| **bryntum** | **9** |
| postman | 8 |
| kernel | 4 |
| zapier | 4 |
| elastic | 1 |
| astropods | 0 |

- Conclusions:
  - Bryntum has 3 slots and the least competition, and its CEO is a judge, so it is the **best return among sponsor prizes**.
  - AG Grid has the biggest prize pool but the most competition.
  - Look for a theme where "an agent actually moves money for someone", while avoiding the crowded themes above.

## 5. Sponsor tools: free, or do you have to apply?
| Tool | Prize? | How to get it (all free) | Timing / gotchas | In this plan |
|---|---|---|---|---|
| **Bryntum** | ✅ $1k×3 | 45-day trial. Install the trial package straight from npm: `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial`; or fill in the form on the download page | Trial watermark, which judges should accept. Ask on Discord whether expiry affects judging | **Core** |
| **Render** | ✅ credits | Claim $50 of credits through the hackathon claim link | Free instances sleep after 15 minutes idle; free Postgres expires after 30 days. Use the credits for paid instances to last until Dec 15 | **Hosting** |
| **APIMatic** | ✅ $1k×3 | No credentials needed (PayPal is already enabled); install the Context Plugin in your coding assistant while developing. After using it, fill in the Google form to claim 1 month of Basic | Judges cannot see it; prove you used it in the README and video | Use it while building |
| AG Grid | ✅ $10k across 5 winners | The 45-day trial license must be requested on the license-pricing page; there is an official boilerplate | Requesting it now means it expires mid-judging (around Dec 4); if you use it, request around Nov 1 | Only for fallback C |
| Channel3 | ✅ $1.5k×1 | Free sign-up; promo code `PAYPAL-HACKATHON-2026` gives 20,000 credits | You must actually call the API or MCP | Not used |
| Elastic | ❌ | 14-day trial, self-extendable by 30 days; can also run locally for free | Expires during judging | Not used |
| KERNEL | ❌ | $50 via the hackathon link | Browser agents are prone to failing in a live demo | Not used |
| Postman | ❌ | Free plan, plus the official PayPal collection (it has agentic commerce examples) | — | Use for API debugging |
| Zapier | ❌ | 14-day Professional trial, then Free | PayPal is a paid app on Zapier; the trial ends around Nov 3 | Not used |
| Astropods | ❌ | Free sign-up with credits | — | Not used |

> Open question (ask on Discord): if a project uses both Bryntum and Render, could it end up awarded only the Render credits prize and miss Bryntum's cash prize?

---

## 6. Recommended direction: SlotKeeper (working name; search Devpost for name clashes)

### 6.1 One-line pitch (the English version goes in the submission)
> "AI assistants are starting to book appointments for people — and small businesses eat the no-shows. SlotKeeper makes every booking, human- or agent-made, payment-backed with PayPal, and lets the owner re-plan the whole day in one sentence."

### 6.2 Why this one
| Criterion | How it scores |
|---|---|
| Technical implementation | Uses 6–8 PayPal capabilities: JS SDK v6, Orders AUTHORIZE, capture/void, refund, Payouts, Webhooks, Invoicing, Transaction Search, plus Agent Toolkit/MCP. Every one is needed by the real workflow, none is padding |
| Design | A complete merchant product: scheduler board, customer booking page, owner copilot, audit log |
| Impact | A clearly defined user: small appointment-based businesses, whose pain is no-shows and last-minute cancellations. You need 1–2 citable statistics, or interviews with 2–3 shop owners |
| Innovation | Deposits and no-show fees already exist (Square, Fresha, etc.), **so the innovation has to sit in the agent layer**, not in the deposit itself: ① a customer's AI assistant books and pays through MCP (agent-to-agent); ② one sentence re-plans the schedule and the money actions execute atomically with it; ③ when someone cancels, the agent fills the slot from the waitlist and collects the deposit |
| Presentation | Events on the Bryntum board move and change color in real time, which looks great in 3 minutes |
| Sponsor fit | Bryntum's own idea list includes "booked and locked once payment clears" and "agent-driven rescheduler", the closest possible match |

### 6.3 Core features and priorities
- **P0 (must have; do not submit without them)**
  1. Bryntum Scheduler board: one row per staff member, each event is a booking, colored by money state: awaiting payment, authorized, captured, refunded, no-show
  2. Customer booking page: pay the deposit with JS SDK v6, using Orders v2 `intent: AUTHORIZE` to hold the deposit amount
  3. Server-side money actions:
     - Service delivered → capture
     - Cancellation within the allowed window → void (free; refunds cost fees, so always prefer void before capture)
     - No-show → partial capture to charge the fee
     - Cancellation after capture → refund
  4. Webhooks: verify the signature, then push live updates to the board over SSE
  5. Customer AI booking assistant (chat): understands "a haircut with Maria after 5pm next Tuesday" and calls tools to find free slots, hold a slot and create the deposit payment
  6. Owner copilot: the owner types "Maria is off sick tomorrow, move her clients to Ken, refund the deposit for anyone who won't move"; the agent first shows the proposed changes as ghost events on the board, and only runs them (move events + PayPal money actions) after the owner approves
  7. Audit log: every money action the agent takes records the reason, amount and PayPal ID
- **P1 (differentiators, week 2)**
  8. Automatic waitlist backfill: when someone cancels, the agent notifies waitlisted customers, and whoever confirms first pays the deposit and takes the slot
  9. Payouts: at end of day, pay staff their commission and tips into their sandbox personal accounts
  10. **Agent-ready booking**: a self-built MCP server exposing `search_slots`, `hold_slot`, `create_deposit` and `cancel_booking`, so an external AI assistant (e.g. Claude Desktop) can book and pay on a customer's behalf. This is the key to the Agentic Commerce prize
  11. **Saved PayPal wallet (Vault)**: the first booking saves the customer's PayPal (`savePayment: true` on the v6 session), so later bookings, bookings more than 3 days out, and no-show fees can be charged without a popup. This is what makes "an agent books and pays for you" real instead of a demo trick (see Section 13)
- **P2 (if there is time)**
  - Invoicing: after the service, send an invoice for the balance plus tip, with a QR code
  - Adjust the deposit percentage by no-show risk (rules + an LLM explanation)
  - Use Transaction Search to answer "how much did deposits save us this month?"
  - Multi-currency

### 6.4 Architecture
```
[Customer page, Next.js] --JS SDK v6--> PayPal (authorize deposit)
[Customer's AI assistant] --MCP--> [/mcp self-built MCP server] ─┐
[Customer chat assistant]  --> [/api/agent/customer] ────────────┤
[Owner copilot]  --> [/api/agent/owner plan→approve→execute]
                                                   ▼
                     [Next.js API + Postgres (Render)]
                       │  PayPal TypeScript Server SDK / REST:
                       │  Orders v2 · authorizations capture/void
                       │  captures refund · Payouts · Invoicing
                       │  Transaction Search · webhook signature verification
                       ▼
            PayPal Sandbox ──Webhooks──> /api/webhooks/paypal ──SSE──> [Bryntum Scheduler board]
            LLM: Claude (tool use); some tools can use the PayPal Agent Toolkit
            Scheduled jobs: Render Cron / Workflows → end-of-day Payouts
```
- Tables: Staff, Service, Client, Booking (status, order_id, authorization_id, capture_ids, deposit), WaitlistEntry, AgentAction (audit), PayoutBatch
- Model suggestion: Claude Sonnet 5.5 (`claude-sonnet-5-5`) for the main agent, Haiku 5.5 (`claude-haiku-5-5`) for lightweight classification. The hosted demo needs rate limiting and a one-click demo-data reset
- Development aids: install the PayPal AI Toolkit plugin in Claude Code (use `/paypal:doctor`, `/paypal:explain-error`, `/paypal:sandbox`), and the APIMatic Context Plugin

### 6.5 Fallback directions (switch if the main one stalls)
- **B. ShiftPay**: a Bryntum rota board with instant pay. AI fills open shifts at events or restaurants based on staff availability; after a shift ends and the manager confirms, Payouts pays the worker immediately and tips split automatically. Also aims at the Bryntum prize.
- **C. A small-nonprofit donation operations desk**: Donate SDK, recurring subscription donations, AG Studio custom widgets, plus the Studio Agent Framework. The agent drafts thank-you notes, spots lapsing recurring donors, and uses Payouts to send grants to field partners. Aims at the AG Grid prize, which pays more but has the most competition.

---

## 7. 23-day schedule
| Phase | Dates | Deliverable / milestone |
|---|---|---|
| Prep | Oct 20 (Tue) – Oct 21 (Wed) | Finish Section 11 items 1–6; Next.js project running; Bryntum Scheduler showing seed data; AI Toolkit installed in Claude Code |
| W1 Payment backbone | Oct 22 (Thu) – Oct 28 (Wed) | P0 items 1–4. **Spike on Oct 22: save a sandbox PayPal wallet and charge it later with the vault ID, without the buyer present** (decides how far P1 item 11 goes). **Oct 25 (Sun): first deploy to Render**, register the webhook URL in the PayPal dashboard. **Oct 28: the board changes color live from webhooks** |
| W2 AI layer | Oct 29 (Thu) – Nov 4 (Wed) | P0 items 5–7, then P1 items 8–10. **Nov 1: the owner copilot completes "plan → approve → execute"**. **Nov 4: MCP booking works end to end** |
| W3 Polish | Nov 5 (Thu) – Nov 8 (Sun) | **Nov 7 (Sat): feature freeze**. UI theme; custom Bryntum event rendering (money badges, funding-state checks on drag); failure paths; demo reset; README and architecture diagram. **Record the video on Nov 8** |
| Wrap-up | Nov 9 (Mon) – Nov 11 (Wed) | Edit the video and upload it to YouTube (public); write the Devpost copy, screenshots and testing instructions; **walk through it as a judge would, in an incognito window**; **submit on Nov 11** |
| Buffer | Thu Nov 12, daytime (UTC+8) | Only fix fatal problems. No edits after 04:00 (UTC+8) |

> If you have under 15 hours a week: do only P0 plus P1 item 10 (MCP), and turn waitlist backfill and Payouts into stretch demos in the video, or cut them.

## 8. 3-minute video script (under 2:50; English narration plus captions; royalty-free music or none)
| Time | Content |
|---|---|
| 0:00–0:15 | The pain + the user + one number (an owner waiting for a no-show, or a one-line statement of the pain) |
| 0:15–0:35 | Product overview: the scheduler board |
| 0:35–1:15 | A customer's AI assistant books through MCP → PayPal deposit authorization → a green event appears on the board in real time |
| 1:15–1:55 | **The climax**: the owner says "Maria is sick…" → ghost plan → approve → events move, deposits are voided/refunded, the waitlist fills the slot and pays a deposit |
| 1:55–2:25 | No-show partial charge → end-of-day Payouts to staff → audit log |
| 2:25–2:50 | Architecture diagram, the list of PayPal APIs used, impact, what's next |

## 9. Submission material templates
- **Devpost Story**: Inspiration / What it does / How we built it (list how each PayPal API and the AI are used) / Challenges / Accomplishments / What we learned / What's next
- **Tools**:
  - PayPal: JS SDK v6, Orders v2 (authorize/capture/void), Payments refunds, Payouts, Webhooks, Invoicing, Transaction Search, Agent Toolkit / MCP
  - Development aids: PayPal AI Toolkit, APIMatic Context Plugin
  - Other: Bryntum Scheduler, Render, Claude
  - For every item, add one sentence on what it is used for
- **README structure**: one-line summary, screenshots/GIF, Live demo, **How it meets the judging criteria** (point by point against the five criteria, so AI reviewers can pick it up), architecture diagram, PayPal integration list (API → file location), local run steps, environment variable table, test accounts, License
- **Testing instructions**: hosted URL, demo reset button, sandbox buyer account (test only, fine to make public), steps to trigger each flow

## 10. Risks and countermeasures
| Risk | Countermeasure |
|---|---|
| An authorization's honor period is only 3 days (valid up to 29 days, but one docs page says US authorizations are valid for only 3 days) | Keep demo bookings within 3 days; for bookings further out, charge the saved wallet (Vault, P1 item 11). Sandbox authorizations never expire, so test expiry with negative testing (`AUTHORIZATION_EXPIRED`) |
| Webhooks need a public address | Deploy to Render early; use cloudflared or ngrok locally; return 2xx (failures are retried up to 25 times over 3 days); always verify the signature |
| The sandbox MCP has had reported `create_invoice` errors | Use the Server SDK or REST directly for all critical paths; use MCP only for the copilot's extra capabilities |
| The AI Toolkit token expires after about 8–9 hours | Run `/paypal:setup refresh` and fully restart Claude Code. The app itself uses client credentials, which the SDK refreshes automatically |
| Country / currency issues | Create both the sandbox business and buyer accounts **in the US** (same country) to avoid currency and Payouts problems |
| App feature switches | Turn on Transaction Search in the app settings; it can take up to 10 minutes to take effect after saving |
| Render sleeping or the database expiring | Use credits for a paid instance and paid Postgres to last until Dec 15 |
| Bryntum trial watermark or expiry | The watermark is acceptable; ask on Discord about expiry; record the video early |
| Judge usage running up LLM costs | Rate limits, a per-session cap, a demo mode |
| Scope creep | Stick strictly to P0/P1/P2; feature freeze on Nov 7 |
| Leaked secrets | Keep the client secret only in server environment variables; put `.env` in `.gitignore`; commit only `.env.example` |

## 11. Links you need to open yourself (in order)
1. **PayPal Developer Dashboard** (https://developer.paypal.com/dashboard/):
   - Switch to Sandbox
   - Create a US business account and a US personal account
   - Create one Merchant app named after the project (e.g. `slotkeeper`), choose type **Merchant**, and pick the sandbox business account it belongs to (name your sandbox accounts so this is easy). Note the client ID and secret
   - In the app's **Features**: keep Transaction Search on, and **turn on "Save payment methods"** (off by default; needed for the Vault spike on Oct 22). Click save; changes can take up to 10 minutes
   - Sandbox and live are completely separate: separate apps, credentials and webhook URLs. Stay in sandbox for the whole hackathon
2. **GitHub**: create a public repo, choose the MIT License, and confirm the About section shows the license.
3. **Devpost**: open your draft and first fill in the project name and an elevator pitch placeholder.
4. **Render $50 credits**: https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon (follow the page's instructions to apply them under Billing).
5. Getting-started references; read once:
   - https://github.com/paypaldev/getting-started-with-paypal-sandbox
   - https://github.com/paypal-examples/docs-examples (the official demo project)
6. **PayPal AI Toolkit** (https://github.com/paypal/AI-Toolkit): install the plugin in Claude Code following the README and configure the sandbox token.
7. **Agent Toolkit and tool list**:
   - https://docs.paypal.ai/developer/tools/ai/agent-toolkit-quickstart
   - https://docs.paypal.ai/developer/tools/ai/agent-tools-ref
   - Confirm the exact tool names and supported frameworks
8. **JS SDK v6**: https://developer.paypal.com/sdk/js/ , and the v6 example https://github.com/paypal-examples/v6-web-sdk-sample-integration
9. **Server SDK**: https://github.com/paypal/PayPal-TypeScript-Server-SDK
10. **Bryntum Scheduler**: https://bryntum.com/products/scheduler/ , examples at https://bryntum.com/examples/
11. **APIMatic**: the Resource Info Page (Google Drive) on the sponsor page has install instructions; after using it, fill in the Claim form.
12. **PayPal Discord** (https://discord.gg/sJ2G6DyvSK); ask two things:
    - Is the Bryntum trial valid through Dec 15?
    - When several sponsor prizes apply at once, how is the one awarded decided?
13. **YouTube**: confirm your account can upload public videos.

## 12. Findings from the PayPal developer docs (read Oct 20)
Every card under Get started, Payments, Revenue and Developer resources was read, plus the deeper pages below. What changes the build:

**Starter code and SDKs**
- Follow the official **Next.js guide** (`/guides/nextjs-checkout`): `@paypal/react-paypal-js` (v6 React wrapper) in the browser, `@paypal/paypal-server-sdk` in Server Actions, one shared server client. Env vars: `NEXT_PUBLIC_PAYPAL_ENVIRONMENT`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (never `NEXT_PUBLIC_`). Look up prices server-side; never trust the browser amount.
- JS SDK v6: `session.start({ presentationMode: "auto" }, createOrder())` — the second argument is a promise resolving to `{ orderId }`. One `PayPalProvider` per page; set `environment` explicitly.
- Orders stay `CREATED` for 3 hours. Send a UUID `PayPal-Request-Id` on every money call (not `Date.now()`).

**Authorize / capture / void / reauthorize**
- `POST /v2/checkout/orders/{id}/authorize` → store `purchase_units[0].payments.authorizations[0].id` immediately.
- Capture: `POST /v2/payments/authorizations/{id}/capture` (any amount up to the total; several partial captures allowed).
- Void: `POST /v2/payments/authorizations/{id}/void` — all-or-nothing, free, releases funds instantly in sandbox. Can't void after capture (refund instead).
- Reauthorize: `POST /v2/payments/authorizations/{id}/reauthorize`, once, between days 4 and 29, up to 115% of the original.
- Refund: `POST /v2/payments/captures/{id}/refund` (partial with `amount`), within 180 days; cannot be cancelled.

**Vault (saved payment methods)** — upgraded to P1 item 11
- Save during purchase: `savePayment: true` on `createPayPalOneTimePaymentSession` plus the vault fields in the Orders request. Save without purchase: `createPayPalSavePaymentSession` → `billingToken`, or setup token (`POST /v3/vault/setup-tokens`, `payment_source.paypal` with `usage_type: MERCHANT`, `customer_type: CONSUMER`, a `usage_pattern` such as `UNSCHEDULED_POSTPAID`, a `description` shown to the payer) → payer approves → `POST /v3/vault/payment-tokens` with `{ token: { id, type: "SETUP_TOKEN" } }`.
- Live needs the "Save payment methods" and "PayPal and Venmo" toggles; check they are on for the sandbox app too. Customer-initiated charges with tokens need Risk Data Acquisition (FraudNet/Magnes) or they may be declined. **Verify the merchant-initiated charge with a vault ID in sandbox during W1** before building on it.
- **Spike result (sandbox, 2026-10-30): it works.** With the checkbox ticked, the order carried `payment_source.paypal.attributes.vault` (`store_in_vault: ON_SUCCESS`, `usage_type: MERCHANT`, `customer_type: CONSUMER`, `usage_pattern: UNSCHEDULED_POSTPAID`) and, after the authorization, PayPal reported the wallet as `VAULTED` with a payment token. Later, with the buyer absent, a new order (intent `CAPTURE`) with `payment_source.paypal.vault_id` plus `stored_credential` (`payment_initiator: MERCHANT`, `usage: SUBSEQUENT`, `usage_pattern: UNSCHEDULED_POSTPAID`) came back `COMPLETED` with a `COMPLETED` capture in one call: no popup, no buyer action. **No risk data was needed**: the request sent no `PayPal-Client-Metadata-Id` header and PayPal did not ask for one. Limits of the spike: wallet charges can't be refunded through the app yet, and a wallet is charged only after the hold is finished (completed or no-show), at most once per booking, never above the deposit together with the hold capture.

**Payouts**
- `POST /v1/payments/payouts`, up to 15,000 items per batch. Sandbox does **not** support the `PHONE` recipient type → pay staff by `EMAIL` (their sandbox personal accounts). `sender_batch_id` must be unique for 30 days (natural idempotency key). Unclaimed items return after 30 days. Live needs PayPal approval; sandbox works now.

**Transaction Search**
- `GET /v1/reporting/transactions`: `start_date`/`end_date` required, max 31-day range, `page_size` ≤ 500, data appears **up to 3 hours late**. So the live demo reads money state from our own DB + webhooks; Transaction Search only powers the "this month" report.

**Webhooks**
- Up to 10 listener URLs per app, HTTPS port 443 only. Verify the signature on the **raw body** (`transmissionId|timeStamp|webhookId|crc32`, cert from `paypal-cert-url`) — in Next.js read `await req.text()`, never re-serialize. Simulator events use webhook ID `WEBHOOK_ID` and can't use the postback verify endpoint.
- Events to subscribe: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED/FAILED/UNCLAIMED`, `INVOICING.INVOICE.PAID`, `VAULT.PAYMENT-TOKEN.CREATED`.

**Negative testing (for the failure-path demo)**
- Turn on Negative Testing in the sandbox business account settings, then send `PayPal-Mock-Response: {"mock_application_codes": "<ERROR_NAME>"}` on Orders/Payments v2 calls (create, authorize, capture, void, refund). Card declines: put a rejection trigger in the card name field. Use this to show the agent handling a declined no-show charge gracefully.

**AI tooling**
- Agent Toolkit: `@paypal/agent-toolkit` (TS) works with the Vercel AI SDK, so it can run with Claude via `@ai-sdk/anthropic`. 30 tools; useful for the owner copilot: `pay_order`, `create_refund`, `get_order`, `create_invoice`, `send_invoice`, `generate_invoice_qr_code`, `list_transaction`, `get_merchant_insights`. It has **no** authorize/void/reauthorize/payouts/vault tools → write those as our own tools on the Server SDK (this is also good for the "non-trivial" score).
- MCP: local `npx -y @paypal/mcp --tools=all`, or remote `https://mcp.sandbox.paypal.com` (`/sse` or `/http`). Remote "commerce" tools (`search_product`, `create_cart`, `checkout_cart`) only cover gift cards.
- PayPal's own **Agent Ready (ACP/UCP)** needs an access-request form plus Braintree or Google enrollment, so it is not usable here. Our own MCP booking server fills that gap; say so in the Devpost story ("Agent Ready for services, not just products").

**Not worth using for SlotKeeper:** Pay Later (financing promos only, strict messaging rules), Apple Pay (domain verification + Safari), Google Pay, Fastlane, Log in with PayPal, order tracking, SFTP/DropZone, Braintree, multiparty platform fees (live approval needed). Venmo is US-only and optional.

## 13. How to verify (what counts as truly done at each milestone)
- **Payment backbone**: in the sandbox, pay a deposit with the personal account → the business account sees the authorization → the backend runs capture, void and refund, and all three paths succeed → the dashboard's Event Logs show the API calls and webhook records.
- **The five official test scenarios** (from the PayPal sandbox walkthrough), each checked from both sandbox accounts (log in as the personal account to see the purchase, as the business account to see the payment): 1) successful payment, 2) buyer cancels checkout, 3) a different buyer / another country, 4) refund from the merchant side, 5) failures and edge cases (negative testing). Debug with Dashboard → Event Logs → API Calls / Webhook Events / Error Logs (the Webhook Events view only keeps the last 30 days; failed deliveries can be resent from there).
- **Real-time behavior**: any money-state change shows up on the board within 3 seconds. Resending a webhook from the PayPal dashboard does not get processed twice (idempotent).
- **Agent**: every owner-copilot execution has an audit record that matches the PayPal transaction ID; no money moves without approval.
- **MCP**: complete one "search slots → hold slot → pay deposit" run from an external MCP client (e.g. Claude Desktop).
- **Judge's view**: in an incognito window, using only the README and the testing instructions, the main flow can be completed in 10 minutes. The video is no longer than 2:59. The LICENSE is visible in the About section. The repo contains no secrets.
