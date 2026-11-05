# Mishap Log (FAILURES.md)

> The full story of every mishap goes here. This file is **not** loaded into context automatically (it saves tokens);
> the "Mishaps and Prevention Rules" section of `CLAUDE.md` keeps only one-sentence rules and points back here with an `F-number`.

## Entry format

```markdown
### F-001 · YYYY-MM-DD · One-line title
- **Symptom**: what error the user saw / which step went wrong
- **Root cause**: why it was done that way (missing information? wrong assumption? not verified? rule not read?)
- **Fix**: how it was fixed, with the commit or files
- **Rule destination**: project CLAUDE.md / global ~/.claude/CLAUDE.md / automated as `<file path>`
- **Recurrences**: none (one recurrence means a prompt rule is not enough and it should be automated)
```

## Entries

### F-001 · 2026-10-24 · Writing multi-line files with a Bash heredoc kept failing to parse
- **Symptom**: Writing several TS/TSX files containing quotes, backticks and `${}` in one go with Bash `cat > file <<'EOF' … EOF` failed three times with `unexpected EOF while looking for matching '`. Not one line of the script ran, and the files had to be rewritten with the file tools.
- **Root cause**: Wrong assumption: that a heredoc with a quoted delimiter is always taken literally in this Bash tool. In a long script, several heredocs plus embedded python snippets broke the outer parse, and on failure nothing in the script runs. After the first failure the method was not changed, and the same thing was tried twice more.
- **Fix**: Wrote `components/`, `app/book/`, `tests/paypal/deposits.test.ts` and the other files with the Write / Edit tools; Bash is only for running commands.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-002 · 2026-10-25 · Rethrowing an SDK error unchanged leaked the auth header into logs
- **Symptom**: When the OAuth token request hit TLS interception, Next.js printed the whole axios error to the dev server log, including `Authorization: Basic <clientId:secret>`. Review then found a second path: the SDK's `ResponseValidationError` was not recognised and was thrown as is, carrying the same auth header.
- **Root cause**: Wrong assumption: that the SDK only throws ApiError, and that "rethrow as is" is safe for anything that is not a network error. In fact the SDK's error objects keep the request and its auth header, and Next.js prints error objects in full. While fixing the first path, nobody asked which other error types reach the same `throw err` branch.
- **Fix**: Added `sanitizeError` in `lib/paypal/errors.ts` (keeps only the name and the first line of the message); every fallback branch in health, deposits and the response helpers uses it; new tests assert the secret never appears in the return value, stack, JSON or console output.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: The second path (ResponseValidationError) was found by review in the same feature, so the rule was made global and requires a test.

### F-003 · 2026-10-26 · Money actions did "read → await → write back the old copy" and lost concurrent writes
- **Symptom**: The referee review reproduced it concurrently: with capture and void running at the same time, void's 4xx branch wrote back the booking read before its await. PayPal had captured, but the record was still `deposit_held` with no capture. Two concurrent refunds shared one PayPal-Request-Id and recorded the wrong amount.
- **Root cause**: Wrong assumption: only idempotency and replay within one request were considered, assuming one booking is never acted on twice at once. Nobody asked "what if another request changes this record during the await?"
- **Fix**: `lib/paypal/deposit-actions.ts` got an in-process lock per booking, `withBookingLock`, and reads the booking inside the lock; refunds also check the amount PayPal returns; `tests/paypal/deposit-actions.test.ts` got concurrency tests.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: 2026-10-26, prompt 4 (same day): the webhook handler read the PayPal object outside the lock, then wrote that stale snapshot once it held the lock, so out-of-order events could turn COMPLETED back into PENDING (review R1). The rule said "read the booking inside the lock" and did not cover "external state read outside the lock". Fixed by re-reading inside the lock (`withFreshRead`). The recurrence shows a prompt rule cannot hold this; an automated option (such as a lint check for SDK reads outside a `withBookingLock` callback) is a larger change and was proposed to the user.

### F-004 · 2026-10-26 · A race regression test still passed with the fix removed
- **Symptom**: The regression test written for R1 queued event A ahead of B in the lock, so the bad order never happened; when the referee reverted the fix (a mutation) the test stayed green, and R1 stayed open for a second round.
- **Root cause**: Not verified: the test was only seen passing with the fix, never confirmed to fail without it.
- **Fix**: The test now applies B fully first, then releases A's stale read. Temporarily changing the re-read in `lib/paypal/webhook-events.ts` to `const fresh = first;` made the test fail (Received "PENDING"), and the change was then restored.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-005 · 2026-10-28 · A new charge path missed "total ≤ deposit", once in each direction
- **Symptom**: The first version of prompt 5's saved-wallet charge had no limit on count or total, so a retry after success charged again (review R1). After "count what was already captured" was added, review found the reverse order: charge the wallet while deposit_held, then capture the authorization, and the customer pays twice the deposit (R8).
- **Root cause**: Wrong assumption: the limit was only checked in the new path (wallet charge), and the existing charge path (`captureDeposit`) was not treated as another door to the same money; "a request repeated after success" was not counted as part of idempotency either.
- **Fix**: The wallet can only be charged after the deposit flow has ended (completed / no_show_charged, where the capture is final), at most once per booking, and together with what was captured it cannot exceed the deposit; tests cover both orders and were mutation-checked to fail.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: 2026-10-30, prompt 8 (MCP): one slot could be paid for twice. After an unpaid hold expired and someone else booked the slot, the old PayPal link could still authorize (review R1); after that fix, a cancelled booking could still take a deposit through the browser authorize route (R8). The original rule only said "money" and did not cover "the same scarce resource (a slot)" or "terminal states such as cancelled", so the rule was widened. Automation option (larger, left to the user): a shared "entry list" test for every path that can take a deposit, which a new path must register in.

### F-006 · 2026-10-30 · A daily batch was frozen before the day ended, so late money was never paid out
- **Symptom**: The first version of prompt 6's end-of-day Payouts settled "today" by default and froze it on the spot (nothing_to_pay, or only refreshes after submitted), so income later that day was never paid; money that went from PENDING to completed later was still dated by its first timestamp and also missed (review R1). Re-review found a midnight race: a capture started at 23:59:58 and saved after midnight was missed by a payout run just after midnight (R9).
- **Root cause**: Wrong assumption: the idempotent "compute a batch once, then freeze it" design was applied to a time window that could still change; nobody asked "when does this window really stop changing?"
- **Fix**: Only days that ended more than 15 minutes ago can be settled (default: yesterday); when money goes from PENDING to COMPLETED, settledAt is recorded and the money is dated by the day it completed; PAYPAL_TIMEOUT_MS is capped at 60 seconds so the grace period is longer than any request. All three were mutation-checked to fail.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-008 · 2026-10-30 · A route test depended on the real date (a repeat of the global rule "tests do not depend on the real date")
- **Symptom**: Prompt 9's report route test hard-coded an October 2026 date range, but the route uses the real clock and Transaction Search only allows ranges within three years; around 2029 this required test would turn into a 400 failure by itself (re-review R7). The unit tests had a fixed NOW; the route test did not.
- **Root cause**: Rule not read: the global ledger entry [2026-10-21] already says assertions involving dates must use a fixed date or a fake clock. While writing the route test, only the unit tests that pass the time in had a fixed clock, and it was missed that the route reads the real time inside.
- **Fix**: `tests/api/report-route.test.ts` uses `vi.useFakeTimers({ toFake: ['Date'] })` fixed at 2026-11-01 and restores it in afterEach; setting the clock to 2030 temporarily confirmed the old version fails, then it was restored.
- **Rule destination**: Reuses the global ~/.claude/CLAUDE.md rule "tests do not depend on the real date" (no new entry). This is a recurrence of that rule. Automation option (larger, left to the user): fix Date for every test in vitest's setupFiles, ruling out the real date at the root.
- **Recurrences**: First recorded as Fiverr F-007; this entry is its recurrence in this project.

### F-007 · 2026-10-30 · A multi-step plan threw an unknown error half way and stayed stuck in executing
- **Symptom**: Prompt 7's approvePlan rethrew errors it did not recognise (such as a PayPalConfigError while building run_payouts dependencies): earlier charges had already happened, but the plan stayed in executing and could no longer be approved or rejected, results were not written back, and the failed step never reached the audit log (review R1).
- **Root cause**: Wrong assumption: the single-request habit "rethrow unknown errors to the caller" was used in a multi-step executor that had already caused side effects; nobody considered who cleans up after the rethrow.
- **Fix**: stepError never throws; an unknown error is recorded as unexpected_error (keeping only the sanitised name and first line), and the plan is always marked failed, its results written back and audited; mutation-checked to fail.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-009 · 2026-10-30 · A mapping table existed twice, only one copy was changed, and authorize's decline path was missed
- **Symptom**: Prompt 10's sandbox probing found decline codes such as PAYER_CANNOT_PAY were not mapped; only DECLINE_ISSUES in `deposit-actions.ts` was changed. The set with the same name in `deposits.ts` was not, so when authorize was declined with TRANSACTION_REFUSED / PAYER_CANNOT_PAY it became paypal_error and the declined order kept being reused (review R1).
- **Root cause**: Not verified: probing only covered capture, void, reauthorize and refund, not authorize; and before changing the mapping nobody searched for constants with the same name, assuming there was only one.
- **Fix**: Added both codes to `lib/paypal/deposits.ts`; `tests/paypal/negative-paths.test.ts` asserts declined, orderSpent and a new order on the next try, and the sandbox table was updated to match; with the fix reverted, 2 tests fail.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-010 · 2026-10-31 · A gateway refusal on an idempotent replay was taken as "nothing happened", so the next try with a new id could charge twice
- **Symptom**: Prompt 11's audit found that replaying a wallet charge after PayPal's retention period (6 hours on Orders) becomes a new charge, and that 408/409 were treated as definite failures. Fixing those missed another layer: a replay answered with 429/401 still cleared the pending action and switched to a new id (review R1). After that fix, authorize replays had no end, and a booking could get stuck (N1).
- **Root cause**: Wrong assumption: "4xx = nothing happened" was applied to replays. That answer only says this replay was refused, not what happened to the first send; the idempotency key's retention period was never checked either.
- **Fix**: `isDefiniteRefusal(failure, replay)`: on a replay only a 422 counts as settled; money actions get replay windows from the retention periods (5 hours / 44 days), authorize likewise 5 hours, and past the window the booking goes to manual review; all three fixes were mutation-checked.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-011 · 2026-10-31 · Lifecycle behaviour was proved with mocks and did not hold in a real process
- **Symptom**: The first version of persistence only checked the SIGTERM flush by calling the handler with mocks; the referee probed a real `next start` and Next exited with 143 first, so the flush never finished (R3a). In the same round two more tests still passed with their fixes removed: the name-check test used a date that was rejected anyway, and the race test never landed in the microtask gap. A record that could not be written to jsonb could block the whole write queue (R1).
- **Root cause**: Not verified: the tests checked "what the handler does when I call it", not "what happens when the platform stops the process"; and nobody asked "what if the head of the write queue can never be written?"
- **Fix**: `NEXT_MANUAL_SIG_HANDLE` takes over signals, and the process exits after locks and writes finish; compared on a real `next start` (without the flag 143 / 4 ms, with it 0 / 3050 ms); permanent errors leave the queue, and the entry point rejects characters that cannot be stored; the two decorative tests were rewritten and mutation-checked.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-012 · 2026-10-31 · The version check compared against "the last version seen", not "the version this save is based on"
- **Symptom**: The first version check passed all 554 tests, and the referee reproduced three silent-overwrite paths with real SQL: after a flow read a record, polling advanced the version, so stale data passed the check; a queued second save kept writing after a conflict; and after writing the conflict record failed, a retry with the new version succeeded. A missing migration also stopped the service from starting, and content comparison mistook our own writes for conflicts (R1-R5).
- **Root cause**: Wrong assumption: optimistic locking was treated as "add a WHERE to the write", without asking at which moment the version number is bound to the data; tests only covered the basic "a stale write arrives" case, and each was first made to pass.
- **Fix**: Records are pinned while a lock is held (re-read on taking the lock, caught up on release); writer ids tell our own writes apart; on a conflict every queued save is dropped, and the version only advances after the losing write is stored; added a migration and a trigger; mutation checks caught 3 more decorative tests, which were rewritten.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-013 · 2026-10-31 · A local build passing was taken as done; the live build ran out of memory three times, and live state was misreported
- **Symptom**: After Bryntum was added, `next build` failed on Render three times with memory over 8 GB. I did not look at the deploy results, and told the user "the Blueprint did not sync, there is no database live", while the user's dashboard showed the database had been created automatically on push and the live service was still on the old 69fbb41.
- **Root cause**: Not verified: the local machine's 32 GB of memory hid Turbopack's 21 GB peak, and only the exit code was checked; the statement about live state came from guessing, not from the platform's records.
- **Fix**: `npm run build` uses webpack, with a clean-build peak of 3.28 GB; the board, SSE, MCP and the exit on database failure were checked in production mode.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-014 · 2026-11-04 · Submission copy treated "reads" as "features" and overclaimed in three places
- **Symptom**: After the README and Devpost copy were written, the referee found three claims that did not match the code: "booking page times are UTC" (the input actually uses the browser's local time; only the confirmation page shows UTC), "enter a nickname" (the form field is called Your name), and payouts include tips (`tipCents` is only read, never written, so it is always 0; and I had listed tips as to-do under What's next, contradicting myself).
- **Root cause**: Not verified: feature descriptions were written from memory and from partial code that was read (`toUTCString`, `tipCents ?? 0`, a comment in store.ts), without going back to the form and the write points to check each one; overclaiming in copy for judges costs points directly.
- **Fix**: All three now match the code; grep confirmed `tipCents` has no write point, and every mention of tip, UTC and nickname in the README and devpost was checked.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

### F-015 · 2026-11-05 · Four questions answered with only a summary box
- **Symptom**: The user asked four questions (where to rotate the secrets, MCP test steps, the judge token, Bryntum). After one read-only command I called the end-of-turn wrap-up tool, whose recap said "Answered all four questions", and wrote no answer; the tool then forbade text after it, so the user received only a recap and a follow-up question.
- **Root cause**: Wrong assumption: I treated the wrap-up recap as the reply, and called the turn-ending tool before writing the answer it summarised.
- **Fix**: The answers were written in full in the next turn.
- **Rule destination**: global ~/.claude/CLAUDE.md
- **Recurrences**: none

## Pruning log

| Date | Action (delete / merge / automate / promote to global) | Entries | Notes |
| --- | --- | --- | --- |
