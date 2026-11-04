---
name: harness-postmortem
description: Mishap postmortem and ledger entry. Use after the user corrects you, after a pitfall forced rework, or after tests / review expose a bug you introduced: find the root cause, decide whether the lesson is global or project-specific, distil one prevention rule of at most 2 sentences into the matching ledger, and output the rule text ready to paste. Also use when the user says "log this mishap", "add it to the ledger", or "summarise the root cause".
---

# Postmortem

A postmortem does not replace the fix: **fix the problem and verify it first**, then do the steps below.

## 1. Root cause (for yourself, 1–3 sentences)

Ask "symptom → direct cause → root cause"; the root cause must land on **why it was done that way at the time**:
- Missing information (did not read the relevant files / docs / existing rules)
- Wrong assumption (thought an API, version, path or environment was a certain way)
- Not verified (declared done without running tests, executing it, or reading the output)
- Out of scope (made changes the user did not ask for)

## 2. Decide where it belongs

| Belongs to | Criterion | Written to |
| --- | --- | --- |
| **Global** | Could happen again in any repository: general language / tool / library pitfalls, security principles, work habits | the global ledger section of `~/.claude/CLAUDE.md` |
| **Project** | Depends on this project's business logic, directory layout, database schema, deploy process or specific versions | `# Mishaps and Prevention Rules` in the project root `CLAUDE.md` |

When unsure, choose **project** (smaller blast radius) and decide during `harness-prune` whether to promote it to global.

## 3. Check for duplicates, then consider automation

1. Read the target ledger. A similar rule exists → **rewrite and merge** that one; do not add a new one.
2. A recurrence of the same rule → append to "Recurrences" in its FAILURES.md entry, and **automate** the rule (a recurrence shows a prompt rule cannot hold it).
3. Anything code can enforce (a hook rule, lint, a test, a type check) → implement that first:
   - Small change (e.g. a rule plus test cases in `.claude/hooks/harness-guard.js`): do it and get the tests passing.
   - Large change: propose it to the user; do not start on your own.
   - Automated rules **do not go** into CLAUDE.md; FAILURES.md "Rule destination" just says `automated as <path>`.

## 4. Write the rule

- At most 2 sentences, in the form "when [trigger] → must [action]"; checkable, no storytelling.
- Good: `Before editing a database migration file, run \`npm run db:diff\` to confirm it matches the live schema.`
- Bad: `Be careful with the database.` (no trigger, cannot be checked)

## 5. Record it

1. **FAILURES.md** (in the current project root; record global lessons here too, since the incident happened here): add `### F-NNN · YYYY-MM-DD · Title`, numbered one above the current highest, filled in using the entry format in that file.
2. Write the **rule line** into the ledger chosen in step 2:
   - Project: `- **[YYYY-MM-DD] Title**: rule. (F-NNN)`
   - Global: `- **[YYYY-MM-DD] Title**: rule. (<tag>: <project folder name> F-NNN)`, where `<tag>` is the source tag the global ledger already uses. Today that is `来源`: the global ledger and the global lint copy `~/.claude/hooks/harness/lint.js` accept only that tag and the heading `# 全局错题集`. This repo's lint also accepts `Source` and `# Global Mishap Ledger`, but use those only once the global lint copy accepts them too.
   - If the global ledger has no ledger heading yet, add the heading the global lint copy expects at the end of the file and append below it.
3. Run the check: project `node .claude/harness/lint.js`; global add `--global`. If the project has no such script, use the global copy `~/.claude/hooks/harness/lint.js`. Fix the format if it fails.

If the user only asked for an "output / summary" and not for a write, skip step 5 and do only step 6.

## 6. Report to the user (fixed format)

````
**Root cause**: … (1–2 sentences)
**Belongs to**: global / project, with a one-line reason
**Written to**: <file path> (or "not written, output only")

```markdown
- **[YYYY-MM-DD] Title**: rule. (<tag>: <project> F-NNN)
```
````

Fill in `<tag>` as in step 5. The rule text in the code block must paste directly into `~/.claude/CLAUDE.md` or the project `CLAUDE.md`.
