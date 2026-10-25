# SlotKeeper

AI assistants are starting to book appointments for people, and small businesses eat the no-shows.
SlotKeeper makes every booking, human- or agent-made, payment-backed with PayPal, and lets the
owner re-plan the whole day in one sentence.

Built for the PayPal AI Hackathon (PayPal sandbox only). Status: **skeleton** — the PayPal Server
SDK is wired up and a health check proves the sandbox credentials work.

## Run locally

Requires Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local   # then fill in your sandbox client ID and secret
npm run dev
```

Open http://localhost:3000/api/health. `{"ok":true,...}` means the PayPal sandbox credentials work.
The check only requests an OAuth token; it creates nothing and moves no money.

**Troubleshooting: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / "TLS certificate could not be verified".**
Antivirus software (AVG, Avast, …) or a corporate proxy that inspects HTTPS re-signs traffic
with its own certificate, which Node doesn't trust by default. Start the server so Node uses the
Windows certificate store, where that certificate is installed (on Node 22 the
`NODE_USE_SYSTEM_CA` variable is ignored; the `--use-system-ca` flag works):

```powershell
$env:NODE_OPTIONS = '--use-system-ca'; npm run dev
```

```bash
npm test          # unit tests (no network)
npm run typecheck
npm run build
```

## How the PayPal integration is built

- `@paypal/paypal-server-sdk` 2.5.0, one shared client per server process (`lib/paypal/client.ts`).
- Explicit 15 s timeout and retries for idempotent methods only. The SDK's generated defaults are
  "no timeout" and "no retries"; money-moving POSTs are never re-sent by the SDK.
- Credentials come only from environment variables. The client secret is server-only.

### APIMatic Context Plugin

The PayPal Server SDK code is written with Claude Code and the
[APIMatic Context Plugin for PayPal](https://github.com/paypaldev/server-sdk-context-plugin-preview)
(`paypal:typescript-*` skills). The prompts are in [`docs/apimatic-prompts.md`](docs/apimatic-prompts.md).
Things the plugin caught that a generic model would have missed:

- The SDK's default timeout is `0` (wait forever) and retries are off unless
  `maximumRetryWaitTime` is also raised.
- `OAuthProviderError` imported from the package root is a same-named enum, not the error class,
  so `instanceof` silently fails; errors are matched on `ApiError` and the status code instead.
- Error payload fields keep PayPal's wire names (`error_description`), not camelCase.

## License

MIT — see [LICENSE](LICENSE).
