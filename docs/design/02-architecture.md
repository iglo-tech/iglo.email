# Architecture

## Platform

- **Runtime:** Bun ≥ 1.4, TypeScript, native ESM.
- **HTTP:** `Bun.serve` with a small router. No Express or other framework.
- **Database:** `bun:sqlite`, one database file, WAL mode, `foreign_keys = ON`, `busy_timeout` set.
- **Distribution:** one executable from `bun build --compile`, with admin assets, public pages, default templates, i18n files and migrations embedded. Linux x64/arm64 and macOS arm64.
- **No external services** apart from the SMTP server and, optionally, the provider sending bounce webhooks.

## Shared ground with other iglo.\* projects

These conventions are the same as [iglo.monitor](https://github.com/iglo-tech/iglo.monitor), so tooling and agent rules can be shared:

- Bun as runtime and package manager (`bun.lock`), with no npm or Node fallback paths.
- SQLite as the only database, opened from `--data-dir`.
- One compiled executable as the only release artifact. Releases are built on `v*` tags.
- `oxlint` and `oxfmt`, plus a pre-commit format hook.
- Renovate for dependency updates.
- `@/` path aliases and no relative imports. Import from the module that owns a symbol, with no barrel files.
- No process-global state. Modules receive the database, configuration and clock they use.

## Process model

One process runs everything. Background work is a set of loops in the same process, each owning one table of work.

| Loop | Interval | Work |
|---|---|---|
| Campaign runner | 5 s scan; continuous while campaigns run | Starts due campaigns. Streams subscribers in ID order with a cursor stored on the campaign, renders and sends through the SMTP pool with rate limits |
| Outbox | continuous, wakes on insert | Sends queued transactional and sequence messages from `sends` |
| Sequence scheduler | 15 s | Claims due enrollments, evaluates conditions, queues sends, advances steps |
| Webhook delivery | continuous, wakes on insert | Delivers queued outbound webhooks with retries |
| Maintenance | hourly | Refreshes dashboard and list stats, purges expired sessions, tokens and old events |
| Bounce mailbox | later | POP3 scanning |

Rules for every loop:

- **The database row is the state.** A loop holds nothing that cannot be rebuilt from tables after a restart.
- **Claim with a lease.** A row is claimed by setting `claimed_until` inside a `BEGIN IMMEDIATE` transaction. If the process dies, the lease expires and the row is picked up again. Each loop decides what "picked up again" means for its work (see at-most-once in [Sending](04-sending.md)).
- **Short write transactions.** SQLite has one writer at a time. Network calls (SMTP, webhooks) never run inside a transaction.
- **Graceful shutdown.** On SIGTERM, loops stop claiming, in-flight sends finish or time out, then the process exits.

This replaces listmonk's in-memory channels and Postgres row scanning with the same pattern everywhere. It also means no Redis, BullMQ or workflow engine. See [Decisions](09-decisions.md) D5.

## Throughput target

- 50 messages per second sustained for campaigns on one SMTP pool, which is above typical provider limits.
- 100 events per second on the events API without slowing sends.

SQLite in WAL mode handles this with batched writes: the campaign runner records progress per batch, not per message. Any change to sending, scheduling or storage must include before/after measurements (same rule as iglo.monitor).

## Module layout (initial)

```text
src/
  server/            HTTP server, router, middleware (auth, sessions, CSRF)
  config/            flags and environment, settings loader
  db/                connection, migrations runner, transaction helper
  subscribers/       store, segment queries, import, export
  lists/
  campaigns/         store, runner (pipeline, rate limits, cursor)
  templates/         store, Liquid engine setup, built-in functions
  messaging/         SMTP pool, message building, List-Unsubscribe, outbox
  tx/                transactional API
  sequences/         definitions, conditions, scheduler, enrollments
  events/            events API, event store, retention
  bounces/           bounce API, provider webhooks, actions
  tracking/          view pixel, link redirects, analytics queries
  webhooks/          outbound webhook delivery
  users/             users, roles, API tokens, sessions, TOTP
  media/             filesystem provider
  public/            public pages (subscribe, opt-in, unsubscribe, preferences)
  admin/             server-rendered admin views (TSX) and handlers
  i18n/
  maintenance/
assets/admin/        Alpine.js, Oat, CodeMirror, Squire, Chart.js (from listmonk v7)
migrations/          numbered SQL files
test/
```

Each module owns its tables and SQL. Other modules call its functions; they do not query its tables directly. Cross-module reads that matter for performance (segment queries, sequence conditions) go through the owning module's query builder.

## Application and request contracts (M0.3)

`src/app.ts` owns the application context currently constructed at startup: bootstrap
configuration, an injected clock, an error logger, and a translation instance. These
are concrete dependencies, passed explicitly. A request has its own URL, route
parameters, and validated ID in `src/server/context.ts`; it does not carry mutable
application-global request state. Valid IDs use a number when exactly representable,
and a bigint above that range, up to the signed 64-bit upstream limit. Database, stored settings and mailer dependencies
are added by their owning tasks when they exist, rather than as empty placeholders.

Bun supplies a normalized request URL; dot segments are removed before application
handlers run ([D18](09-decisions.md#d18-use-buns-normalized-request-path-for-dot-segments)). For path spellings Bun preserves,
parameters follow the default Go/Echo URI boundary: match the decoded path
when its escaping is canonical, otherwise retain the original escaped spelling
(`RawPath`). Parameters are not unescaped again. Encoded numeric IDs therefore
fail ID validation as upstream does, while canonical space and Unicode escapes
keep their normal decoded values. Query values use their own query decoding.

`src/clock.ts` owns `now()` and abortable `sleep()`; loops receive a clock instead of
reading real time. The HTTP router registers routes and middleware explicitly. Static
segments take precedence over parameter segments, and middleware runs in registration
order around a route. Unmatched API paths use the reference JSON 404. The public 404
HTML page is deferred; the current public fallback remains plain text, except that
HEAD returns the verified upstream status and HTML content type without a body.
Unexpected exceptions are logged and receive a safe JSON 500. The JSON helpers use
upstream envelopes, newline, content type and HTML-character escaping.

Each translation instance owns an immutable English base and optional language overlay;
`Load` returns an independent instance. All 38 copied packs are embedded; English is the verified default and the other packs
have not been reviewed. Missing keys return the key. Referenced substitutions stop
on a cycle or after 256 resolutions, leaving the unresolved `{key}` in place; missing
references resolve to the key without braces. Translations and parameters never use
process-global mutable request state. No language HTTP endpoint exists until auth.

## Configuration

- **Bootstrap settings come from flags and environment variables:** `--port`, `--host`, `--data-dir`, `--root-url`, and an initial admin user (`IGLO_EMAIL_ADMIN_USER` and `IGLO_EMAIL_ADMIN_PASSWORD`, used only when no users exist).
- **Everything else lives in the `settings` table** and is edited in the admin UI, as in listmonk: SMTP servers, rate limits, privacy options, bounce settings, appearance.
- **No `config.toml`.** Secrets in settings (SMTP passwords, webhook secrets) are stored as given. The data directory must be protected by the host.

## Data directory

```text
data/
  iglo-email.db        (+ -wal, -shm)
  uploads/             media files
  backups/             optional output of the backup command
```

Backups: `iglo.email backup <path>` uses SQLite's online backup. Continuous replication (for example Litestream) is an operator choice and is documented, not built in.

## Dependencies

Small and justified. v1 runtime dependencies:

| Package | Why |
|---|---|
| `liquidjs` | Safe, sandboxed template language for user-authored email ([Templates](06-templates.md)) |
| `nodemailer` | SMTP pool, MIME building, attachments, DKIM. Writing a correct SMTP client and MIME encoder is not worth owning |
| `marked` | Markdown campaigns and templates |

Built-in Bun or Web APIs cover the rest: password hashing (`Bun.password`), UUIDs, HMAC and TOTP (Web Crypto), gzip, file serving, and the JSX runtime (in-house, about 100 lines). Admin UI assets are listmonk v7's browser dependencies (Alpine.js, Oat, CodeMirror, Squire, Chart.js), bundled at build time.
