# iglo.email design

Kickoff design for porting listmonk v7 to Bun + SQLite and adding lifecycle sequences. Read in order.

| # | Doc | Covers |
|---|---|---|
| 1 | [Scope](01-scope.md) | Goals, non-goals, what is kept, deferred or dropped from listmonk |
| 2 | [Architecture](02-architecture.md) | Runtime, process model, background loops, module layout, configuration, distribution |
| 3 | [Data model](03-data-model.md) | listmonk's Postgres schema mapped to SQLite, new tables, migrations |
| 4 | [Sending](04-sending.md) | SMTP, campaigns, transactional API, unsubscribe, tracking, bounces, send log, webhooks |
| 5 | [Sequences](05-sequences.md) | Events API, sequence definitions, conditions, scheduler, marketing rules |
| 6 | [Templates](06-templates.md) | Template language for user-authored email and the admin UI views |
| 7 | [API and admin UI](07-api-and-ui.md) | API compatibility policy, authentication, admin UI port, public pages |
| 8 | [Port plan](08-port-plan.md) | Upstream baseline, milestones, testing strategy |
| 9 | [Decisions](09-decisions.md) | Short decision records with reasons |
| 10 | [Open questions](10-open-questions.md) | What still needs the owner |
| 11 | [Work plan](11-work-plan.md) | Tasks, briefs, council review and merge, run by agents |

## Decisions at a glance

- Independent rewrite derived from listmonk **v7.0.0-beta.1** (`6fcd95f`), not an upstream-tracking fork.
- **AGPL-3.0**, inherited from listmonk.
- **Bun ≥ 1.4, TypeScript, one compiled executable.** MVP targets Linux x86-64 only; macOS and Linux arm64 are post-MVP (D42). An official Docker image wrapping it follows after 1.0.
- **SQLite only** (`bun:sqlite`, WAL), one process.
- **Durable work is rows in SQLite** processed by in-process loops. No Postgres, Redis, BullMQ or workflow engine.
- **listmonk's HTTP API is kept** for ported endpoints, so existing SDKs and integrations keep working, except where upstream's design is poor: those are fixed and listed as deliberate differences. New features get new endpoints.
- **Admin UI:** v7's server-rendered views ported to server-side TSX; v7's Alpine.js, Oat, CodeMirror and Squire assets reused.
- **User-authored templates use Liquid** (LiquidJS) instead of Go templates.
- **Sequences are data:** definitions plus enrollments with a due time. Conditions are a small JSON predicate language.
- **Marketing sends are at-most-once:** a crash can skip an email, never duplicate it.

## Status

The M0.1–M0.6 skeleton provides the bootstrap CLI, local checks, an opt-in upstream reference, shared application and HTTP contracts, SQLite primitives, an injected-clock loop helper, an explicit reference/production/fixture contract corpus, server-side JSX, a reusable test-only admin shell, embedded browser assets and the production public HTML 404. The embedded production migration installs the version-1 schema. M1.3 adds real users, credentials, sessions and a functional password-login form. M1.4 adds role APIs, live permission checks and a TOTP login boundary; the shared corpora exercise compiled production. M1.4 adds roles and TOTP; M1.5 adds authenticated lists and subscriber-owned live membership counts. M1.4–M1.6 add roles, list management and ID-addressed subscriber lifecycle; collection subscriber queries and background loops remain pending. Agents follow the [work plan](11-work-plan.md); progress is in [`docs/status.md`](../status.md).
