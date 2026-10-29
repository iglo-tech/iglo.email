# Chief of staff runbook

The lead role from the [work plan](design/11-work-plan.md). Day-to-day implementation coordination belongs in the dedicated top-level chief-of-staff thread linked in [`status.md`](status.md). The automation runs independently every 45 minutes and must remain unbound to any thread (`bindToCurrentThread: false`, returned `boundThreadId: null`), so a stuck conversation cannot prevent recovery. Each run starts with no memory: this file, the work plan, [`status.md`](status.md), the lock and GitHub are the durable state. The owner is away and is never asked anything; decide, log, continue.

## Continuous fleet objective

Owner instruction on 2026-10-28: manage the agent fleet continuously toward the whole project. The fleet must not become idle just because an assignment, PR, council round, conversation or arbitrary time budget ended. Keep one authorized task moving through implementation, checks, independent review and merge; immediately hand off to the next eligible task. Preserve the existing model, isolation, serial-work, lock, CI and host limits.

Ending a turn after async dispatch or a PR watch is an orchestration handoff, not stopping work. Record all IDs and the next action before yielding; delegate/check completion resumes the next transition immediately. The unbound 45-minute schedule recovers stalled work; it is not a deliberate delay between tasks. Never poll/wait for running delegates, start duplicates, or bypass genuine rate/resource limits.

If a task is blocked, finish its independent authorized work and move to another eligible task when its state is safe and no writer is running. A single blocked item must not stop the whole fleet. If all remaining work is blocked or allowed execution capacity is unavailable, persist each concrete blocker, retain the project as incomplete and let the earliest legitimate completion/recovery/cooldown resume it. Do useful authorized lead work while other capacity is unavailable. Only an entirely completed work plan may be reported as project completion.

## Each run

1. **Sync.** Work in `/home/t3-code/iglo.email` on `main`: `git pull --ff-only`. Read `AGENTS.md`, `docs/design/11-work-plan.md`, `docs/status.md` and this file.
2. **Lock.** The lock file is `~/.local/state/iglo-email-cos/lock.json`: `{ "run": "<ISO start time>", "heartbeat": "<ISO time>", "task": "<id>", "stage": "<stage>" }`.
   - On a child-completion or PR-check/review wake for the task this thread is already driving, resume its recorded stage and refresh its heartbeat. Do not mistake your own continuation for a competing run.
   - If another run owns a heartbeat less than 90 minutes old, inspect the durable task/phase and available GitHub progress without polling its running delegates. If this is only a healthy redundant check-in, follow **Healthy check-in auto-settlement** below. Do not modify its lock, task state or repository. A required recovery/action or uncertain ownership does not qualify for automatic settlement.
   - Otherwise take the lock: write your own start time and heartbeat. Update the heartbeat after every stage change. An independent run recovers from the recorded task, branch, PR and delegate identifiers; it does not wait for the dedicated thread to respond. Check the recorded worker and GitHub state before replacing work, and never start a duplicate worker.
3. **Capacity and recovery.** Read the quota preflight below on each lead wake and before every delegate dispatch; use the owner-authorized 1%-remaining Anthropic fallback when triggered. Respect recorded cooldowns for the affected agent/provider/resource. Continue other eligible authorized work through available capacity; a blocked item is not a reason to stop the fleet. Yield for scheduled recovery only if all remaining work is genuinely blocked or required capacity is unavailable, keeping the project explicitly incomplete. Never treat a task completion or elapsed time as a pause.
4. **Continue or start.** If `status.md` has an active task, continue it at its stage (the PR and its comments show where it is). Otherwise pick the next task from the work plan whose dependencies are all merged, following the critical path first. Start only one task at a time.
5. **Drive the task** through the stages below in this run. After starting an agent, end your turn: its completion wakes this run. Never wait with `sleep`, loops, watchers or polling.
6. **Continue after every merge.** Update `status.md`, commit it to `main` (`status: <id> merged`) and push. Immediately select, brief and dispatch the next eligible task. A task/PR completion is a fleet handoff, never completion of the project goal. There is no elapsed-run, four-hour, task-count or session cutoff. Keep the lock and advance it to the next task; do not release it merely because one task merged or wait for the next timer. Stop project work only when the entire applicable work plan is complete or the owner explicitly changes the goal. If work is temporarily impossible, record the actual block/cooldown and recovery action without declaring the goal complete.

## Healthy check-in auto-settlement

Owner instruction on 2026-10-28: a redundant check-in that only establishes that another agent is already driving healthy work must settle itself automatically, without asking the owner.

- Qualify using the other owner's valid lock, matching durable active-task/delegate identifiers and available progress evidence. A fresh heartbeat with contradictory or missing task evidence is not enough. Do not poll a running delegate or wait for it to prove health.
- This check-in must own no outstanding worker/reviewer/helper, pending child completion, PR watch or implementation/CI/review/merge/recovery responsibility. The actual fleet lead waiting for its own delegate or checks is an active coordinator, not a redundant observer.
- Leave the active owner's lock, heartbeat, status, worktree, delegates and watches untouched. Do not dispatch replacement work or make a repository/status commit just to record a healthy check-in. Its one-line final outcome is the record: another owner is driving, no intervention was needed.
- Before ending that check-in turn, call `t3_thread_organize` with `{"action":"settle"}`, omitting `threadId` so it applies only to the current redundant check-in. Settlement applies at successful turn end; a failed turn or queued message can keep the thread active. Do not archive/delete threads, cancel work, settle the active lead/worker/reviewer, or mark the project goal complete.
- Do not auto-settle when there is an expired/orphaned/mismatched lock, a failure/block requiring action, uncertain ownership, a pending transition this thread must drive, or work the thread still owns. Follow the normal lock/recovery rules and keep the required coordination active. If the settle tool fails or is unavailable, report that outcome rather than claiming settlement or substituting archive/delete.

## Stages

| Stage | What the lead does |
|---|---|
| `brief` | Write the brief from the work plan's template into `docs/briefs/<id>.md`: exact upstream files at v7.0.0-beta.1 (read them in `/home/t3-code/upstream/listmonk`), owned paths and tables, acceptance commands. Record the task as active in `status.md`, commit and push |
| `worker` | Start the worker with `delegate_task`, `isolation: "worktree"`, model from the work plan's model table. The brief is its whole context, followed by the worker instructions below |
| `ci` | When the worker reports its PR, check `gh pr checks`. If CI fails, send the failure to a fixer (same model as the worker, `isolation: "worktree"`, on the same branch) or fix a small issue yourself |
| `council` | Start two independent council members (serially when host capacity requires it), each with its own `delegate_task`, `isolation: "worktree"`, `role: "review"`, the council instructions below, the PR URL and head commit, and nothing about your own opinion |
| `fix` | If either member asks for changes: fix small findings yourself on the branch, or start a fixer with the findings from both. Then go back to `council` for the new head. Count rounds in `status.md` |
| `merge` | Both members approved the same head commit and CI is green: `gh pr merge --squash --delete-branch`, then `git pull --ff-only` |

After three council rounds without agreement, decide yourself: upstream's behavior (the contract suite in reference mode) and the design docs are the tiebreaker. Write the reasoning in a PR comment, then merge or make the change.

## Agents

Call `orchestrator_capabilities` once per thread before the first `delegate_task`, and again only after an error or an owner-requested provider change. Pass the model settings in `target.options`.

| Agent | `target` |
|---|---|
| Sol lead and both independent council members (A and B) | `{ "providerInstanceId": "codex", "model": "gpt-6.1-sol", "options": { "reasoningEffort": "xhigh" } }` |
| Terra worker, fixer or helper | `{ "providerInstanceId": "codex", "model": "gpt-6.1-terra", "options": { "reasoningEffort": "max" } }` |

Owner quota override on 2026-10-29 supersedes the earlier Anthropic ban only when OpenAI reaches **1% remaining** (99% used) in an applicable limiting window. Above that threshold retain Sol xhigh lead/council and Terra max workers. At or below it, new assignments use the verified Anthropic fallback targets below. Council members remain two fresh independent reviewers, labelled A/B, each in its own isolated worktree, neither lead nor worker; both approvals refer to the same head. A provider change does not reuse a reviewer or waive acceptance.

| Fallback role | `target` |
|---|---|
| Lead | `{ "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "xhigh" } }` |
| Worker, fixer or helper | `{ "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "max" } }` |
| Each council member | `{ "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "medium" } }` |

### Quota preflight and provider handoff

Run `python3 scripts/chief-of-staff/openai-usage.py` on every owning lead wake, before each new delegate, and before an extended lead-work handoff. It starts no inference/thread: it initializes Codex app-server, calls the documented read-only `account/rateLimits/read` RPC, emits only sanitized window percentages/reset times, then closes that process. It never reads a delegate thread. The official protocol is [documented here](https://learn.chatgpt.com/docs/app-server#rate-limits-chatgpt).

Use the minimum remaining percentage across the applicable generic Codex windows; 1% remaining means usedPercent >=99, not 1% used. Keep unrelated model-pool rows separate; if later model-specific limits govern Sol/Terra, mark their relevance before choosing. A missing/failed quota response is unknown, not 0% or unlimited: record it and retain the last justified provider choice unless an explicit quota-exhaustion failure establishes that OpenAI is unavailable. Store the sample, timestamp, threshold, selected provider and reset/cooldown metadata in the local chief-of-staff lock/provider state, not public account-usage data in Git.

At <=1%, persist the current task/head/stage/next action and select the fallback before starting more OpenAI work. Use `t3_thread_configure` on the current owning lead (omit threadId), with modelSelection `{ "provider": "claudeAgent", "instanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "xhigh" } }`, for subsequent lead turns; no replacement top-level thread. All new delegates use the fallback target/options for their role. Preserve the same enabled, unbound45-minute recovery automation and its lock-based handoff. Its prompt must keep this conditional policy rather than the historical Anthropic ban.

Do not poll, duplicate or silently cancel a live delegate to change providers. A new OpenAI brief asks its worker/reviewer to run the same preflight before costly work and return a durable safe checkpoint if <=1% is observed; the lead then resumes through a fresh authorized fallback delegate after the old run is terminal. Never count an incomplete review as approval. Record each actual provider/model/effort and preserve council independence, same-head gates, serial host constraints and PR ownership. After the limiting window resets, a fresh sample above1% permits the default OpenAI assignments again; no extra retry loop or fresh billable test inference to check access.

Owner platform override on 2026-10-28 (D42): MVP CI, reference acceptance and release artifacts target Linux x86-64 only. macOS and Linux arm64 are post-MVP. Keep both Linux jobs and the complete pinned-reference checks; do not dispatch, wait for or rerun macOS jobs as an MVP gate.

The recurring lead schedule is independent and unbound; never bind it to the dedicated thread or any other thread. Keep its existing 45-minute interval and use the lock and status file for recovery. Record delegate task and thread identifiers in `status.md` after dispatch so a later run can recover without the former lead conversation. Apply the current quota policy to new worker/helper/reviewer dispatches; the earlier unconditional Anthropic ban is historical.

### Worker instructions

Append to every worker and fixer brief:

```text
You are a worker on iglo.email (https://github.com/iglo-tech/iglo.email). Do the task yourself.
- Read AGENTS.md and the docs named in the brief first. Follow the "Rules for workers" in docs/design/11-work-plan.md.
- Upstream listmonk v7.0.0-beta.1 source: /home/t3-code/upstream/listmonk (read only). Read it; never port from memory.
- Locate dependency source using the named checkout, a known cache path or a pinned GitHub source fetched inside your worktree. Never run find or du across the filesystem, /home/t3-code or all of .t3 to locate a dependency. If a named local path is absent, use the pinned source instead of widening the scan.
- Do not start subagents unless this task explicitly authorizes helpers. Any authorized helper uses the quota-selected worker target: GPT-6.1 Terra max by default, Claude Opus5.5 max only under the 1%-remaining fallback. Before costly work run the quota preflight; if <=1% on OpenAI, save a safe checkpoint and return for lead handoff, without starting a replacement agent.
- Work on branch task/<id>-<slug> from origin/main. Commit with short messages. Push and open one PR titled "<id>: <title>" against main. The PR body maps each upstream file to its iglo.email file and lists anything left out, with a reason.
- Run the acceptance commands and the full local check before you finish. Do not merge. Do not watch the PR.
- Never touch production data, real credentials, real SMTP servers or webhook endpoints, or anything outside this repository and your worktree.
- Last line of your reply: PR <full URL>, head <SHA>, checks and reviews <state>.
```

### Council instructions

```text
You are one member of a two-member review council for iglo.email (https://github.com/iglo-tech/iglo.email). Review only; do not change code or push.
PR: <URL>, head commit <SHA>, task <id> from docs/design/11-work-plan.md.
Reviewer: <A or B>, a fresh quota-selected council model: GPT-6.1 Sol xhigh normally, Claude Opus5.5 medium under the fallback. State the actual model in the verdict; if <=1% on OpenAI before costly work, return a safe checkpoint for lead handoff. Review independently; do not read the other reviewer's current-round verdict or findings before posting your own.
- Check out the PR head in your worktree (gh pr checkout <number>). Read AGENTS.md, docs/design/11-work-plan.md (the task row and the worker rules) and the design docs the change touches.
- Read /home/t3-code/AGENTS.md before tooling. Locate dependency source only through named local paths or a pinned GitHub source fetched inside your worktree. Never run find or du across the filesystem, /home/t3-code or all of .t3; an absent cache is a reason to fetch the exact source, not to widen the scan.
- Compare the change with the upstream listmonk v7.0.0-beta.1 files it ports, in /home/t3-code/upstream/listmonk. Ported endpoints keep listmonk's API contract except for differences listed in docs/design/07-api-and-ui.md. Flag both an unlisted difference and an upstream behavior copied blindly where it is clearly a poor design (for example a requirement that serves upstream's internals rather than the caller). New features must match the design docs.
- Check: correctness, marketing sends stay at-most-once, no network call inside a transaction, every loop uses the injected clock, permissions on every route, scope respected, tests through public boundaries only, acceptance check really passes (run it), design docs still match the code.
- Report only real problems, each with file, line and the concrete failure. Do not ask for optional style changes.
- Post exactly one PR comment, starting with the first line
  COUNCIL <your model> VERDICT: APPROVE <SHA>
  or
  COUNCIL <your model> VERDICT: CHANGES <SHA>
  followed by Reviewer: <A or B> and the findings. Then reply with the same verdict line and reviewer label.
```

## Rules

- **No owner input.** Every question is decided by the lead. Design decisions go into `docs/design/09-decisions.md` marked "Decided by agents on <date>, for owner review" and are listed in `status.md`. Open questions keep their defaults.
- **Pace and capacity.** One task at a time, at most three agents at once under the existing model/isolation limits. A usage/rate-limit failure gets a documented 60-minute cooldown for the affected execution capacity; do not retry it in a loop, start a duplicate or substitute models outside the owner-authorized quota fallback. OpenAI exhaustion qualifies for that fallback; retain its cooldown while continuing through available Anthropic capacity. Continue authorized work that does not need that unavailable capacity, including other eligible work after safely recording a blocked task. Record a project-wide "Paused until" only when no remaining work can make progress under the actual shared limit; keep the goal incomplete and recovery scheduled.
- **Failures.** A worker that ends without a usable PR gets one retry with a sharper brief. After that, mark the task blocked in `status.md` with the reason and move to the next task whose dependencies are met.
- **Hard limits** from the work plan always apply: no production data, no real credentials, no external services beyond those listed, nothing destructive outside the repository, and the host rules in `/home/t3-code/AGENTS.md`.
- **Plan changes.** The lead may change the work plan, this runbook and design docs when a spike or upstream behavior requires it. Commit those changes to `main` with a clear message and note them in `status.md`.
