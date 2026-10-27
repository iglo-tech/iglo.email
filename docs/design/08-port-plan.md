# Port plan

## Upstream baseline

| | |
|---|---|
| Repository | https://github.com/knadh/listmonk |
| Tag | `v7.0.0-beta.1` |
| Commit | `6fcd95f32bb633d3a62a06c383c0b3322eecc898` (2026-10-20) |
| License | AGPL-3.0 |

v7 is the baseline because its admin UI is already server-rendered with Alpine.js and Oat, built with Bun. That is close to where iglo.email wants to be, while v6's admin UI was a Vue 2 single-page app with end-of-life dependencies.

When v7.0.0 final is released, the diff `v7.0.0-beta.1..v7.0.0` is reviewed once and relevant fixes are ported. After iglo.email 1.0, upstream changes are ported only by choice, never tracked.

What gets ported, by upstream path:

| Upstream | Size | Becomes |
|---|---|---|
| `schema.sql`, `queries/*.sql` | about 2,100 lines of SQL | `migrations/0001_init.sql`, `src/*/queries.sql` (SQLite dialect) |
| `cmd/*.go` (HTTP handlers, init) | about 12,500 lines of Go | `src/server`, per-module handlers |
| `internal/manager` | about 1,300 lines; campaign pipeline | `src/campaigns/runner` |
| `internal/messenger/email` | SMTP pool | `src/messaging` (nodemailer) |
| `internal/bounce`, `internal/subimporter`, `internal/media`, `internal/auth`, `internal/notifs`, `internal/i18n` | about 9,800 lines with the rest of `internal/` | matching modules |
| `static/admin/views`, `partials` | 26 views, 37 partials | `src/admin/views/*.tsx` |
| `static/admin/assets` | about 6,000 lines of JS and the CSS | `assets/admin` (mostly unchanged) |
| `static/public/templates` | 12 pages | `src/public/views/*.tsx` |
| `static/email-templates` | default and system emails | Liquid templates in `src/templates/builtin` |
| `i18n/*.json` | | `i18n/` (unchanged keys) |
| `tests/specs` (Playwright) | 137 tests | `test/e2e` (adapted) |

## Milestones

Each milestone ends with something usable and tested. M4 can run in parallel with M2 and M3 once M1 is done.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Skeleton:** Bun project, `@/` aliases, oxlint/oxfmt, hooks, CI, Renovate, `bun build --compile`, `Bun.serve` with `/health`, SQLite connection, migrations runner, flags and env, `AGENTS.md` commands | The executable starts, migrates an empty database and serves `/health` |
| M1 | **Core data and API:** v1 schema, SQL file loader, subscribers (with `external_id`, segments, FTS), lists, templates (Liquid), settings, users, API tokens, roles, sessions, CSV import | The API contract suite passes for these endpoints against both listmonk and iglo.email |
| M2 | **Individual sending:** SMTP pool, `POST /api/tx` with the new fields, outbox, send log, opt-in and unsubscribe pages, marketing unsubscribe and `List-Unsubscribe`, outbound webhooks | The first consumer can move its transactional emails to iglo.email |
| M3 | **Campaigns:** runner, rate limits, cursor, tracking, analytics summary tables, bounce API and Mailgun webhook | A campaign to 10,000 test subscribers through Mailpit respects rate limits, and a restart mid-campaign resumes without duplicates |
| M4 | **Admin UI:** views ported in this order: login and 2FA, dashboard, subscribers, lists, templates, campaigns, settings, users and roles, bounces, media, import, analytics, maintenance, logs | The adapted upstream Playwright suite passes |
| M5 | **Sequences:** subscriber events API, sequences, conditions, scheduler, frequency cap, admin screens, test mode | The worked example in [Sequences](05-sequences.md) runs end to end with shortened waits, including restart, edit and unsubscribe scenarios |
| M6 | **1.0:** performance measurements against the targets in [Architecture](02-architecture.md), backup command, operations guide, release workflow on `v*` tags | Tagged release with binaries for linux-x64, linux-arm64 and darwin-arm64 |

## Testing strategy

- **Tests check behavior through public boundaries:** HTTP API, rendered pages, emails received by the SMTP sink, and webhook deliveries received by a test server. Never source text or internal calls (same rule as other iglo.\* projects).
- **API contract suite:** one suite, run against a base URL. In reference mode it runs against upstream listmonk (the release binary and a disposable Postgres, a dev-only harness). In normal mode it runs against iglo.email. Assertions compare status codes, field names and types, and behavior, not generated IDs or timestamps. Differences that are deliberate are listed in [API and admin UI](07-api-and-ui.md) and marked in the suite.
- **Mail:** [Mailpit](https://mailpit.axllent.org) as the SMTP sink, and its API to assert subjects, recipients, headers (`List-Unsubscribe`, `Message-ID`) and bodies.
- **Time:** every loop takes an injected clock, so sequence tests advance time instead of sleeping. The test mode in the admin UI uses the same mechanism.
- **Crash scenarios:** tests kill the process at chosen points (after claiming, after inserting a send, mid-batch) and check the at-most-once guarantees after restart.
- **Admin UI:** upstream's Playwright specs are adapted to iglo.email's paths and Liquid templates. Browser verification uses `agent-browser`.

## How to port a module

1. Read the upstream handler (`cmd/<area>.go`), its queries (`queries/<area>.sql`) and its models.
2. Write or extend contract tests for the endpoints, and run them against upstream to confirm they describe real behavior.
3. Port the SQL to SQLite, then the handler and store to TypeScript, keeping names close to upstream's where that helps comparison.
4. Run the contract tests against iglo.email, and record any deliberate difference.
5. Port the related admin view, if any, and its Playwright spec.
