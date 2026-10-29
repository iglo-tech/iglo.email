# Chief of staff runbook

Operate in `/home/t3-code/iglo.email` on `main`. Owner decisions [D56](design/09-decisions.md#d56-owner-directed-models-review-and-local-verification) and [D57](design/09-decisions.md#d57-compatible-client-results-and-safe-input-hardening) replace the earlier model, council and CI policies.

## Continuous work and recovery

Keep one task moving through implementation, local verification, review and merge. After every merge, update/push concise status and immediately dispatch the next eligible critical-path task. No elapsed-time, session or task-count cutoff. Only a completed applicable work plan ends the goal. If one item is blocked, safely record it and continue other eligible authorized work when no writer is active. Respect genuine capacity/provider cooldowns; never duplicate work.

The existing enabled45-minute recovery schedule stays **unbound** (`boundThreadId:null`). It recovers from `docs/status.md`, GitHub and `~/.local/state/iglo-email-cos/lock.json`, never from a responsive conversation. The lock retains the continuous run start, heartbeat, active branch/head/stage, all delegate IDs, verdicts and next action.

1. `git pull --ff-only`; read only relevant AGENTS/design/task/status sections.
2. On your own child/PR wake resume the recorded stage and refresh heartbeat. Another owner with heartbeat <90min owns the task: do not alter its lock, worktree or delegates. Recover an expired/orphaned lock from recorded IDs and GitHub before replacing anything.
3. Read an actually completed child with `t3_thread_read` before discussing its result. Never poll/read/wait a running delegate. Follow its returned `next`, persist identifiers and end the turn after async dispatch.
4. Keep `status.md` short: active task/next action, one line per merged task, owner-decision links and concise blockers/backlog. Details and lead dispositions live in the PR; historical review ledgers remain evidence, not required reading on every wake.

A redundant healthy check-in auto-settles only itself via `t3_thread_organize` action settle (omit threadId). It must own no child, PR watch or implementation/recovery duty. Leave the actual owner and its state untouched. A coordinator awaiting its own work or a recovery transition never qualifies.

## Models and capacity

For new dispatches, use `delegate_task`, isolation worktree, role and settings in `target.options`. Refresh capabilities only after an orchestration error or owner provider change.

| Role | Target |
|---|---|
| Lead, worker, fixer, normal helper | `{providerInstanceId:"claudeAgent",model:"claude-opus-5-5",options:{effort:"medium"}}` |
| Pure bulk mechanical work only | `{providerInstanceId:"claudeAgent",model:"claude-haiku-5-5",options:{effort:"medium"}}` |
| Single independent reviewer | `{providerInstanceId:"codex",model:"gpt-6.1-sol",options:{reasoningEffort:"xhigh"}}` |

No Terra work, OpenAI implementation/lead work, second Sol reviewer or Claude review of Claude work. The lead and **one** Sol reviewer form the council. Existing dispatched work stays on its branch; let the legacy M1.8 reviewer B finish and collect its result. No replacement or extra reviewer for that transition.

At most two task agents: an implementation worker/fixer and the reviewer. Helpers consume the implementation slot; no fan-out. Prefer sequential stages. **Only one role runs full checks/acceptance on this host at a time**, including the lead. Record the verification owner in the lock; release it only after the owned commands/processes finish. Every agent completes checks in the foreground before ending its turn. Async delegate dispatch remains allowed; background test processes surviving a turn do not.

The lead/project default is Opus medium. `t3_thread_configure` can set the current lead's model for subsequent turns. The scheduler tool has no per-task model field: keep its prompt aligned, preserve the unbound schedule, and report this limitation rather than claim a pinned scheduler model.

The earlier1%-remaining whole-fleet provider fallback is superseded. The quota helper may report remaining OpenAI review capacity; it cannot authorize Claude reviewers or OpenAI workers. If Sol quota is unavailable, record the reset/cooldown and continue only independent authorized Opus work; no review substitution or approval inferred from an unfinished run. Provider failures receive the existing documented60-minute cooldown, not a retry loop. Keep account quota samples local.

## Stages

| Stage | Action |
|---|---|
| brief | Name the realistic client flows, pinned upstream sources, owned modules/tables, acceptance commands and any sending/storage measurements. Push the brief and short status. |
| worker | One Opus medium worker does the implementation in its prepared isolated checkout. No shell-created worktree; fetch the intended base/head inside that checkout. |
| verify | Worker/fixer runs `bun run check` and the brief's acceptance tests serially on this host, in the foreground. Record failures, justified reruns and exact head. CI is optional manual evidence, never a merge gate or a reason to wait. |
| review | Round1: one fresh Sol xhigh deep review. Later rounds: a fresh delegate verifies the fixes and touched code only. Give later reviewers the complete prior findings and lead dispositions, not another whole-PR audit request. Reviewer runs full local check and acceptance serially after the implementation role is finished. |
| fix | Read every finding. Agree: fix small issues yourself, or give one Opus medium fixer all agreed findings of the round. Disagree: answer in the PR with concrete reasoning. Safely handled exotic response differences go to hardening backlog. Run affected tests, then full check/acceptance once on final code. |
| merge | Lead and reviewer agree: reviewer approves the current head, or both agree remaining items are backlog; local final-head verification passed. After three rounds without agreement the lead decides and writes reasons in the PR. Never waive actual safety/auth/format defects. Squash-merge/delete remote branch, pull main, push concise status and immediately start the next eligible task. |

Do not repeat unchanged control builds or timing series without a concrete concern; verify their recorded hashes. Source/dependency/build changes require appropriate fresh evidence. Record actual local verification, not automatic-CI success claims. If branch protection unexpectedly requires CI, resolve/report that concrete repository setting; do not invent a passing check.

Use PR watches only while an external check/review is genuinely pending. Never watch for unfinished implementation or wait on manual CI. Reuse existing links/watches; unwatch after collection/merge or handback. No sleep, polling loops, gh --watch or replacement recovery timer.

## Worker brief suffix

You are a worker on iglo.email. Do this task yourself. Read relevant AGENTS/task/design sections and pinned listmonk v7.0.0-beta.1 sources at `/home/t3-code/upstream/listmonk` (6fcd95f), never port from memory. Match observable results for real SDK, browser/dashboard and ordinary HTTP clients; use Bun/Web APIs where those results match. Malformed/custom input must remain safe, atomic, permission-correct and memory-bounded; exact error parity is backlog, not a merge gate (D57). Never relax stored/wire formats, authentication, authorization or actual security.

Change only authorized modules/seams. Work in the supplied checkout/branch and open or update the task's existing PR; no extra checkout. No helper unless explicitly authorized; Haiku medium only for pure bulk mechanical work. Complete `bun run check` and acceptance commands on this host serially, foreground, before ending. Retain first failures and explain reruns. No CI wait, PR watch or merge. Last line: PR <URL>, head <SHA>, local checks <state>.

## Reviewer brief suffix

You are the one GPT-6.1 Sol xhigh reviewer; the Opus lead and you form the council. Review only, no code/format/push/helper. PR <URL>, head <SHA>, task <id>, round <n>. Check out that exact head in your supplied worktree. Read relevant AGENTS, D56/D57, task brief and pinned upstream sources. Round1 is deep; later rounds cover earlier findings, fixes and touched code only. Run full local check and acceptance serially, foreground, after the implementation role releases host verification.

A blocker names file/line, a realistic client and request, and concrete wrong result or safety failure. Safe malformed/hand-crafted input with a different exact error goes under Backlog. Crashes, partial writes, auth/permission bypass, invalid data-format acceptance and unbounded memory remain defects even for hostile input. Do not request cosmetic changes. Post one comment starting `COUNCIL GPT-6.1 Sol VERDICT: APPROVE <SHA>` or `... CHANGES <SHA>`, with blockers then backlog and actual validation limits. Last line: PR <URL>, head <SHA>, local checks <state>.

## Host and scope limits

Linux x86-64 only for MVP. Read `/home/t3-code/AGENTS.md`; no broad scans, Docker accounting/prune, protected worktree/cache/export cleanup or VM policy changes. Locate sources through named paths or exact pinned source fetched within the owned worktree. Tests use only disposable data and owned loopback Mailpit/webhook receivers; no real credentials or production data. New temporary artifacts get an owned lifecycle; preserve compact logs/hashes and never clean another run's evidence. Keep SQLite/module ownership, injected clocks, no network inside transactions and at-most-once marketing unchanged.
