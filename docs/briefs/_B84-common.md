# B84–B87 common rules

Source: the first production adopter's integration report, 2026-11-16 (a SaaS app with prepaid credit packs and a subscription, wiring onboarding, exit-survey, dunning and win-back mail to v1.1.0). Keep any adopter or product name out of code, docs, commits and PRs; describe use cases generically.

Repository https://github.com/iglo-tech/iglo.email. One worker per task, one PR, no helpers. In your supplied isolated checkout, fetch origin/main and create the branch named in your brief from it. Run `bun install --frozen-lockfile` first.

## This host

The work runs on the owner's macOS workstation, not the Linux VPS the runbook names: `/home/t3-code` (and its upstream checkout) and `flock` do not exist here. The lead runs one role at a time, so run checks directly, serially and in the foreground, as ONE command that stops on the first failure (Bash timeout 600000 ms; split into consecutive foreground commands if it would exceed that; never end your turn while tests run). Do not run Docker, the reference harness or `bun run e2e`. These tasks are native features with no upstream counterpart; read upstream source only if your brief names it (fetch the pinned file from GitHub at commit 6fcd95f, never from memory).

## Rules

- AGENTS.md applies. Read your brief, then only the design sections it names.
- **Test first**, through public boundaries: the HTTP API, Mailpit/SMTP sink mail, rendered pages, the loop with an injected clock. Use the existing fixtures in the test directories your brief names.
- Keep the guarantees: marketing at-most-once, no network inside transactions, injected clocks, module ownership of tables/SQL, bounded memory, no new runtime dependency.
- Update the design docs your brief names in the same PR so code and design agree, plus the OpenAPI document (`src/openapi/*`; the MCP tools are generated from it) for any API change.
- A decision record goes in `docs/design/09-decisions.md` as "lead, 2026-11-16" with the number your brief gives.
- Do not edit `docs/status.md`.
- Open a PR to `main` titled as your brief says; the body lists what changed, the acceptance summary lines, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commits end with `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`. No CI wait, no workflow trigger, no merge.
- Last line: PR <URL>, head <SHA>, local checks <state>.
