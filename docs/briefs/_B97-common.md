# B97–B100 common rules

Source: the first production adopter's second report, 2026-11-17 (v1.2.1 in Docker behind a PaaS's Traefik, SES, ten sequence step templates and one transactional template, built entirely through the REST API with scripts). Keep any adopter or product name out of code, docs, commits and PRs; describe use cases generically.

Repository https://github.com/iglo-tech/iglo.email. One worker per task, one PR, no helpers. In your supplied isolated checkout, fetch origin/main and create the branch named in your brief from it. Run `bun install --frozen-lockfile` first.

## This host

Since 2026-11-26 (D147) the work runs on `agents-workhorse-01`: Ubuntu 26.04 Server, Linux x86-64, 12 cores, 30 GB RAM, as the non-root user `igloczek`, checkout `/home/igloczek/Sites/iglo.email`. It is the platform of CI's x86-64 job, so **checks run natively, with no container**: `bun install --frozen-lockfile`, then `bun run check` and each acceptance command directly in your worktree (one role at a time, foreground, Bash timeout 600000 ms). Never run tests as root: the permission-based failure tests need a non-root user. To check an exact commit rather than your working tree, export it (`D=$(mktemp -d); git archive <sha> | tar -x -C "$D"`) and run there; remove the export afterwards. `/tmp` is an 8 GB tmpfs: put large exports and junit files under `$HOME` scratch directories instead.

**Reference-harness commands** (`reference:*`, `contract:*:reference`, `sends:production`, `messaging:fixture`, `messaging:tls`, anything through `reference:run`) also run natively: the user is in the `docker` group, and the harness starts its own Postgres and upstream containers. It labels and removes its own containers and volumes; touch no other Docker object (no prune).

`templates:compiled` uses bubblewrap, which works here as installed (AppArmor's `bwrap-userns-restrict` profile), with no sysctl change. `E2E_WORKERS=2 bun run e2e` runs natively with Playwright's Chromium (`bunx playwright install chromium` if the cached build does not match `@playwright/test`). sudo needs a password: if a step needs a system package, stop and report it.

These are native features with no upstream counterpart; read upstream source only if your brief names it, from the pinned checkout `reference:prepare` builds, never from memory.

## Rules

- Create and modify files (probes, scripts, notes included) with the Write/Edit tools, never shell redirects, heredocs or `tee`, and keep scratch files inside your own session scratchpad directory, not arbitrary `/tmp` or `/private/tmp` paths: both can stop on a permission prompt nobody can answer (B105 reviewer stalled 30 min, B105 worker again).

- AGENTS.md applies. Read your brief, then only the design sections it names.
- **Test first**, through public boundaries: the HTTP API, the MCP endpoint, SMTP sink mail, rendered pages, the CLI/executable, loops with an injected clock. Use the existing fixtures in the test directories your brief names.
- Keep the guarantees: marketing at-most-once, no network inside transactions, injected clocks, module ownership of tables/SQL, bounded memory, no new runtime dependency.
- Update the design docs your brief names in the same PR so code and design agree, plus the OpenAPI document (`src/openapi/*`; MCP tools are generated from it, D98) for any API change.
- A decision record is **appended at the end** of `docs/design/09-decisions.md` (inserting it earlier split D114 in B107 and D115 in B112); check `git diff origin/main -- docs/design/09-decisions.md` shows only the appended record. It goes in as "(lead, 2026-11-17)" with the number your brief gives. State the decision, what is unchanged, considered alternatives and why.
- Do not edit `docs/status.md`.
- Owner rule "Local first" with D145: push only code that passed the tests and checks the change can affect (changed and new test files, dependents of changed fixtures, mutants, `lint`, `typecheck`, `format:check`); never trigger CI. The full acceptance below runs once, on the head the reviewer approved, before the merge.
- Open a PR to `main` titled as your brief says; the body lists what changed, the acceptance summary lines, any macOS-only limits, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No CI wait, no workflow trigger, no merge.
- Last line: PR <URL>, head <SHA>, local checks <state>.

## Acceptance (once, on the approved head; D145)

It runs after the reviewer approves, not before each push. It covers only the steps the change can reach, named in the brief or by the lead at approval: a docs-only change runs `format:check`; a test-only change its own files and the static checks; the release steps only when `scripts/release*`, the build or the bootstrap changed; the `reference-linux` steps only when `test/contract`, `test/reference` or a route a contract corpus exercises changed. The paragraphs below describe the full set, which the release commit always runs.

The release gate's 10-run series is for release commits only (runbook "Release gate"); in a task PR one valid `bun run check` suffices, where a run is invalid only under the runbook's foreign-load rule. Run every check in the foreground: if one would exceed the Bash timeout, split it; never let it continue in the background.

Every task's acceptance includes **every `run:` step of both `ci.yml` jobs, `check` and `reference-linux`,** in order (the reference job as root with the reference recipe; B124 r2 found a shared contract red against upstream that only the reference job runs) (since B122 that is every contract script; a reviewer runs the whole job too, not a subset: B123 merged with `contract:subscribers` red because only a subset ran) (not only `bun run check`): `ui:verify`, `templates:compiled` and each `contract:*`/`messaging:fixture` step it lists (lead, 2026-11-19, after B105 left `templates:compiled` stale). Use the container image matching `package.json`'s `packageManager` Bun version.

`bun install --frozen-lockfile`, `bun run check`, `bun test test/server`, `bun test test/contract`, `bun run contract:normal`, `bun run contract:roles`. Paste the summary lines in the PR.

Junit capture is a local command the worker runs, not a CI artifact: `ci.yml` writes no junit file. When a brief asks for junit, run `bun test --parallel=4 --timeout=30000 --reporter=junit --reporter-outfile=<scratchpad file>` (or the same per chunk), keep the full stdout too, and name both files in the PR.
