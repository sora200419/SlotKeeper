---
name: harness-review
description: Referee review before delivery. Use after writing, refactoring or fixing code, before declaring it done or committing. Calls the independent subagent harness-reviewer to review the change, and handles every issue with "fix it or show evidence" until no blocking issue is left. Also use when the user says "review this", "review", or "get a referee to look at it".
---

# Referee review (fix it or show evidence)

Do not grade your own work. The review must go to an independent subagent, in a fresh context.

## 1. Prepare the review scope

- Change scope: `git status` + `git diff` (add `git diff --cached` for staged changes); outside git, list the changed files.
- Task goal: the user's own words, or a one-sentence summary.
- Test command: from "Common Commands" in the project `CLAUDE.md`.

## 2. First review

Call the `harness-reviewer` subagent with the Agent tool. The prompt contains only: the task goal, the change scope (file list or diff command), and the test command.

**Do not** add your own view of the code's quality or phrases like "I already checked X"; that biases the referee.

## 3. Handle each issue: fix it or show evidence

For every `Blocking` / `Important` issue, choose one:

| Response | Requirement |
| --- | --- |
| **Fix** | Change the code; add a test covering the issue; run the closing-condition command and keep its output |
| **Refute with evidence** | Write an automated test that reproduces the scenario and shows the behaviour is correct; attach the command and its passing output |

Never:
- Declare "this is not an issue" or "already handled" without evidence
- Delete or weaken tests, add skips, or change expected values to make tests pass
- Skip the tests and move on

`Suggestion` issues may be left unchanged, but list them in the report with the reason.

## 4. Re-review

Call `harness-reviewer` again (a new call, in re-review mode) with: the previous issue table + how each item was handled + the evidence commands. The referee reruns the commands itself.

- Verdict PASS → go to step 5.
- Blocking issues remain → back to step 3. **At most 3 rounds**; if round 3 still fails, stop and report the disagreement to the user, who decides.

## 5. Report to the user

```
## Review result: PASS (N rounds)

| ID | Severity | Issue | Handling | Evidence |
| --- | --- | --- | --- | --- |
| R1 | Blocking | … | Fixed | `npm test` → 42 passed |
| R2 | Suggestion | … | Not adopted | reason |
```

If a blocking issue is the kind that "would happen again in another situation", run `harness-postmortem` to log it after the review.
