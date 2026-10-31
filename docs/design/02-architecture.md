# Architecture

## Platform

- **Runtime:** Bun ≥ 1.4, TypeScript, native ESM.
- **HTTP:** `Bun.serve` with a small router. No Express or other framework.
- **Database:** `bun:sqlite`, one database file, WAL mode, `foreign_keys = ON`, `synchronous = FULL`, `busy_timeout = 5000` and safe 64-bit integers.
- **Distribution:** one executable from `bun build --compile`, with admin assets, public pages, default templates, i18n files and migrations embedded. Linux x86-64 for MVP; Linux arm64 and macOS are post-MVP (D42).
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

One server process runs everything that writes. Background work is a set of loops in that process, each owning one table of work. Slow or untrusted reads run in short-lived read-only helpers: the same executable re-run with an internal argument, one read each, owned and killed by the server. They hold no state and never write ([D62](09-decisions.md#d62-read-only-helper-processes-for-slow-reads)).

| Loop               | Interval                                                                                                | Work                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campaign runner    | 5 s scan; continuous while campaigns run                                                                | Starts due campaigns. Streams subscribers in ID order with a cursor stored on the campaign, renders and sends through the SMTP pool with rate limits                                                                  |
| Outbox             | continuous, wakes on insert                                                                             | Sends queued transactional and sequence messages from `sends`                                                                                                                                                         |
| Sequence scheduler | 15 s                                                                                                    | Claims due enrollments, evaluates conditions, queues sends, advances steps                                                                                                                                            |
| Webhook delivery   | continuous, wakes on insert                                                                             | Delivers queued outbound webhooks with retries                                                                                                                                                                        |
| Maintenance        | hourly                                                                                                  | Purges expired sessions, tokens and old events                                                                                                                                                                        |
| Summary refresh    | `app.cache_slow_queries_interval`, re-checked at least every minute; only with `app.cache_slow_queries` | Replaces the `analytics_summaries` rows from a reader helper in one short write. It has no work rows to claim, so it does not use the lease helper; a failed or unusable schedule is logged and keeps the stored rows |
| Bounce mailbox     | later                                                                                                   | POP3 scanning                                                                                                                                                                                                         |

Rules for every loop:

- **The database row is the state.** A loop holds nothing that cannot be rebuilt from tables after a restart.
- **Claim with a lease.** A row is claimed by setting `claimed_until` inside a `BEGIN IMMEDIATE` transaction. If the process dies, the lease expires and the row is picked up again. Each loop decides what "picked up again" means for its work (see at-most-once in [Sending](04-sending.md)).
- **Short write transactions.** SQLite has one writer at a time. Network calls (SMTP, webhooks) never run inside a transaction.
- **Graceful shutdown.** On SIGTERM, loops stop claiming, in-flight sends finish or time out, then the process exits.

This replaces listmonk's in-memory channels and Postgres row scanning with the same pattern everywhere. It also means no Redis, BullMQ or workflow engine. See [Decisions](09-decisions.md) D5.

M0.4 provides the lifecycle helper but starts no domain loops. Each owning store
supplies its own synchronous claim callback, eligibility and recovery policy;
the helper runs the claim in a short `BEGIN IMMEDIATE` transaction, then
processes the bounded batch serially outside it. Stop cancels idle clock waits,
prevents new claims and waits for started work. Expiry by itself never authorizes
re-sending a marketing message. Processing failures are exposed to the caller,
not automatically retried. Owners must bound their own external I/O.
Between nonempty batches it awaits an abortable zero-delay sleep on the injected
clock. The real clock yields an event-loop turn so synchronous processors cannot
starve HTTP or shutdown; fake clocks release that wait explicitly with a zero-time
advance. Empty claims retain the configured polling interval.

## Throughput target

- 50 messages per second sustained for campaigns on one SMTP pool, which is above typical provider limits.
- 100 events per second on the events API without slowing sends.

SQLite in WAL mode handles this with batched writes: the campaign runner records progress per batch, not per message. Any change to sending, scheduling or storage must include before/after measurements (same rule as iglo.monitor).

M0.7 measured the durable SQLite path with synthetic campaign progress, events
and FTS churn on one host; see [the spike report](../perf/M0.7-sqlite-write-load.md)
for the bounded queues and one-event window miss. This is storage-component
evidence, not end-to-end acceptance of campaign sending or the events API;
M3.2, M5.1 and M6.1 own those checks.

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
  users/             users, API tokens, sessions, authentication and login
  roles/             role ownership, lookup and permissions
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

## Application and request contracts (M0.3–M0.4)

`src/app.ts` owns the application context currently constructed at startup: bootstrap
configuration, an injected clock, a database connection, an error logger, and a translation instance. These
are concrete dependencies, passed explicitly. A request has its own URL, route
parameters, and validated ID in `src/server/context.ts`; it does not carry mutable
application-global request state. Valid IDs use a number when exactly representable,
and a bigint above that range, up to the signed 64-bit upstream limit. Stored settings and mailer dependencies
are added by their owning tasks when they exist, rather than as empty placeholders.

Bun supplies a normalized request URL; dot segments are removed and literal
backslashes become slashes before application handlers run
([D18](09-decisions.md#d18-use-buns-normalized-request-path)). For path spellings Bun preserves,
parameters follow the default Go/Echo URI boundary: match the decoded path
when its escaping is canonical, otherwise retain the original escaped spelling
(`RawPath`). Parameters are not unescaped again. Encoded numeric IDs therefore
fail ID validation as upstream does, while canonical space and Unicode escapes
keep their normal decoded values. Query values use their own query decoding.
Malformed percent-escape syntax in the exposed path is rejected before routing
and middleware with the upstream transport's plain-text 400 response. Valid
escapes of invalid UTF-8, such as `%FF`, still reach parameter validation.

`src/clock.ts` owns `now()` and abortable `sleep()`; loops receive a clock instead of
reading real time. The HTTP router registers routes and middleware explicitly. Static
segments take precedence over parameter segments, and middleware runs in registration
order around a route. Unmatched API paths use the reference JSON 404. Unmatched
public paths render the escaped public HTML 404 through the injected translation
instance; HEAD returns the same verified status and content type without a body.
Explicitly built static assets are embedded and served without runtime disk lookup.
Their methods and missing-path responses follow the pinned reference for paths
Bun preserves; encoded dot segments still follow D18 normalization. Production
has a functional login form and explicit protected user routes; the full admin
shell remains a synthetic compiled fixture until its screens exist.
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
  backups/             pre-migration snapshots, and `backup` output by default
```

Startup opens `iglo-email.db`, validates and applies the embedded migration
manifest, then starts HTTP. It closes the connection after HTTP shutdown or a
startup failure. A nonempty database with pending migrations gets one verified
SQLite `VACUUM INTO` snapshot before the batch. `iglo.email backup` takes a live
snapshot from a separate read-only process, with a short-lived helper that syncs its
output ([operations guide](../operations.md#backups)). A backup carries a
restore hold: a database restored from one sends nothing until an operator
releases it ([D67](09-decisions.md#d67-a-restored-database-holds-all-sending-until-an-operator-releases-it)). Continuous replication
(for example Litestream) is an operator choice, not built in.

## Dependencies

Small and justified. v1 runtime dependencies:

| Package      | Why                                                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liquidjs`   | Safe, sandboxed template language for user-authored email ([Templates](06-templates.md))                                                                                                                 |
| `nodemailer` | SMTP pool, MIME building, attachments, DKIM. Writing a correct SMTP client and MIME encoder is not worth owning                                                                                          |
| `marked`     | Markdown campaigns and templates                                                                                                                                                                         |
| `qrcode`     | TOTP provisioning QR/PNG response; pinned 1.5.4, MIT ([D30](09-decisions.md#d30-role-mutations-and-the-totp-authentication-boundary))                                                                    |
| `saxes`      | Strict streaming XML list input; pinned 6.0.0, ISC, xmlchars 2.2.0 MIT; consumed UTF-8/document boundary and declaration/depth restrictions ([D37](09-decisions.md#d37-strict-streaming-xml-list-input)) |

Built-in Bun or Web APIs cover the rest: password hashing (`Bun.password`), UUIDs, HMAC and TOTP (Web Crypto), gzip, file serving, and the JSX runtime (in-house, about 100 lines). Admin UI assets are listmonk v7's browser dependencies (Alpine.js, Oat, CodeMirror, Squire, Chart.js), bundled at build time.

Unmatched non-static `/admin/*` paths use the public HTML 404 while M4.1 views remain pending. The admin-specific error page remains staged; the shell fixture does not implement production administration. Embedded static assets support metadata-only HEAD under [D21](09-decisions.md#d21-support-head-for-embedded-assets).
