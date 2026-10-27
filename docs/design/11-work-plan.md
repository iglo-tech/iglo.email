# Work plan

How the [port plan](08-port-plan.md) is split into tasks that agents do one at a time, and how each task is briefed, reviewed by the council and merged without the owner.

## How work is handled

### Roles

| Role | Who | Does |
|---|---|---|
| Owner | the project owner | Sets direction. Is not asked for approvals: agents merge and decide on their own, and log decisions for later review |
| Lead (chief of staff) | a scheduled agent run, every 45 minutes ([runbook](../chief-of-staff.md)) | Keeps this plan and [`docs/status.md`](../status.md) current, writes task briefs, starts workers and the council, merges, decides design questions |
| Worker | one agent per task | Does one task in its own branch and worktree, opens one PR |
| Council | two fresh agents, never the worker: Claude Opus 5.5 (medium effort) and GPT-6.1 Sol (xhigh reasoning) | Reviews each finished PR independently against listmonk's source and these docs. A PR merges only when both approve the same commit |

### Models

| Work | Model |
|---|---|
| Lead | GPT-6.1 Sol, xhigh reasoning (extra high) |
| All workers, fixers and helpers, including core, security- and delivery-critical code, mechanical tasks and bulk work | GPT-6.1 Terra, max reasoning |
| Council | Claude Opus 5.5 at medium effort and GPT-6.1 Sol at xhigh reasoning |

Model assignments were set by the owner on 2026-10-27. Claude Opus 5.5 is used only as a council member.

### One task

- **Size:** one upstream area that a single agent can port and test in one session: usually up to about 1,500 upstream Go lines plus their SQL, or one group of admin views.
- **Branch and worktree:** `task/<id>-<slug>`, created from the current `main`. One PR per task.
- **Write scope:** the task names the modules it owns. A worker changes only those, plus new tests. A change to a module another task owns, or to a shared contract (below), goes back to the lead. Until 1.0, a task may edit `migrations/0001_init.sql` for the tables its module owns ([Data model](03-data-model.md#migrations)).
- **Decisions:** design questions are decided by the lead, never left waiting. Each one is recorded in [Decisions](09-decisions.md) as "decided by agents, for owner review" and listed in `docs/status.md`. [Open questions](10-open-questions.md) keep their defaults until the owner answers.
- **Done:** the acceptance check in the brief passes in CI, the design docs that the task touches still match the code, and the PR description lists what was ported (upstream file → iglo.email file) and anything left out with a reason.

### Task brief

The lead writes each brief from this template, stores it in `docs/briefs/<id>.md`, and passes it to the worker as its whole context:

```text
Task <id>: <title>
Goal: <one sentence>
Read first: AGENTS.md, docs/design/<docs>
Upstream (v7.0.0-beta.1): <files, queries, views and specs to port>
Owns: <src/... and test/... paths, tables>
Depends on: <task ids, already merged>
Acceptance: <commands and contract or Playwright tests that must pass>
Out of scope: <what a neighboring task does>
Measurements: <docs/perf/... if the task changes sending, scheduling or storage>
```

### Rules for workers

- Follow `AGENTS.md`. listmonk v7.0.0-beta.1 is the reference for ported behavior; read its source in the upstream checkout (`/home/t3-code/upstream/listmonk` until M0.2 adds the fetch script), never from memory.
- Do the task yourself. If the lead explicitly authorizes helpers for bulk mechanical work, they use GPT-6.1 Terra at max reasoning; keep the judgment calls yourself.
- For ported endpoints, write the contract tests first and run them against the upstream reference, then port the code. For new features, write the tests from the design docs first. Each ported file names its upstream source file in a header comment.
- Do not copy listmonk behavior blindly. If an upstream behavior looks like a poor design decision (for example a requirement that serves upstream's internals rather than the caller), propose a fix in the PR with the reason. If upstream and the design disagree, or a test can only pass with a deliberate API difference, stop and report it in the PR. The lead decides; an accepted fix is listed in `07-api-and-ui.md` and logged for owner review.
- No new runtime dependency, no change to a decision record, no change to another task's module without the lead.
- Never use production data or real credentials. Fixtures are generated data and fresh installs. Real SMTP servers and real webhook endpoints are never used: mail goes to Mailpit, webhooks to the test receiver.

### Shared contracts

These are created in M0 and change only through a small task of their own, because every other task builds on them:

- the app context passed to modules (database, settings, clock, mailer, logger), with no process-global state;
- the database layer (`src/db`): connection, transactions, migrations runner, SQL file loader;
- the router, middleware chain, the `{ "data": … }` envelope and `{ "message": … }` error helpers, and the i18n message lookup they use (`src/server`, `src/i18n`);
- the loop helper used by every background loop: claim with a lease, injected clock, graceful stop;
- the JSX runtime and the page shell (`src/jsx`, `src/admin/layout`);
- the contract suite harness and the upstream reference (`test/contract`, `test/reference`).

### Review and merge

1. The worker finishes when its PR is open, CI is green and its acceptance check passes.
2. **Council:** both council members review the PR independently. Each checks the diff next to the upstream files it ports and against these docs and `AGENTS.md`: behavior matches upstream or a listed deliberate difference with a sound reason, no poor upstream design copied without a note, marketing sends stay at-most-once, no network call inside a transaction, tests through public boundaries only, the task's scope respected. Each posts one PR comment with a verdict, `APPROVE` or `CHANGES`, for the exact head commit.
3. **Fix loop:** on `CHANGES`, the lead fixes small findings itself and sends larger ones to a fixer agent on the same branch. Then both members review the new head again. A PR merges only when both approve the same commit.
4. **Deadlock:** after three rounds without agreement, the lead decides. Upstream's behavior (the contract suite in reference mode) and the design docs are the tiebreaker, and the reasoning goes in the PR.
5. The lead squash-merges, deletes the branch and updates `docs/status.md`. `main` stays green.

### Pace

Correct first time over fast. One task at a time, end to end; the next one starts after the previous one is merged. At most three agents run at once (the worker, or the two council members), plus short lead-run helpers. If any agent hits a usage or rate limit, the lead pauses new work for an hour instead of retrying. Parallel tasks are considered only after M1 is merged, and still at most two workers.

### Hard limits

- No agent reads, copies or uses production data or real credentials. Nothing taken from production is committed.
- No external services except GitHub, the package registries for declared dependencies, and the container registry for the reference harness's Postgres image. No real SMTP server, no real webhook endpoint.
- Nothing destructive outside the repository. The host rules in `/home/t3-code/AGENTS.md` apply (no Docker disk accounting, no broad disk scans, low-priority bounded diagnostics). The reference harness removes only the containers and volumes it created.

## Tasks

IDs follow milestones. "Upstream" names the main sources; each brief lists the exact files. listmonk has no API test suite, so each task writes the contract tests for its endpoints and runs them against the upstream reference. Playwright specs are upstream's `tests/specs` (137 tests).

### M0: skeleton, tooling and spikes

Serial, then the spikes in parallel after M0.4.

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M0.1 | Project skeleton: `package.json`, `tsconfig` with `@/` aliases, oxlint, oxfmt, pre-commit hook, CI, Renovate, `bun build --compile`, flags and environment ([D14](09-decisions.md#d14-bootstrap-from-flags-and-environment-everything-else-in-settings)), `serve` with `/health` | `cmd/main.go`, flag handling in `cmd/init.go` | none | Compiled executable serves `/health`; dropped flags (`--install`, `--upgrade`, `--config`) fail with a message naming `01-scope.md`; `AGENTS.md` lists the verification commands |
| M0.2 | Upstream reference: script that fetches listmonk source at the pinned commit into a git-ignored directory, downloads the v7.0.0-beta.1 release binary, and runs it against a disposable Postgres; Mailpit and a webhook test receiver for tests | release files, `docker-compose.yml` (for settings only) | M0.1 | One command starts and stops the reference listmonk, Mailpit and the receiver on Linux and macOS, removing only what it created |
| M0.3 | Shared contracts: app context, clock, router, middleware chain, envelope and error helpers, i18n message lookup with listmonk's language files | `cmd/handlers.go` (routing, middleware), `cmd/utils.go`, `internal/i18n`, `i18n/en.json` | M0.1 | Error and envelope bodies match upstream for 404, 400 and validation errors |
| M0.4 | Database layer: connection with WAL and pragmas, `BEGIN IMMEDIATE` transaction helper, migrations runner with `user_version` and pre-migration backup, SQL file loader for named queries, the loop helper | query loading in `cmd/init.go` | M0.1 | Empty database migrates; a failed migration leaves the previous version; named queries load from embedded files; the loop helper claims with a lease under an injected clock |
| M0.5 | Contract suite harness: run against a base URL in reference and normal mode, normalize IDs and timestamps, mark deliberate differences | none | M0.2, M0.3 | `/health` and ported core cases run against upstream and compiled production; a protected read also runs against upstream and an explicitly labelled normal fixture until M1.3 ports auth ([D20](09-decisions.md#d20-separate-production-and-fixture-contract-coverage-until-auth-is-ported)) |
| M0.6 | JSX runtime, page shell and asset build: escape-by-default JSX, `Bun.build` of v7's admin assets embedded in the executable | `static/admin/build.mjs`, `static/admin/views/base.html` | M0.1 | Escaping tests pass; the shell renders with v7's CSS and JS from the compiled executable |
| M0.7 | Spike: SQLite write load: campaign progress at 50 messages per second and 100 events per second together, batched writes, FTS5 triggers | none | M0.4 | Report in `docs/perf/`; [throughput target](02-architecture.md#throughput-target) confirmed or a decision recorded |
| M0.8 | Spikes: nodemailer pool under Bun against Mailpit (DKIM, attachments, `Message-ID` capture); LiquidJS limits and render cost for a 10,000-recipient campaign | none | M0.2, M0.4 | One report each in `docs/perf/`; follow-up decisions recorded |

### M1: core data and API

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M1.1 | v1 schema: `migrations/0001_init.sql` from `schema.sql` in the SQLite dialect, plus the new tables from [Data model](03-data-model.md) | `schema.sql` | M0.4 | Fresh install creates every table in the data model; `PRAGMA integrity_check` and foreign keys pass |
| M1.2 | Settings: table, defaults, validation, `GET/PUT /api/settings`, SMTP test endpoint stubbed until M2.1 | `cmd/settings.go`, `internal/core/settings.go` | M1.1, M0.5 | Settings contract tests pass in both modes |
| M1.3 | Users, API tokens, sessions, login and logout, Basic and token auth, CSRF, login rate limit | `cmd/auth.go`, `cmd/users.go`, `internal/auth`, `queries/users.sql` | M1.1, M0.5 | User and auth contract tests pass in both modes; promote M0.5’s protected-read fixture case to actual normal production auth (D20) |
| M1.4 | Roles and permissions: user roles, list roles, permission checks on every route, TOTP 2FA | `cmd/roles.go`, permission handling in `internal/auth`, `queries/roles.sql` | M1.3 | Role contract tests pass; every ported route is denied without its permission |
| M1.5 | Lists: CRUD, tags, opt-in types, counts | `cmd/lists.go`, `queries/lists.sql`, `internal/core/lists.go` | M1.4 | List contract tests pass in both modes |
| M1.6 | Subscribers: CRUD, `attribs`, `external_id` routes, list subscriptions, blocklist, bulk actions | `cmd/subscribers.go` (CRUD and bulk), `queries/subscribers.sql`, `internal/core/subscribers.go` | M1.5 | Subscriber contract tests pass, `external_id` routes against the design |
| M1.7 | Segment queries, FTS5 search and subscriber data export | `cmd/subscribers.go` (query, export), segment parts of `queries/subscribers.sql` | M1.6, M0.7 | Query contract tests pass with the SQLite-dialect difference marked |
| M1.8 | Templates: store, LiquidJS setup and functions, preview, built-in templates converted to Liquid | `cmd/templates.go`, `queries/templates.sql`, `static/email-templates` | M1.4 | Template contract tests pass with the Liquid difference marked; built-ins render |
| M1.9 | CSV subscriber import | `cmd/import.go`, `internal/subimporter` | M1.6 | Import contract tests pass; a 100,000-row import is measured |

### M2: individual sending

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M2.1 | Messaging: SMTP pool with nodemailer, several servers, message building, `Message-ID` capture, SMTP test endpoint | `internal/messenger/email` | M0.8, M1.2 | Messages in Mailpit match upstream's for the same input |
| M2.2 | Sends and outbox: `sends` table, outbox loop, transactional retry only on proven rejection, `GET /api/sends`, resend | none ([Sending](04-sending.md#outbox)) | M2.1, M1.6 | Crash tests: no duplicate after a kill at each point; send log readable through the API |
| M2.3 | Transactional API: `POST /api/tx` with the new fields, idempotency keys, attachments, headers | `cmd/tx.go` | M2.2, M1.8 | Tx contract tests pass with the response difference marked |
| M2.4 | Unsubscribe and frequency cap: marketing unsubscribe, one-click `List-Unsubscribe`, `/m/:sendUUID` pages and tracking, the cap check | none ([Sending](04-sending.md#unsubscribe)) | M2.3 | Unsubscribe from a received email in Mailpit works by link and by one-click `POST` |
| M2.5 | Public pages: subscription form, opt-in, preferences, export and wipe, public rate limits | `cmd/public.go`, `static/public/templates` | M2.1, M1.6, M0.6 | Public page tests pass in both modes; `forms.spec.js` adapted |
| M2.6 | Outbound webhooks: configuration API, signed deliveries loop, retries for 24 hours | none ([Sending](04-sending.md#outbound-webhooks)) | M2.4 | The test receiver gets signed deliveries for every listed event; retries follow the injected clock |

### M3: campaigns

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M3.1 | Campaigns API: CRUD, status changes, test sends, content conversion | `cmd/campaigns.go`, `queries/campaigns.sql` | M1.8, M2.1 | Campaign contract tests pass in both modes |
| M3.2 | Campaign runner: pipeline, rate limits and sliding window, cursor, pause and resume, at-most-once batches | `internal/manager`, `cmd/manager_store.go` | M3.1, M2.2 | 10,000 subscribers through Mailpit respect the limits; a kill mid-campaign resumes without duplicates; measurements in `docs/perf/` |
| M3.3 | Tracking and analytics: view pixel, link redirects, summary tables, dashboard counts | `cmd/campaign_analytics.go`, `cmd/dashboard.go`, `queries/links.sql` | M3.2 | Analytics contract tests pass in both modes |
| M3.4 | Bounces: bounce API, Mailgun webhook, soft, hard and complaint actions | `cmd/bounce.go`, `internal/bounce` (API and Mailgun parts), `queries/bounces.sql` | M1.6, M2.6 | Bounce contract tests pass; actions fire webhooks |
| M3.5 | Media: filesystem storage, upload, list, delete | `cmd/media.go`, `internal/media`, `queries/media.sql` | M1.4 | Media contract tests pass in both modes |

### M4: admin UI

Views are ported in the order of the [port plan](08-port-plan.md#milestones). Each task adapts the matching upstream Playwright specs and checks its screens with `agent-browser`.

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M4.1 | Login, 2FA, password reset, dashboard | `static/public/templates` (login, twofa, reset), `views/dashboard.html`, `cmd/admin.go`, `cmd/views.go` | M0.6, M1.4, M3.3 | Login and dashboard work in the browser; 2FA flow passes |
| M4.2 | Subscribers and lists screens | `views/subscribers.html`, `subscriber.html`, `lists.html`, `list.html` | M4.1, M1.7 | `subscribers.spec.js` and `lists.spec.js` adapted and passing |
| M4.3 | Templates and campaigns screens | `views/templates.html`, `template.html`, `campaigns.html`, `campaign.html` | M4.1, M3.1 | `templates.spec.js` and `campaigns.spec.js` adapted and passing |
| M4.4 | Settings, users, roles, profile | `views/settings.html`, `users.html`, `user.html`, `roles.html`, `user-role.html`, `list-role.html`, `profile.html` | M4.1 | `settings.spec.js` and `users.spec.js` adapted and passing |
| M4.5 | Bounces, media, import, forms | `views/bounces.html`, `media.html`, `media-fragment.html`, `import.html`, `forms.html` | M4.1, M3.4, M3.5, M1.9 | `bounces.spec.js`, `import.spec.js` and `forms.spec.js` adapted and passing |
| M4.6 | Analytics, maintenance, logs: screens and the maintenance and logs API | `views/analytics.html`, `maintenance.html`, `logs.html`, `cmd/maintenance.go`, `internal/buflog` | M4.1, M3.3 | Screens checked with `agent-browser`; maintenance contract tests pass |

### M5: sequences

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M5.1 | Subscriber events API: event store, subscriber upsert by `external_id`, idempotency, batch, retention | none ([Sequences](05-sequences.md#events-api)) | M1.6, M0.7 | Events tests pass; 100 events per second measured while a campaign sends |
| M5.2 | Conditions: JSON predicate language, validation, compilation to one indexed query, permission-gated raw SQL | none ([Sequences](05-sequences.md#conditions)) | M5.1, M1.7 | Condition tests pass; a generated-condition fuzzer agrees with a reference evaluator on 10,000 cases |
| M5.3 | Sequences and enrollments: definitions API, triggers, exit events, reentry, manual enroll and cancel | none ([Sequences](05-sequences.md#sequence-definition)) | M5.2 | Sequence and enrollment API tests pass |
| M5.4 | Scheduler: claims, the decision table, frequency cap, advance | none ([Sequences](05-sequences.md#scheduler)) | M5.3, M2.4 | Every row of the decision table has a test with the injected clock; crash tests show no duplicate sends |
| M5.5 | Sequence admin screens, subscriber tabs, test mode | none ([Sequences](05-sequences.md#admin-ui)) | M5.4, M4.2 | Screens checked with `agent-browser`; test mode runs a sequence with 1-minute waits |
| M5.6 | Worked example end to end | none ([Sequences](05-sequences.md#worked-example)) | M5.4 | The worked example passes with shortened waits, including restart, edit and unsubscribe scenarios |

### M6: 1.0

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M6.1 | Performance against the targets | none | M3.2, M5.4 | Numbers in `docs/perf/` meet the [throughput target](02-architecture.md#throughput-target) |
| M6.2 | `backup` command and operations guide | none | M0.4 | Backup taken under write load restores and opens; the guide covers the open-question defaults |
| M6.3 | Release workflow: three binaries on `v*` tags | none | M0.1 | A test tag produces working binaries for linux-x64, linux-arm64 and darwin-arm64 |
| M6.4 | `GET /api/openapi.json` with the new endpoints | `docs/swagger/collections.yaml` | M5.3, M3.4 | Every route in the router is in the document, and the contract suite validates responses against it |

### After 1.0

| ID | Task | Depends on |
|---|---|---|
| P.1 | Official Docker image that wraps the release executable ([D3](09-decisions.md#d3-bun-typescript-one-executable)) | M6.3 |

## Order

```text
M0.1 ─ M0.2 ─ M0.3 ─ M0.4 ─ M0.5          (serial, then M0.6–M0.8 in parallel)
M1.1 ─┬─ M1.2
      └─ M1.3 ─ M1.4 ─ M1.5 ─ M1.6 ─ M1.7, M1.9     M1.8, M3.5 alongside
M2.1 ─ M2.2 ─ M2.3 ─ M2.4 ─ M2.6                    M2.5 alongside
M3.1 ─ M3.2 ─ M3.3, M3.4
M4 can start once M1.4 and M0.6 are merged; each view waits for its API
M5.1 ─ M5.2 ─ M5.3 ─ M5.4 ─ M5.5, M5.6
M6 last
```

The critical path is M0 → M1.1 → M1.3 → M1.4 → M1.5 → M1.6 → M2.1 → M2.2 → M2.3 → M2.4 → M5.4. Everything else is scheduled around it.
