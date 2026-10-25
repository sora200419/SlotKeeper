# APIMatic Context Plugin — build prompts for SlotKeeper

These are the prompts used with Claude Code and the APIMatic Context Plugin for PayPal
(`npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`).
They follow the build order in `PLAN.md`. Each prompt names the plugin explicitly so the agent
loads the `paypal:typescript-*` skills before writing code.

Plugin coverage: Orders, Payments, Vault, Subscriptions and Transaction Search through
`@paypal/paypal-server-sdk`. Payouts, Invoicing and webhook signature verification are not in
the Server SDK, so prompts 6 and 4 call REST directly and say so.

Rules every prompt inherits (paste once at the start of a session):

```
Context for this project: SlotKeeper, a Next.js (App Router, TypeScript) app for small
appointment businesses. PayPal sandbox only. Use the PayPal Context Plugin
(paypal:typescript-* skills) for every PayPal Server SDK call, and read the installed SDK source
to confirm signatures. Pin @paypal/paypal-server-sdk to the exact version the plugin names.
Production-ready by default: handle every error path, set timeouts, send a PayPal-Request-Id
on money-moving calls (a stable idempotency key per logical attempt, e.g. booking + action +
attempt, so retries replay instead of duplicating; a random UUID only where no such key exists), never trust amounts from the browser, keep
PAYPAL_CLIENT_SECRET server-only and read all credentials from env vars with a .env.example.
```

## 1. Skeleton and shared client
```
Using the PayPal Context Plugin, set up the PayPal Server SDK in this Next.js app: one shared
Client built from env vars (sandbox environment, client-credentials auth), exported from
lib/paypal/client.ts. Follow the plugin's client-initialization, authentication and
configuration-resilience guidance (timeouts, retry defaults). Add a GET /api/health route that
proves the credentials work without moving money, and a .env.example.
```

## 2. Deposit hold (authorize)
```
Using the PayPal Context Plugin, build the deposit flow: the server creates an Orders v2 order
with intent AUTHORIZE for the service's deposit (price looked up server-side), the browser uses
the PayPal JS SDK v6 one-time payment session, and on approval the server authorizes the order
and stores purchase_units[0].payments.authorizations[0].id on the booking. Use the plugin's
calling-endpoints and models guidance for the request body and the response shape.
```

## 3. Money actions on an authorization
```
Using the PayPal Context Plugin, add server functions for: capture (full or partial, for the
no-show fee), void, reauthorize, and refund of a capture. Map SDK ApiError responses to clear
domain errors following the plugin's error-handling skill (status code, debug_id, issue), and
make each call idempotent with a PayPal-Request-Id derived from the booking and action.
```

## 4. Webhooks (REST, not in the SDK)
```
Add POST /api/webhooks/paypal. Verify the signature on the raw body (transmissionId|time|
webhookId|crc32 with the cert from paypal-cert-url), process each event id once, and update
booking money state for CHECKOUT.ORDER.APPROVED, PAYMENT.AUTHORIZATION.CREATED/VOIDED,
PAYMENT.CAPTURE.COMPLETED/DECLINED/REFUNDED. Push changes to the scheduler over SSE. Where an
event needs follow-up reads (order, authorization), use the Server SDK via the Context Plugin.
```

## 5. Vault spike (saved PayPal wallet)
```
Using the PayPal Context Plugin's Vault guidance, save the buyer's PayPal wallet during the
first deposit (savePayment on the v6 session plus the vault fields in the Orders request), then
create a later order charged with the vault id while the buyer is not present. Run it against
sandbox and report exactly what PayPal returns, including any risk-data requirement.
```

## 6. End-of-day staff payouts (REST, not in the SDK)
```
Add a payouts job that sends each staff member's commission and tips with
POST /v1/payments/payouts, recipient_type EMAIL (sandbox has no PHONE), a deterministic
sender_batch_id per business day, and handling for every item status (SUCCESS, UNCLAIMED,
FAILED, ...). Reuse the access-token handling from the shared PayPal client where possible.
```

## 7. Owner copilot tools
```
Expose the functions from prompts 2, 3, 5 and 6 as Claude tool definitions for the owner
copilot. The copilot must return a plan (booking moves + money actions) first; nothing that
moves money runs until the owner approves, and every executed action is written to an audit
log with the PayPal ids. Use the PayPal Context Plugin to keep the tool schemas aligned with
the SDK models.
```

## 8. Agent-ready booking (MCP server)
```
Add an MCP server exposing search_slots, hold_slot, create_deposit and cancel_booking so an
external AI assistant can book and pay for a customer. create_deposit reuses the prompt 2/5
code paths; use the PayPal Context Plugin for any SDK call it adds.
```

## 9. Monthly report (Transaction Search)
```
Using the PayPal Context Plugin, add a report of deposits captured, no-show fees and refunds
for a date range via Transaction Search: split ranges into 31-day windows, page through
results, and state in the UI that data can lag up to 3 hours.
```

## 10. Tests
```
Using the PayPal Context Plugin's testing skill, unit-test the PayPal layer with a stubbed
HTTP adapter (no network): authorize, partial capture, void, refund, and the declined and
expired-authorization paths. Add an opt-in sandbox test that uses the
PayPal-Mock-Response header for negative testing.
```

## 11. Pre-deploy resilience review
```
Using the PayPal Context Plugin's configuration-resilience skill, review every PayPal call
before deployment: timeouts, which calls may retry (never re-send a capture or refund without
the same PayPal-Request-Id), and logging that never prints credentials.
```
