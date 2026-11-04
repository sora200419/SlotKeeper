# Devpost submission text for SlotKeeper

Paste each section into the matching Devpost field. Items in **[brackets]** need a value or a check
before submitting.

## Project name

SlotKeeper

## Elevator pitch (about 200 characters)

Every booking, human- or agent-made, backed by a PayPal deposit hold, and an AI copilot that re-plans the owner's day: it proposes, the owner approves, every money action is audited.

## Story

### Inspiration

Small appointment businesses (salons, physio studios, tutors, groomers) live on a calendar and lose money when people do not show up. At the same time AI assistants are starting to book appointments on people's behalf, and a business that takes bookings from assistants has no way to know the booking is real. A deposit hold on PayPal answers both: the slot is committed, and nobody is charged unless something happens. We also wanted to see how far an AI can go in a business that moves money, and our answer was: it plans, a person approves, and the code checks everything in between.

### What it does

- A customer books a slot and PayPal holds a deposit on their account. Nothing is charged yet.
- The owner can capture the deposit when the service happened, charge a no-show fee (a partial capture, and the rest of the hold is released), void the hold, reauthorize it, or refund.
- The owner's day is a live board, coloured by deposit state. PayPal webhooks and staff actions update it as they happen.
- The owner types what changed ("Maria is sick tomorrow, move her clients to Ken"). Claude reads the bookings with read-only tools and proposes a plan. The plan is previewed on the schedule before anything runs, checked in code, and executed only after the owner approves. Each step is written to an audit log with its PayPal ids.
- A customer's AI assistant can book through our MCP server. It reserves a slot and gets a PayPal approval link; the customer approves the deposit in PayPal. The assistant never moves money.
- Customers can opt in to save their PayPal wallet so a no-show fee can be charged later, once, without them present.
- At the end of the day one Payouts batch pays each staff member their commission (the batch format already carries tips, but nothing creates tips yet), and a report reads captured deposits, no-show fees and refunds from Transaction Search.

### How we built it

PayPal is the core of the product, and each capability does a job the business needs:

- **JS SDK v6 + Orders v2:** the customer approves a deposit order created with intent `AUTHORIZE`; the server authorizes it and stores the authorization id.
- **Payments v2:** capture (full, or partial with `final_capture` for a no-show fee), void, reauthorize and refund, plus read-backs of authorizations, captures and refunds.
- **Vault:** the wallet is saved at checkout, and a later merchant-initiated order with the vault id completes with no buyer action.
- **Payouts:** one frozen batch per finished business day, paid by email.
- **Transaction Search:** the deposits report, in 31-day windows.
- **Webhooks:** signatures are verified locally; the event is only a pointer, and the object is re-read from PayPal under the booking's lock.
- **`PayPal-Request-Id` and `PayPal-Mock-Response`:** stable idempotency keys on every money call, and negative testing against the sandbox.

The AI parts:

- **Owner copilot:** Claude Haiku 5.5 (configurable) through the Anthropic API, with read-only tools and a `propose_plan` tool. The plan is validated in code, previewed on a Bryntum Scheduler, and executed through the same functions and locks as the staff routes only after approval. The model never receives a tool that moves money.
- **MCP booking server:** `search_slots`, `hold_slot`, `create_deposit`, `cancel_booking`, `booking_status` for customers' own assistants, with a per-booking token, rate limits and a 30-minute hold.

Stack: Next.js (App Router) and TypeScript, Postgres, Render (Blueprint, web service, database), Bryntum Scheduler, `@paypal/paypal-server-sdk` written with Claude Code and the APIMatic Context Plugin.

### Challenges

- **Money that may or may not have moved.** A timeout on a capture does not tell you whether PayPal captured. We keep such an action pending and replay it with the same request id, and refuse to replay once PayPal would have forgotten the id, because a replay then becomes a second charge.
- **Two servers during a deploy.** The old and new instance overlap, so every record carries a revision, a flow works on a pinned copy while it holds its lock, and a losing save is kept as a conflict record and sent to staff review.
- **Sandbox behaviour differs per endpoint.** Sending `PayPal-Mock-Response` to the real sandbox showed decline codes our first mapping missed on authorize, and an endpoint that answers an empty 403 for a code another endpoint accepts.
- **Build memory.** The Bryntum package pushed a Turbopack production build past 20 GB; Render stops a build at 8 GB, so we build with webpack (about 3 GB).

### Accomplishments

- A full deposit lifecycle exercised against the PayPal sandbox: authorize, no-show capture, refund, void, saved-wallet charge, a payout batch and webhook deliveries.
- 579 unit tests over the real SDK with a stubbed transport, plus an opt-in suite against the sandbox.
- An owner interface where the AI's proposal is visible on the schedule before it can do anything.

### What we learned

Putting an AI next to money is mostly a question of what the AI is allowed to be: here it is an author of proposals, and everything that touches PayPal stays in ordinary, tested code with idempotency, locks and an audit trail. The hard bugs were not in the AI part; they were in "what if this call timed out", "what if two requests arrive together", and "what if the old server is still running".

### What's next

- Buttons for capture, no-show fee, void and refund on the board (today they are API routes plus the copilot).
- Invoicing for the balance and tips, with the tip counted only once it is actually received.
- A waitlist that fills a freed slot and collects its deposit.
- Row-level database locks so the app can run on more than one instance.
- Trying the MCP booking flow with more assistants end to end.

## Tools (what each is used for)

- **PayPal:** JS SDK v6 (customer approval), Orders v2 (deposit order and authorization), Payments v2 (capture, void, reauthorize, refund), Vault (saved wallet), Payouts (staff pay), Transaction Search (report), Webhooks (settlement and live updates).
- **AI:** Claude Haiku 5.5 via the Anthropic API (owner copilot, configurable to Sonnet 5.5 or Opus 5.5); Model Context Protocol server for customers' assistants; Claude Code with the APIMatic Context Plugin for PayPal (wrote and reviewed the integration code).
- **Other:** Bryntum Scheduler (staff board), Render (web service, Postgres, Blueprint), Next.js, TypeScript, Vitest.

## Built with (tags)

paypal, nextjs, typescript, claude, mcp, postgresql, render, bryntum, apimatic

## Try it out

- Live demo: https://slotkeeper-93dy.onrender.com
- Code: https://github.com/sora200419/SlotKeeper
- **[Video link]**

## Testing instructions

Paste this into the Devpost testing field. It repeats the README's "Try it (for judges)".

> **Needs:** a PayPal sandbox personal account (yours, from developer.paypal.com > Testing tools > Sandbox accounts). No credentials of ours are needed to book. Everything is sandbox; no real money moves. Bookings are shared, so use a nickname.
>
> 1. Open https://slotkeeper-93dy.onrender.com/book, pick a service, type a nickname in the "Your name" field and choose a time within the next 3 days (PayPal holds an authorization for 3 days). The time box uses your browser's local time; the confirmation page shows UTC.
> 2. Click "Book and hold deposit" and pay with the PayPal button using your sandbox personal account. The page shows "Deposit held" and the PayPal authorization id.
> 3. Staff screens need a token: **[STAFF TOKEN, or say how to get one]**. Open https://slotkeeper-93dy.onrender.com/staff, enter it, and your booking is on the board.
> 4. Staff money actions are API routes with `Authorization: Bearer <token>`, for example `POST /api/bookings/<id>/deposit/capture` with `{"reason":"completed"}`, or `{"reason":"no_show","amountCents":400}` for a no-show fee; also `/deposit/void` and `/deposit/refund`. The board updates by itself when PayPal's webhook arrives. Full examples: README, "Try it (for judges)".
> 5. In the copilot panel on /staff, describe a change, such as "Cancel Ana's booking and release her deposit". Review the plan previewed on the schedule, press "Approve and run", then open the "Audit log" tab. **[Only if the copilot has an API key and budget during judging.]**
> 6. MCP: connect an MCP client to https://slotkeeper-93dy.onrender.com/api/mcp (Streamable HTTP) and use `search_slots`, `hold_slot`, `create_deposit`.

## GitHub repository "About" (set by hand in the repo settings)

- Description: AI front desk for appointment businesses: every booking is backed by a PayPal deposit hold, and an AI copilot proposes day plans that the owner approves. PayPal AI Hackathon.
- Website: https://slotkeeper-93dy.onrender.com
- Topics: paypal, hackathon, nextjs, typescript, mcp, claude, postgresql, render, bryntum

## Before submitting: things this text depends on

1. **Staff token for judges:** the organizers said both "don't share credentials" and, in the Devpost rules, that testing credentials may go in the testing field. Decide what to hand out; the token also allows sandbox capture, refund and payout.
2. **Copilot needs an API key, a spending cap, and one real run.** Until that run, the copilot has only been exercised with a scripted model in tests and in the browser.
3. **MCP with a real assistant:** the protocol handshake and the tool list have been checked on the live server, and the booking flow in unit tests. Whether PayPal returns the approval link for an order created with `return=minimal` has not been confirmed live.
4. **Impact:** add one sourced figure about no-shows or cancellations in appointment businesses; none is stated above because none has been verified.
5. **Video, screenshots, and the video link.**
