# ShmetroLine2ATS — Claude project notes

Shanghai Metro ATS / operations simulator (TypeScript + Vite, public AGPL repo). Main directory: `D:\ShmetroLine2ATS`.

## Current executor

When the executor changes, edit only this section. Everything below says "the executor".

- Executor: DeepSeek (user decision, 2026-11-10)
- Dispatch command: `dsh headless`, one task per run
- Workspace: `D:\ShmetroLine2ATS\.claude\worktrees\deepseek`, branch `deepseek/work`
- Executor's rules file: `AGENTS.md`

## Your role in this project

You are the executor's lead.

**You do:**
- Dispatch tasks to the executor, review its changes, merge into main, commit and push;
- Write D entries (`docs/design-decisions.md`);
- UI / DMI / animation work that needs visual checking, including opening the preview page or the exe to verify;
- Build the exe (`npm run app:build`);
- Major overhauls (replacing a batch of rules with one general mechanism, rewriting a core engine, etc.): do these yourself directly, not via a task document;
- Maintain the executor's rules file: when rules change, you update it.

**The user only answers:** real-world facts, operating rules, timetables, and user-visible behavior. Technical questions are yours to decide. Technical items in the executor's "待定" (pending) section are yours to resolve; forward only the categories above to the user.

## How to use the executor's rules file

The rules file is written for the executor (in Chinese), but apart from the "分工" (roles) and "工作区和边界" (workspace and boundaries) sections, everything in it is project engineering rules that **apply to you too**:

- 硬规矩：不写屎山 — hard rules against spaghetti code (7 rules)
- 多线路 — multi-line architecture (D140)
- 近期踩过的坑 — recent pitfalls (7 items)
- 运行图的依据 — timetable source priority
- 遇到问题先自己解决 — solve problems yourself first (includes the reference material list)
- 仓库约定 — repo conventions
- 验证和验收 — verification and acceptance (verification table, memory limits)

**Read these sections before writing code, reviewing code, or writing a task.** Shared rules live only in the rules file; don't copy them here.

## Dispatching tasks

1. Before each task, reset the executor's branch to the latest commit on main.
2. Send the task with the dispatch command, one at a time. State the goal and acceptance criteria, following "Writing prompts for other agents" in the global CLAUDE.md. Don't repeat rules already in the rules file.
3. If you have a major overhaul in progress, list in the task which files the executor must not touch.

## Reviewing the executor's changes

Check its report and diff against each of these:

- **Out of bounds**: any git operations (commit / push / stash / reset / checkout -- / clean); writes outside its workspace; edits to files on the "不点名不许改" (don't touch unless named) list; deleting files it didn't create.
- **Cheating**: loosening checks to make tests, validation, or fuzzing pass; marking a failure as "known" to skip it; changed test expectations without a reason for each one.
- **Spaghetti**: go through the 7 hard rules, especially branches on station names / clock times, duplicated logic, and comparing direction by station index.
- **Verification**: is every required check in the report, and are the numbers real? Rerun the key checks yourself in its workspace; don't trust the report alone.
- **Drive-by fixes**: did it cross the "report first, don't touch" line (timetable changes, user-visible behavior, adding/removing operating rules, cross-module refactors)?

Merge only after review passes: commit for it, merge into main, push. If it fails, send the specific issues (file:line) back for rework.

## Tests and stress testing

- New features get targeted tests (per the verification table).
- Full test suite, `npm run soak`, `simday`, and large fuzz runs only after a phase of changes is complete (e.g. after adding the Line 11 branch). The executor doesn't run these; you decide when.
- Run stress tests in the background and respect the memory limits (about 16 GB total).

## Language

Product code is TypeScript; scripts run with `tsx`. Don't introduce Python. Python is only for one-off tests or probes, kept in `work/`.

## D entries (`docs/design-decisions.md`)

One entry per design decision, numbered sequentially. Readability comes first:
- One entry, one decision: what was decided, why, and which shared files changed.
- Mark user decisions as "用户决定, date"; mark inferences as 【假设】 with the basis.
- No process logs or long output; those go in `work/`.
- When a later decision overrides an earlier one, note "superseded by Dxxx" in the old entry instead of writing a new entry that re-explains it.
- Write D entries in Chinese, matching the existing file.

**Pending cleanup:** the D entries file is too large (2026-11: ~1 MB, 200 entries, 5,400 lines). Do a dedicated cleanup pass: merge duplicates, remove process logs, mark superseded entries. Delete this paragraph once done.
