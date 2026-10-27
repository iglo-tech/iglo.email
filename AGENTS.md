# AGENTS.md

## Repository identity

The project is `iglo.email`; its canonical repository is https://github.com/iglo-tech/iglo.email and its default branch is `main`.

iglo.email is an independently maintained rewrite derived from listmonk v7.0.0-beta.1 (`6fcd95f`). It is not an upstream-parity fork and is not intended to operate as a public open-source community project. It is published "as is": no formal support process, no issue triage process, no release promise, and no community governance files.

License: AGPL-3.0, inherited from listmonk. Do not add code under incompatible licenses.

## Current state

The M0.1–M0.4 skeleton, shared HTTP contracts, SQLite primitives and loop lifecycle helper are in place; the production migration manifest is empty and most features remain in the design phase. Read `docs/design/README.md` first. When code and design disagree, fix one of them in the same change.

## Stack

- Bun ≥ 1.4, TypeScript, native ESM. Bun is the package manager (`bun.lock`).
- `Bun.serve` for HTTP. No Express or other framework.
- `bun:sqlite` as the only database. No Postgres, MySQL, Redis or external queue.
- Background work is rows in SQLite processed by in-process loops (`docs/design/02-architecture.md`). Do not add a job queue, workflow engine or Effect without updating `docs/design/09-decisions.md` first.
- Admin UI and public pages are server-rendered TSX with the in-house JSX runtime. Client-side interactivity uses Alpine.js and Oat, as in listmonk v7. No client framework.
- User-authored email templates use Liquid (LiquidJS).
- One compiled executable is the only release artifact until 1.0. Do not add Docker, compose, or parallel distribution paths. An official Docker image that wraps the same executable is planned after 1.0 (D3). The dev-only upstream reference harness may run Postgres in a container.

## Rules

- Use `@/` path-alias imports everywhere, including tests. No relative imports (`./`, `../`) unless a tool cannot resolve aliases.
- Keep module and function names close to listmonk's where that helps side-by-side review. Each ported file names its upstream source file in a header comment.
- Import from the module that owns a symbol. No barrel files, re-export layers, service locators or generic registries.
- No process-global state. Modules receive the database, settings and clock they use. Every loop takes an injected clock.
- A module owns its tables and SQL. Other modules call its functions instead of querying its tables.
- Network calls (SMTP, webhooks) never run inside a database transaction.
- Keep listmonk's HTTP API contract for ported endpoints by default (`docs/design/07-api-and-ui.md`). Do not copy upstream behavior that comes from a poor design decision: fix it, list it there as a deliberate difference with its reason, and mark it in the contract suite. A difference needs a concrete benefit, not a matter of taste.
- Marketing sends are at-most-once. Never add an automatic retry that could send a marketing email twice.
- Add a runtime dependency only when the design lists it or a decision record justifies it.
- Do not restore upstream community files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue or PR templates, funding files).
- Dependency updates use Renovate. Do not add Dependabot.
- Application code logs only errors and things that need attention. No informational console output. CLI command output is fine.

## Tests

- Tests verify observable behavior through public boundaries: HTTP API, rendered pages, emails received by the SMTP sink (Mailpit), and webhook deliveries received by a test server. Never read source files as text or assert on implementation details.
- Upstream listmonk v7.0.0-beta.1 is the reference for ported behavior: the API contract suite runs against both. Read upstream source from a local checkout at the pinned commit, never from memory. Write the contract tests for an endpoint first and run them against upstream, then port the code.
- Time-dependent behavior is tested by advancing the injected clock, not by sleeping.
- Use `agent-browser` to verify the admin UI and public pages.
- Store manual test data and test credentials in regular `.md` files in the repository.
- Never commit production data, backups, real credentials or anything taken from them. Tests never use real SMTP servers or real webhook endpoints.

## Work split

The port is split into tasks in `docs/design/11-work-plan.md`. A task's worker follows its brief and the worker rules there, and changes only the modules the task owns. The chief of staff follows `docs/chief-of-staff.md` and keeps `docs/status.md` current. Agents decide and merge without the owner; decisions are logged for later review.

## Verification

Run the local checks with:

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run check
bun test test/server
```

`bun run check` includes formatting, lint, types, behavior tests and the compiled build. `bun run hooks:install` enables the repository-local pre-commit formatting check. The bootstrap tests exercise the compiled executable from a temporary directory. `bun test test/server` exercises the shared HTTP contracts, including embedded translations. `bun run server:reference` uses the M0.2 runner to check focused health and error cases against the pinned upstream; it requires Docker and downloads. The runner and smoke checks are documented in `test/reference/README.md`; M0.5 will add the general dual-server contract suite.

`bun test test/db test/loops` covers the database and loop contracts with synthetic fixture-owned stores. `bun run db:measure` repeats the bounded native-versus-helper storage workload; it is not a CI threshold.

Changes to sending, scheduling or storage must include before/after measurements, stored under `docs/perf/`.

The development reference requires Git, Docker and access to the pinned GitHub releases and Postgres image. Run `bun run reference:prepare`, `bun run reference:smoke`, or `bun run reference:run -- <command> [args...]`. These are separate from `bun run check`.
