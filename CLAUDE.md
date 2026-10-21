# PayPal Project Guide

> Claude Code loads this file automatically at the start of every session. Only put in what must be known every time; incident details go in `FAILURES.md`.
> Every rule must be able to answer: "which real mishap does it prevent?" Rules that cannot answer get deleted during `harness-prune`.

## Project Overview
<!-- TODO: One or two sentences: what this project does, who it is for, core tech stack -->

## Common Commands
- Install dependencies: `TODO`
- Run locally: `TODO`
- Test: `TODO`
- Lint / format: `TODO`
- Build / package: `TODO`
- Harness self-check: `node .claude/harness/lint.js` · `node --test ".claude/harness/tests/*.test.js"`

## Coding Conventions
<!-- TODO: Only conventions the linter / formatter cannot enforce, e.g. naming, layering, error-handling style -->

## Architecture and Business Constraints
<!-- TODO: Database schema limits, module boundaries, directories or generated files that must not be edited directly -->

## Deployment
<!-- TODO: Special release steps, environment differences, checks that must run before going live -->

## Harness Workflow (mandatory)
1. **Log every mishap**: After the user corrects you, or after you hit a pitfall and had to redo work, fix it first, then run the `harness-postmortem` skill and write one prevention rule of at most 2 sentences into the right ledger (global or this file).
2. **Pass the referee before delivery**: After writing or refactoring code, do not declare it done or commit it. First run the `harness-review` skill, which hands the change to the independent subagent `harness-reviewer`.
3. **Fix it or show evidence**: For every issue the review raises, either fix it or paste the automated-test command and its passing output. Never close an issue without evidence, and never edit tests to make them pass.
4. **Gates cannot be bypassed**: If a hook blocks you, do not work around it (switching to PowerShell, splitting the command, `--no-verify`, etc.). Explain the reason to the user and let the user decide whether to run it themselves.
5. **Automate instead of prompting**: A rule that can be enforced by a hook / lint / test should be written as code and only recorded in `FAILURES.md`, not take up space in this file.

# 错题与防范规程
<!-- Heading kept in Chinese on purpose: .claude/harness/lint.js matches this exact line. It means "Lessons learned and prevention rules" (the project ledger). -->
<!-- Format: - **[YYYY-MM-DD] Title**: rule (at most 2 sentences, state "in what situation -> what must be done"). (F-number) -->
<!-- One-sentence rules only; the full story goes under the matching number in FAILURES.md. Limit 30 entries; run harness-prune before exceeding it. -->
