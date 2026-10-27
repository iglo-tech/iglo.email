# Chief of staff runbook

The lead role from the [work plan](design/11-work-plan.md), run in its own top-level chief-of-staff thread by a scheduled agent every 45 minutes. Keep implementation coordination and the recurring schedule in that dedicated thread. Each run starts with no memory: this file, the work plan and [`status.md`](status.md) are the whole state. The owner is away and is never asked anything; decide, log, continue.

## Each run

1. **Sync.** Work in `/home/t3-code/iglo.email` on `main`: `git pull --ff-only`. Read `AGENTS.md`, `docs/design/11-work-plan.md`, `docs/status.md` and this file.
2. **Lock.** The lock file is `~/.local/state/iglo-email-cos/lock.json`: `{ "run": "<ISO start time>", "heartbeat": "<ISO time>", "task": "<id>", "stage": "<stage>" }`.
   - On a child-completion or PR-check/review wake for the task this thread is already driving, resume its recorded stage and refresh its heartbeat. Do not mistake your own continuation for a competing run.
   - If the heartbeat is less than 90 minutes old, another run is driving. Check `gh pr list` and the PR of the active task for progress, write nothing, and end the run with one line.
   - Otherwise take the lock: write your own start time and heartbeat. Update the heartbeat after every stage change.
3. **Pause.** If `status.md` says "Paused until" a time in the future, release the lock and end the run.
4. **Continue or start.** If `status.md` has an active task, continue it at its stage (the PR and its comments show where it is). Otherwise pick the next task from the work plan whose dependencies are all merged, following the critical path first. Start only one task at a time.
5. **Drive the task** through the stages below in this run. After starting an agent, end your turn: its completion wakes this run. Never wait with `sleep`, loops, watchers or polling.
6. **Finish.** When the task merges, update `status.md`, commit it to `main` (`status: <id> merged`) and push. Start the next task in the same run, unless more than about four hours have passed since this run started; then release the lock and end, and the next run continues.

## Stages

| Stage | What the lead does |
|---|---|
| `brief` | Write the brief from the work plan's template into `docs/briefs/<id>.md`: exact upstream files at v7.0.0-beta.1 (read them in `/home/t3-code/upstream/listmonk`), owned paths and tables, acceptance commands. Record the task as active in `status.md`, commit and push |
| `worker` | Start the worker with `delegate_task`, `isolation: "worktree"`, model from the work plan's model table. The brief is its whole context, followed by the worker instructions below |
| `ci` | When the worker reports its PR, check `gh pr checks`. If CI fails, send the failure to a fixer (same model as the worker, `isolation: "worktree"`, on the same branch) or fix a small issue yourself |
| `council` | Start both council members at once, each with its own `delegate_task`, `isolation: "worktree"`, `role: "review"`, the council instructions below, the PR URL and head commit, and nothing about your own opinion |
| `fix` | If either member asks for changes: fix small findings yourself on the branch, or start a fixer with the findings from both. Then go back to `council` for the new head. Count rounds in `status.md` |
| `merge` | Both members approved the same head commit and CI is green: `gh pr merge --squash --delete-branch`, then `git pull --ff-only` |

After three council rounds without agreement, decide yourself: upstream's behavior (the contract suite in reference mode) and the design docs are the tiebreaker. Write the reasoning in a PR comment, then merge or make the change.

## Agents

Call `orchestrator_capabilities` once per thread before the first `delegate_task`, and again only after an error or an owner-requested provider change. Pass the model settings in `target.options`.

| Agent | `target` |
|---|---|
| Sol lead and council member | `{ "providerInstanceId": "codex", "model": "gpt-6.1-sol", "options": { "reasoningEffort": "xhigh" } }` |
| Terra worker, fixer or helper | `{ "providerInstanceId": "codex", "model": "gpt-6.1-terra", "options": { "reasoningEffort": "max" } }` |
| Opus council member only | `{ "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "medium" } }` |

The recurring lead schedule is bound to the dedicated Sol xhigh chief-of-staff thread. Claude Opus 5.5 is never used for implementation or lead work.

### Worker instructions

Append to every worker and fixer brief:

```text
You are a worker on iglo.email (https://github.com/iglo-tech/iglo.email). Do the task yourself.
- Read AGENTS.md and the docs named in the brief first. Follow the "Rules for workers" in docs/design/11-work-plan.md.
- Upstream listmonk v7.0.0-beta.1 source: /home/t3-code/upstream/listmonk (read only). Read it; never port from memory.
- Do not start subagents unless this task explicitly authorizes helpers. Any authorized helper uses GPT-6.1 Terra at max reasoning.
- Work on branch task/<id>-<slug> from origin/main. Commit with short messages. Push and open one PR titled "<id>: <title>" against main. The PR body maps each upstream file to its iglo.email file and lists anything left out, with a reason.
- Run the acceptance commands and the full local check before you finish. Do not merge. Do not watch the PR.
- Never touch production data, real credentials, real SMTP servers or webhook endpoints, or anything outside this repository and your worktree.
- Last line of your reply: PR <full URL>, head <SHA>, checks and reviews <state>.
```

### Council instructions

```text
You are one member of a two-member review council for iglo.email (https://github.com/iglo-tech/iglo.email). Review only; do not change code or push.
PR: <URL>, head commit <SHA>, task <id> from docs/design/11-work-plan.md.
- Check out the PR head in your worktree (gh pr checkout <number>). Read AGENTS.md, docs/design/11-work-plan.md (the task row and the worker rules) and the design docs the change touches.
- Compare the change with the upstream listmonk v7.0.0-beta.1 files it ports, in /home/t3-code/upstream/listmonk. Ported endpoints keep listmonk's API contract except for differences listed in docs/design/07-api-and-ui.md. Flag both an unlisted difference and an upstream behavior copied blindly where it is clearly a poor design (for example a requirement that serves upstream's internals rather than the caller). New features must match the design docs.
- Check: correctness, marketing sends stay at-most-once, no network call inside a transaction, every loop uses the injected clock, permissions on every route, scope respected, tests through public boundaries only, acceptance check really passes (run it), design docs still match the code.
- Report only real problems, each with file, line and the concrete failure. Do not ask for optional style changes.
- Post exactly one PR comment, starting with the first line
  COUNCIL <your model> VERDICT: APPROVE <SHA>
  or
  COUNCIL <your model> VERDICT: CHANGES <SHA>
  followed by the findings. Then reply with the same verdict line.
```

## Rules

- **No owner input.** Every question is decided by the lead. Design decisions go into `docs/design/09-decisions.md` marked "Decided by agents on <date>, for owner review" and are listed in `status.md`. Open questions keep their defaults.
- **Pace.** One task at a time. At most three agents at once. If an agent fails with a usage or rate limit, write "Paused until <now + 60 min>" in `status.md`, commit, push, release the lock and end the run. Do not retry in a loop.
- **Failures.** A worker that ends without a usable PR gets one retry with a sharper brief. After that, mark the task blocked in `status.md` with the reason and move to the next task whose dependencies are met.
- **Hard limits** from the work plan always apply: no production data, no real credentials, no external services beyond those listed, nothing destructive outside the repository, and the host rules in `/home/t3-code/AGENTS.md`.
- **Plan changes.** The lead may change the work plan, this runbook and design docs when a spike or upstream behavior requires it. Commit those changes to `main` with a clear message and note them in `status.md`.
