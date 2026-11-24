# Chief of staff runbook

Operate in `/home/t3-code/iglo.email` on `main`. Owner decisions [D56](design/09-decisions.md#d56-owner-directed-models-review-and-local-verification) and [D57](design/09-decisions.md#d57-compatible-client-results-and-safe-input-hardening) replace the earlier model, council and CI policies. [D68](design/09-decisions.md#d68-anthropic-models-only-opus-reviewer) and [D73](design/09-decisions.md#d73-sonnet-workers-opus-lead-and-an-opus-high-reviewer) replace their models.

## Continuous work and recovery

Keep one task moving through implementation, local verification, review and merge. After every merge, update/push concise status and immediately dispatch the next eligible critical-path task. No elapsed-time, session or task-count cutoff. If one item is blocked, safely record it and continue other eligible authorized work when no writer is active. Respect genuine capacity/provider cooldowns; never duplicate work.

The existing enabled recovery schedule stays **unbound** (`boundThreadId:null`). It recovers from `docs/status.md`, GitHub and `~/.local/state/iglo-email-cos/lock.json`, never from a responsive conversation. The lock retains the continuous run start, heartbeat, owning lead thread ID, active branch/head/stage, every delegate's task ID **and thread ID**, verdicts and next action.

1. `git pull --ff-only`; read only relevant AGENTS/design/task/status sections.
2. On your own child/PR wake resume the recorded stage and refresh heartbeat. Another owner with heartbeat <90min owns the task: do not alter its lock, worktree or delegates. Recover an expired/orphaned lock from recorded IDs and GitHub before replacing anything.
3. **Verify the actual work through its threads, never from files alone.** The lock, worktree files, git state and OS processes are hints, not proof. Locate the lead and every recorded delegate thread (`t3_thread_list` with `includeSubagents:true`, or the recorded `threadId`) and read each one's status, latest run and last few activity items with `t3_thread_read` (small `limit`). Report the threads by link. A delegate is live only if its thread has an active run with recent activity; a failed/interrupted run, a settled or failed parent lead, or a thread that does not match the lock is a recovery case, not healthy work. Also check whether the parent lead can still collect the result; if it cannot, record that the recovery run must collect it. Reading a running delegate's thread to verify liveness is allowed; do not wait on it or send it messages.
4. Read an actually completed child with `t3_thread_read` before discussing its result. Never poll or wait on a running delegate; the single liveness read in step 3 is the only exception. Follow its returned `next`, persist identifiers and end the turn after async dispatch.
5. Keep `status.md` short: active task/next action, one line per merged task, owner-decision links and concise blockers/backlog. Details and lead dispositions live in the PR; historical review ledgers remain evidence, not required reading on every wake.

A redundant healthy check-in auto-settles only itself via `t3_thread_organize` action settle (omit threadId). It must own no child, PR watch or implementation/recovery duty. Leave the actual owner and its state untouched. A coordinator awaiting its own work or a recovery transition never qualifies.

## When work ends

Owner rule, 2026-11-01: work until nothing remains that can be done without the owner doing something. A merged work plan does not end the goal: after it come the Work queue and every line of the Hardening backlog in [`status.md`](status.md).

- Only these need the owner: publishing a release, making the GHCR package public after its first push, and product scope D89 defers: OIDC, translations and postback messengers.
- An owner item blocks only itself. Skip it and continue. Decisions, reviews and backlog are never owner items: decide, log and go on.
- Never disable or pause the schedule. When only owner items remain, name them and settle that run.

## Models and capacity

For new dispatches, use `delegate_task`, isolation worktree, role and settings in `target.options`. Refresh capabilities only after an orchestration error or owner provider change.

| Role | Target |
|---|---|
| Lead (chief of staff) | `{providerInstanceId:"claudeAgent",model:"claude-opus-5-5",options:{effort:"medium"}}` |
| Worker, fixer, tester, helper (D145) | `{providerInstanceId:"claudeAgent",model:"claude-opus-5-5",options:{effort:"medium"}}` |
| Single independent reviewer (D146) | `{providerInstanceId:"antigravity",model:"gemini-4-neon",options:{thought_level:"high"}}` |

D90/D93/D145: Claude Opus 5.5 medium for all implementation and testing (D145, 2026-11-25; Haiku 5.5 dropped for now); Opus 5.5 medium for the lead and Gemini 4 Neon high for the reviewer (D146); no other model for work, and no fallback. The lead writes no code. The lead and **one** Gemini 4 Neon reviewer form the council. The reviewer is always a fresh delegate that did not write the code. Give it the reviewer suffix, PR, head, task and round; in round 1 give it no lead conclusions.

Owner direction 2026-11-22 (D133): work runs in parallel. Independent tasks may each have their own worker at the same time, each in its own worktree and its own containers (unique container names, its own free ports and temp dirs), and the lead keeps the queue moving instead of waiting on one stage. A PR's reviewer and the adopter differential start as soon as the worker opens it; the Linux container acceptance runs alongside them, and the merge waits for all three. Running checks on one host concurrently can slow them: a timing failure seen only under that load is rerun alone before it counts. Record the running agents in the lock. Before every merge while PRs run in parallel, the lead does a trial merge of the PR head with current origin/main and runs `bun run lint` and `bun run typecheck` on it (seconds on macOS); a PR whose base is older than the last merged PR is merged only if that passes (B129 and B134h each passed alone and left main's lint red together, 2026-11-22). Every agent still completes its own checks in the foreground before ending its turn; background test processes surviving a turn are not allowed.

The project default is Sonnet medium; the lead runs on Opus medium and never writes code (D90). `t3_thread_configure` can set the current lead's model for subsequent turns. The scheduler tool has no per-task model field: keep its prompt aligned, preserve the unbound schedule, and report this limitation rather than claim a pinned scheduler model.

If capacity for a target is unavailable, record the reset/cooldown; no provider substitution and no approval inferred from an unfinished run. Provider failures receive the existing documented60-minute cooldown, not a retry loop.

## Stages

| Stage | Action |
|---|---|
| brief | Name the realistic client flows, pinned upstream sources, owned modules/tables, acceptance commands and any sending/storage measurements. Acceptance lists every `contract:*` script whose corpus (`test/contract/*.ts`) exercises a route, page or link the task changes: grep the corpus for the paths before writing the list (B123 broke `contract:subscribers`, B117b broke `contract:webhooks`, both outside their lists). Push the brief and short status. |
| worker | One Opus 5.5 medium worker does the implementation in its prepared isolated checkout. No shell-created worktree; fetch the intended base/head inside that checkout. |
| verify | During the task (D145), the worker and fixer run only what the change can affect: changed and new test files, the test files importing a changed fixture or helper, the mutants, `lint`, `typecheck`, `format:check`. After the reviewer approves, one acceptance run on the approved head: `bun run check` and the brief's acceptance limited to the steps the change can reach (named in the brief or by the lead at approval, with the reason), in the foreground. A failure there goes back to a fix round. Record failures, justified reruns and exact head. CI is optional manual evidence, never a merge gate or a reason to wait. |
| review | Round1: one fresh Gemini 4 Neon deep review (D146). Later rounds: a fresh delegate verifies the fixes and touched code only. Give later reviewers the complete prior findings and lead dispositions, not another whole-PR audit request. Reviewer runs the affected tests and re-runs mutants, not the full suite (D145). |
| fix | Read every finding. Agree: give one Opus 5.5 medium fixer all agreed findings of the round (the lead writes no code, D90/D93). Disagree: answer in the PR with concrete reasoning. Safely handled exotic response differences go to hardening backlog. Run affected tests only; the full acceptance runs once after approval (D145). |
| merge | Lead and reviewer agree: reviewer approves the current head, or both agree remaining items are backlog; local final-head verification passed. After three rounds without agreement the lead decides and writes reasons in the PR. Never waive actual safety/auth/format defects. Squash-merge/delete remote branch, pull main, push concise status and immediately start the next eligible task. |

Do not repeat unchanged control builds or timing series without a concrete concern; verify their recorded hashes. Source/dependency/build changes require appropriate fresh evidence. Record actual local verification, not automatic-CI success claims. If branch protection unexpectedly requires CI, resolve/report that concrete repository setting; do not invent a passing check.

Use PR watches only while an external check/review is genuinely pending. Never watch for unfinished implementation or wait on manual CI. Reuse existing links/watches; unwatch after collection/merge or handback. No sleep, polling loops, gh --watch or replacement recovery timer.

## Local first (owner, 2026-11-17)

Nothing is pushed until it passes locally. Before any push, the role that pushes runs the checks the change can affect and they pass (D145); the full acceptance runs on the approved head before the merge. A push that would need CI to find out is not made. Agents never trigger the CI workflow and never push a release tag unless the same steps CI or the release runs (its `run:` lines in `.github/workflows/ci.yml` / `release.yml`, including `templates:compiled`, the contract and `messaging:*`/`sends:*` scripts, and `E2E_WORKERS=2 bun run e2e` before a tag) have passed locally on the exact commit. A step that cannot run here (arm64, memory) is named in the PR, not delegated to CI to discover.

Release gate (lead, 2026-11-17, after the v1.3.0 tag run failed on two tests with known intermittent failures): no tag while any test has an unexplained intermittent failure on record (status Watch or Hardening backlog). It is cleared by a fixed root cause, or by a test change that removes the nondeterministic mechanism itself (shown by a mutation that the new assertion catches); a wider bound or retry never clears it. Before a tag, `bun run check` passes 10 consecutive valid times on the release commit (lead, 2026-11-20: the 10-run gate applies to release commits only; a task PR needs the whole `ci.yml` check job with one valid `bun run check`, because the release commit is gated anyway and repeating it per PR on the shared host costs hours). Record the host's 1-minute load average before and after each run. A run is invalid, and repeated, only when every failure in it is a real-time wall-bound timeout (the test's own state shows progress, not a wrong value or a stuck condition) and the load exceeded the core count during it; any assertion failure always counts. Do not wait for the host to go idle: on the shared workstation other sessions' load is normal on the release commit in the Linux arm64 container, and once under `--platform linux/amd64` emulation. Under emulation (about 3.5× slower) a wall-clock timeout is recorded with its test and does not block (lead, 2026-11-20, after B113): the native x86-64 `bun run check` in the release workflow gates publishing. Any assertion failure (a wrong value) or an error without a captured message blocks until classified; capture messages with `--reporter=junit --reporter-outfile=<scratchpad file>`. Watch items count native failures only. A step accepted as "not run natively" never covers a test that has failed before.

## Worker brief suffix

You are a worker on iglo.email. Do this task yourself. Read relevant AGENTS/task/design sections and pinned listmonk v7.0.0-beta.1 sources at `/home/t3-code/upstream/listmonk` (6fcd95f), never port from memory. Match observable results for real SDK, browser/dashboard and ordinary HTTP clients; use Bun/Web APIs where those results match. Malformed/custom input must remain safe, atomic, permission-correct and memory-bounded; exact error parity is backlog, not a merge gate (D57). Never relax stored/wire formats, authentication, authorization or actual security.

Change only authorized modules/seams. Write files with the Write/Edit tools inside your own scratchpad, never shell redirects, heredocs or arbitrary /tmp paths (a permission prompt stalls a delegate). Work in the supplied checkout/branch and open or update the task's existing PR; no extra checkout. No helper unless explicitly authorized; Before pushing, run the tests and checks your change can affect (changed and new test files, dependents of changed fixtures, mutants, lint, typecheck, format:check) in the foreground; the full acceptance runs after review approval (D145); push only passing code, never trigger CI (owner, 2026-11-17). Retain first failures and explain reruns. No CI wait, PR watch or merge. Last line: PR <URL>, head <SHA>, local checks <state>.

## Reviewer brief suffix

You are the one independent reviewer; the lead and you form the council. You did not write this code; judge it only on what you read and run. Review only, no code/format/push/helper. Write probe files with the Write/Edit tools inside your own scratchpad, never shell redirects, heredocs or arbitrary /tmp paths. PR <URL>, head <SHA>, task <id>, round <n>. Check out that exact head in your supplied worktree. Read relevant AGENTS, D56/D57/D68, task brief and pinned upstream sources. Round1 is deep; later rounds cover earlier findings, fixes and touched code only. Run the affected tests and re-run the mutants, not the full suite; the full acceptance runs after approval (D145).

A blocker names file/line, a realistic client and request, and concrete wrong result or safety failure. Safe malformed/hand-crafted input with a different exact error goes under Backlog. Crashes, partial writes, auth/permission bypass, invalid data-format acceptance and unbounded memory remain defects even for hostile input. Do not request cosmetic changes. Post one comment starting `COUNCIL VERDICT: APPROVE <SHA>` or `... CHANGES <SHA>`, with blockers then backlog and actual validation limits. Last line: PR <URL>, head <SHA>, local checks <state>.

## Host and scope limits

Linux x86-64 only for MVP. Read `/home/t3-code/AGENTS.md`; no broad scans, Docker accounting/prune, protected worktree/cache/export cleanup or VM policy changes. Locate sources through named paths or exact pinned source fetched within the owned worktree. Tests use only disposable data and owned loopback Mailpit/webhook receivers; no real credentials or production data. New temporary artifacts get an owned lifecycle; preserve compact logs/hashes and never clean another run's evidence. Keep SQLite/module ownership, injected clocks, no network inside transactions and at-most-once marketing unchanged.
