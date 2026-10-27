# AGENTS.md

## Repository identity

The project is `iglo.email`; its canonical repository is https://github.com/iglo-tech/iglo.email and its default branch is `main`.

iglo.email is an independently maintained rewrite derived from listmonk v7.0.0-beta.1 (`6fcd95f`). It is not an upstream-parity fork and is not intended to operate as a public open-source community project. It is published "as is": no formal support process, no issue triage process, no release promise, and no community governance files.

License: AGPL-3.0, inherited from listmonk. Do not add code under incompatible licenses.

## Current state

Design phase. The design is in `docs/design/` and is the source of truth until code exists. Read `docs/design/README.md` first. When code and design disagree, fix one of them in the same change.

## Stack

- Bun ≥ 1.4, TypeScript, native ESM. Bun is the package manager (`bun.lock`).
- `Bun.serve` for HTTP. No Express or other framework.
- `bun:sqlite` as the only database. No Postgres, MySQL, Redis or external queue.
- Background work is rows in SQLite processed by in-process loops (`docs/design/02-architecture.md`). Do not add a job queue, workflow engine or Effect without updating `docs/design/09-decisions.md` first.
- Admin UI and public pages are server-rendered TSX with the in-house JSX runtime. Client-side interactivity uses Alpine.js and Oat, as in listmonk v7. No client framework.
- User-authored email templates use Liquid (LiquidJS).
- One compiled executable is the only release artifact. Do not add Docker, compose, or parallel distribution paths.

## Rules

- Use `@/` path-alias imports everywhere, including tests. No relative imports (`./`, `../`) unless a tool cannot resolve aliases.
- Import from the module that owns a symbol. No barrel files, re-export layers, service locators or generic registries.
- No process-global state. Modules receive the database, settings and clock they use. Every loop takes an injected clock.
- A module owns its tables and SQL. Other modules call its functions instead of querying its tables.
- Network calls (SMTP, webhooks) never run inside a database transaction.
- Keep listmonk's HTTP API contract for ported endpoints (`docs/design/07-api-and-ui.md`). Any deliberate difference is listed there and marked in the contract suite.
- Marketing sends are at-most-once. Never add an automatic retry that could send a marketing email twice.
- Add a runtime dependency only when the design lists it or a decision record justifies it.
- Do not restore upstream community files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue or PR templates, funding files).
- Dependency updates use Renovate. Do not add Dependabot.
- Application code logs only errors and things that need attention. No informational console output. CLI command output is fine.

## Tests

- Tests verify observable behavior through public boundaries: HTTP API, rendered pages, emails received by the SMTP sink (Mailpit), and webhook deliveries received by a test server. Never read source files as text or assert on implementation details.
- Upstream listmonk is the reference for ported behavior: the API contract suite runs against both.
- Time-dependent behavior is tested by advancing the injected clock, not by sleeping.
- Use `agent-browser` to verify the admin UI and public pages.
- Store manual test data and test credentials in regular `.md` files in the repository.

## Verification

Until the M0 skeleton exists, changes are documentation only: check links, file names and `git status`. After M0, the commands are listed here and in `package.json`.

Changes to sending, scheduling or storage must include before/after measurements, stored under `docs/perf/`.
