# B97–B100 common rules

Source: the first production adopter's second report, 2026-11-17 (v1.2.1 in Docker behind a PaaS's Traefik, SES, ten sequence step templates and one transactional template, built entirely through the REST API with scripts). Keep any adopter or product name out of code, docs, commits and PRs; describe use cases generically.

Repository https://github.com/iglo-tech/iglo.email. One worker per task, one PR, no helpers. In your supplied isolated checkout, fetch origin/main and create the branch named in your brief from it. Run `bun install --frozen-lockfile` first.

## This host

The work runs on the owner's macOS workstation (Apple silicon), not the Linux VPS the runbook names: `/home/t3-code`, its upstream checkout and `flock` do not exist here. The lead runs one role at a time, so run checks directly, serially and in the foreground, one command per step, stopping on the first failure (Bash timeout 600000 ms; never end your turn while tests run). Do not run Docker, the reference harness or `bun run e2e` unless your brief says so. These are native features with no upstream counterpart; read upstream source only if your brief names it (fetch the pinned file from GitHub at commit 6fcd95f, never from memory). If a check fails only because this host is macOS (a test that reads Linux `/proc`, for example), record the exact test and error in the PR and say so; do not change the test to hide it.

## Rules

- AGENTS.md applies. Read your brief, then only the design sections it names.
- **Test first**, through public boundaries: the HTTP API, the MCP endpoint, SMTP sink mail, rendered pages, the CLI/executable, loops with an injected clock. Use the existing fixtures in the test directories your brief names.
- Keep the guarantees: marketing at-most-once, no network inside transactions, injected clocks, module ownership of tables/SQL, bounded memory, no new runtime dependency.
- Update the design docs your brief names in the same PR so code and design agree, plus the OpenAPI document (`src/openapi/*`; MCP tools are generated from it, D98) for any API change.
- A decision record goes in `docs/design/09-decisions.md` as "(lead, 2026-11-17)" with the number your brief gives. State the decision, what is unchanged, considered alternatives and why.
- Do not edit `docs/status.md`.
- Owner rule "Local first": push only code that passed `bun run check` and the brief's acceptance on this host; never trigger CI.
- Open a PR to `main` titled as your brief says; the body lists what changed, the acceptance summary lines, any macOS-only limits, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commits end with `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`. No CI wait, no workflow trigger, no merge.
- Last line: PR <URL>, head <SHA>, local checks <state>.

## Acceptance (every task unless the brief adds more)

`bun install --frozen-lockfile`, `bun run check`, `bun test test/server`, `bun test test/contract`, `bun run contract:normal`, `bun run contract:roles`. Paste the summary lines in the PR.
