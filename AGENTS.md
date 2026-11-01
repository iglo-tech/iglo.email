# AGENTS.md

## Repository identity

The project is `iglo.email`; its canonical repository is https://github.com/iglo-tech/iglo.email and its default branch is `main`.

iglo.email is an independently maintained rewrite derived from listmonk v7.0.0-beta.1 (`6fcd95f`). It is not an upstream-parity fork and is not intended to operate as a public open-source community project. It is published "as is": no formal support process, no issue triage process, no release promise, and no community governance files.

License: AGPL-3.0, inherited from listmonk. Do not add code under incompatible licenses.

## Current state

The MVP work plan (M0 to M6) is complete and merged: subscribers, lists, campaigns, sending, sequences, transactional mail, webhooks, media, the admin UI, the public pages, the OpenAPI document and the tag-driven release workflow. Remaining work is in the backlog in `docs/status.md`. Read `docs/design/README.md` first. When code and design disagree, fix one of them in the same change.

## Stack

- Bun ≥ 1.4, TypeScript, native ESM. Bun is the package manager (`bun.lock`).
- `Bun.serve` for HTTP. No Express or other framework.
- `bun:sqlite` as the only database. No Postgres, MySQL, Redis or external queue.
- Background work is rows in SQLite processed by in-process loops (`docs/design/02-architecture.md`). Do not add a job queue, workflow engine or Effect without updating `docs/design/09-decisions.md` first.
- Admin UI and public pages are server-rendered TSX with the in-house JSX runtime. Client-side interactivity uses Alpine.js and Oat, as in listmonk v7. No client framework.
- User-authored email templates use Liquid (LiquidJS).
- One compiled executable is the only release artifact until 1.0. MVP targets Linux x86-64 only; macOS and Linux arm64 builds and CI coverage are post-MVP (D42). Do not add Docker, compose, or parallel distribution paths. An official Docker image that wraps the same executable is planned after 1.0 (D3). The dev-only upstream reference harness may run Postgres in a container.

## Rules

- Use `@/` path-alias imports everywhere, including tests. No relative imports (`./`, `../`) unless a tool cannot resolve aliases.
- Keep module and function names close to listmonk's where that helps side-by-side review. Each ported file names its upstream source file in a header comment.
- Import from the module that owns a symbol. No barrel files, re-export layers, service locators or generic registries.
- No process-global state. Modules receive the database, settings and clock they use. Every loop takes an injected clock.
- A module owns its tables and SQL. Other modules call its functions instead of querying its tables.
- Network calls (SMTP, webhooks) never run inside a database transaction.
- Match listmonk results for realistic SDK, browser/dashboard and ordinary HTTP requests (D57); port implementation logic only where the result depends on it. Use native Bun/Web APIs elsewhere. Safe malformed/custom-input error differences are backlog; never relax formats, auth/permissions, atomicity or bounded-memory/security guarantees. Keep listmonk's HTTP API contract for ported endpoints by default (`docs/design/07-api-and-ui.md`). Do not copy upstream behavior that comes from a poor design decision: fix it, list it there as a deliberate difference with its reason, and mark it in the contract suite. A difference needs a concrete benefit, not a matter of taste.
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

D56/D68 owner policy: Anthropic models only, no Fable. Lead/implementation use Opus5.5 medium (Haiku medium only for mechanical bulk work), with one fresh Opus5.5 xhigh reviewer. Run full local checks and acceptance on this host serially, one role at a time, in the foreground before ending that agent turn. CI is manual-only and not a merge gate. See `docs/chief-of-staff.md`.

Run the local checks with:

```sh
bun install --frozen-lockfile
bun run assets:build
bun test test/jsx test/ui
bun run ui:verify
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run check
bun test test/server
bun test test/contract
bun run contract:normal
bun run contract:fixture
bun run contract:roles
bun run contract:roles:reference
```

`bun install` prepares the generated browser bundles and asset manifest; `bun run assets:build` reproduces them. `bun run ui:verify` checks the compiled test-only shell and production public page without Docker. `bun run check` includes formatting, lint, types, behavior tests and the compiled build. `bun run hooks:install` enables the repository-local pre-commit formatting check. The bootstrap tests exercise the compiled executable from a temporary directory. `bun test test/server` exercises the shared HTTP contracts, including embedded translations. `bun run contract:normal` tests the compiled production core and real protected health with a generated API credential; `bun run contract:auth` runs the shared stateful user/auth corpus against compiled production. `bun run contract:lists` runs the shared list corpus and restart check against compiled production; `bun run contract:lists:reference` runs it against pinned upstream. `bun run contract:fixture` retains the separately labelled synthetic gate, shared helpers and normalization probes. `bun run contract:reference` and its `bun run server:reference` compatibility alias use the M0.2 runner and pinned upstream; they require Docker and downloads. The commands, coverage and smoke checks are documented in `test/reference/README.md`. List owners promote the remaining helper cases as their endpoints are ported.

`bun run e2e` runs the adapted Playwright specs serially against the compiled executable, and `bun run e2e:browser` makes one `agent-browser` pass over the same screens; see `test/e2e/README.md`. Neither is part of `bun run check`.

`bun test test/db test/loops` covers the database and loop contracts with synthetic fixture-owned stores. `bun run db:measure` repeats the bounded native-versus-helper storage workload; `bun run auth:measure` repeats the opt-in auth measurements. Neither is a CI threshold.

Changes to sending, scheduling or storage must include before/after measurements, stored under `docs/perf/`.

Place archived control source beneath an owned test-excluded cache such as
`node_modules/.cache/`, not an ordinary git-ignored source directory: Bun's
test discovery can still traverse the latter and run the control's tests too.
Preserve source/executable hashes and use an archive, not another worktree.

The development reference requires Git, Docker and access to the pinned GitHub releases and Postgres image. Run `bun run reference:prepare`, `bun run reference:smoke`, or `bun run reference:run -- <command> [args...]`. These are separate from `bun run check`.
