---
name: harness-prune
description: Periodically trim the harness ledgers (about every 1–2 months). For each rule, ask "which real mishap does this prevent?", then merge, automate, promote to global, or delete rules, so CLAUDE.md does not bloat until the model ignores what matters. Run only when the user asks.
disable-model-invocation: true
---

# Ledger pruning

Goal: keep the ledgers short and effective. The more rules there are, the more easily the model ignores the few that really matter.

## 1. Check

```
node .claude/harness/lint.js
node .claude/harness/lint.js --global
```

If the project has no `.claude/harness/lint.js`, use the global copy `~/.claude/hooks/harness/lint.js`. Note the rule counts and any entries that are too long, too old, or missing a source.

## 2. Review each rule

For every rule in the project `CLAUDE.md` "Mishaps and Prevention Rules" and in the global ledger of `~/.claude/CLAUDE.md`, answer:

1. **Which real mishap does it prevent?** No F-number or source → candidate for **deletion**.
2. **Can that problem still happen?** The underlying code was refactored, the dependency upgraded, or the model no longer makes the mistake (no recent recurrence) → candidate for **deletion**.
3. **Can a machine check it?** It can become a hook rule, lint, a test or a type constraint → candidate for **automation** (remove it from the prompt once implemented).
4. **Is it the same kind as another rule?** Several rules about specific small bugs → candidate for **merging** into one more general principle.
5. **Would other projects hit it too?** A general lesson in a project ledger → candidate for **promotion to global**; a global rule that only applies to one project → candidate for **demotion** to that project.

## 3. Propose, and wait for the user's decision

List every candidate action in a table; **do not change any ledger before the user confirms**:

| Rule | Action | Reason | Replacement (where the automation lives / the merged text) |
| --- | --- | --- | --- |

## 4. Carry it out

- Change the ledgers as agreed; for automation, implement it and get the tests passing first (`node --test ".claude/harness/tests/*.test.js"`), then delete the rule line.
- Deleted rules are not lost: their FAILURES.md entry stays, with "Rule destination" noting `deleted (pruned YYYY-MM-DD)` or `automated as <path>`.
- Add a row to the "Pruning log" table in FAILURES.md.
- Run the step 1 check again and confirm there are no errors.

## 5. Report

Rule counts before and after (project / global), how many of each action, and any new automated checks.
