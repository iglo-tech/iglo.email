# B17–B21 common rules

These five tasks come from a state-machine audit on 2026-11-06 (lead thread ff1fe59e). Cited lines are from main at 72780cb. Re-check them, because they may have moved.

Repository https://github.com/iglo-tech/iglo.email. One worker per task, one PR, no helpers. In your supplied isolated checkout, fetch origin/main and create the branch named in your brief from it. Run `bun install --frozen-lockfile` first.

## Read first

- /home/t3-code/AGENTS.md (host limits) and the repository AGENTS.md.
- Your brief, then only the design sections it names.
- The pinned upstream at `/home/t3-code/upstream/listmonk` (6fcd95f) for any ported behavior. Read it there and never port from memory.

## Rules

- **Test first.** For every numbered item, first write a test through a public boundary: the HTTP API, a rendered page, Mailpit, a webhook receiver, or the loop with an injected clock. Run it on the unchanged code.
  - If it fails, fix the code.
  - If it passes, the audit was wrong for that item. Drop the item and say so in the PR body.
  - If no public-boundary test is realistic, explain why in the PR and test at the closest boundary.
- **Guard status changes.** Every SQL `UPDATE` you touch that changes a status names its from-state (and lease, where there is one) in `WHERE`. Keep each module's allowed transitions in one function. Do not refactor code you are not otherwise changing.
- **Record differences from listmonk.** For a deliberate difference, add the decision record named in your brief to `docs/design/09-decisions.md`, add a row to the deliberate differences in `docs/design/07-api-and-ui.md`, and mark it in the contract suite.
- **Measure sending and scheduling changes.** Changes to sending or scheduling need short before/after measurements in `docs/perf/`, using the existing harness. A guard-only change can be argued in one paragraph with a single run.
- **Keep existing guarantees.** Marketing stays at-most-once. No network calls inside transactions. Clocks stay injected. Modules keep owning their tables.

## Host verification

This is serial across all agents on this host. Wrap every full suite or e2e run in the shared lock, for example:

```sh
flock ~/.local/state/iglo-email-cos/verify.lock bun run check
```

A single test file may run without the lock. Never leave test processes or servers running when you end your turn.

## Acceptance

- `bun run check` (no separate plain `bun test` or `bun run build`).
- The test files you added or changed.
- Any `contract:*` command for an endpoint you changed.

Show in the PR that each new test failed on the old code. Last line of your reply: PR <URL>, head <SHA>, local checks <state>.
