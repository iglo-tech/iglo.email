# Data model

The starting point is listmonk v7's `schema.sql` and `queries/*.sql`. Tables keep their names and meaning so the port can be checked side by side. Postgres-only features are mapped to SQLite as below.

## Postgres to SQLite

| Postgres in listmonk | SQLite in iglo.email |
|---|---|
| `SERIAL` / `BIGSERIAL` | `INTEGER PRIMARY KEY AUTOINCREMENT` (non-reused automatic identities) |
| `uuid` columns, `pgcrypto` | `TEXT`, generated in app code (`crypto.randomUUID()`) |
| `ENUM` types (14 of them) | `TEXT` with a `CHECK (col IN (...))` constraint |
| `JSONB` | `TEXT` holding JSON, with `CHECK (json_valid(col))`. Read with `->`, `->>` and `json_extract` |
| `TEXT[]` (role permissions), `VARCHAR(100)[]` (tags) | JSON arrays in `TEXT`. Queried with `json_each` |
| `TIMESTAMP WITH TIME ZONE` | `TEXT` in ISO 8601 UTC (`2026-10-27T13:45:00.000Z`). Sortable and readable |
| `LOWER(email)` unique index | `email TEXT NOT NULL COLLATE NOCASE UNIQUE` |
| `ILIKE` (8 queries) | `LIKE` (case-insensitive for ASCII) or `COLLATE NOCASE` |
| `to_tsvector` full-text search (1 query) | FTS5 virtual table on subscriber name and email, kept in sync by triggers |
| `UNNEST`, `ARRAY_AGG` | `json_each`, `json_group_array` |
| `DISTINCT ON` (2 queries) | window functions (`ROW_NUMBER() OVER (PARTITION BY ...)`) |
| `ON CONFLICT`, `RETURNING` | supported natively |
| Materialized views (`mat_dashboard_counts`, `mat_dashboard_charts`, `mat_list_subscriber_stats`, `mat_list_charts`) | ordinary summary tables, rebuilt by the maintenance loop |
| `settings.value JSONB` | same layout, JSON in `TEXT` |
| Postgres session store | `sessions` table, same columns |

M0.7 measured a reduced synthetic event store and subscriber FTS5 triggers;
[the spike report](../perf/M0.7-sqlite-write-load.md) records churn and rollback
costs. These fixtures are not the production migration or a subscriber-search
API implementation, and do not establish end-to-end feature acceptance.

Query files stay as named SQL files (`-- name: get-subscriber`), the format listmonk uses. Each owning module supplies only its own embedded text to the loader, prepares it once, binds values, and closes its statements. Duplicate names, empty blocks and invalid SQL fail at preparation. Each block contains one statement; multiple statements, including trigger bodies with statement separators, are unsupported in named query files. Semicolons and marker-like text inside strings and comments remain SQL text. Migration files can contain multiple statements.

Persistent integer identities use SQLite `AUTOINCREMENT` so automatically allocated committed IDs are not reused after deletion. This preserves upstream SERIAL/BIGSERIAL identity assumptions, including retained session user IDs and references stored outside foreign keys. Application owners allocate IDs automatically and never insert a previously used or lower explicit ID; SQLite permits explicit IDs. The subscriber campaign high-water cursor depends on the same rule. SQLite `NOCASE` folds ASCII characters only, not arbitrary Unicode. Application code supplies UUIDs and sortable UTC timestamps; SQL defaults for translated upstream timestamps use UTC ISO-8601 with milliseconds. SQLite does not validate timestamp strings. Detailed foreign-key and retention choices are recorded in [M1.1 schema evidence](../perf/M1.1-schema.md).

The user owner stores opaque session IDs and JSON containing the user identity
and session-bound CSRF value. The injected clock and session policy determine
expiry; the user is reloaded on each access. User and session writes use this
schema without an additional migration. The role owner supplies role projections
and permission checks, and the list owner supplies read-only labels.

## Segment queries

listmonk lets admins write raw SQL `WHERE` fragments over `subscribers`, for example `subscribers.attribs->>'city' = 'Bengaluru'`. SQLite 3.38+ supports `->` and `->>` with the same meaning, so many existing queries work unchanged. Postgres-specific functions do not, and that breaking change is accepted (documented in the admin UI help text).

Safety (M1.7, [measurements](../perf/M1.7-query.md)):

- Built-in filters (lists, statuses, search) run in-process on a **separate read-only connection** (`readonly: true`, `PRAGMA query_only`). A raw fragment runs in a **child process** of the same executable with its own read-only connection, because bun:sqlite exposes neither `sqlite3_progress_handler` nor `sqlite3_interrupt`, and terminating a Worker does not stop a running SQLite step.
- The fragment is checked lexically (no `;`, comments, unterminated quotes or parentheses that leave its own) and wrapped as `... WHERE ... AND (<fragment>)` in upstream's `query-subscribers` shape, including the `LEFT JOIN subscriber_lists`. Before it runs, the compiled program must be a read-only `SELECT` with exactly the bound parameters, and, as in listmonk's `validateQueryTables`, may open only `subscribers`, `lists`, `subscriber_lists`, `campaigns`, `campaign_lists`, `campaign_views`, `links`, `link_clicks` and `bounces` (checked from `EXPLAIN` root pages). The only virtual tables it may open are the subscriber FTS5 index and `json_each`/`json_tree` (checked from `EXPLAIN` `VOpen` objects); `pragma_*` functions, `dbstat`, FTS5 shadow tables and other virtual or eponymous tables are refused, as are users, sessions, settings and the schema table.
- Time limit: the parent drains the child's output as it arrives, and the child is killed with SIGKILL 10 s after it starts, whether or not the HTTP reader is consuming; a streaming export then ends with an error. A resident-memory watchdog kills it above 256 MiB (bun:sqlite ignores `hard_heap_limit`). At most two children run at once; a request waits at most 1 s for a slot, then gets 429. A slot is released when its child exits.
- Large selections (`per_page=all` and pages above 1,000 rows, exports and raw-query bulk actions) hold the selected IDs in the parent (about 40 bytes each); at most two run at once and excess requests get 429.
- Query-selected bulk actions take the fragment's IDs from that snapshot, then recheck built-in filters and current list permissions in one write transaction, in batches of 500.
- The permission is the same as listmonk's (`subscribers:sql_query`).

## Kept tables

`subscribers`, `lists`, `subscriber_lists`, `templates`, `campaigns`, `campaign_lists`, `campaign_views`, `media`, `campaign_media`, `links`, `link_clicks`, `settings`, `bounces`, `roles`, `users`, `sessions`.

Changes to kept tables:

| Table | Change | Why |
|---|---|---|
| `subscribers` | add `external_id TEXT NULL UNIQUE` | Apps address subscribers by their own user ID instead of email |
| `campaign_views`, `link_clicks` | add `send_id INTEGER NULL REFERENCES sends(id)`, make `campaign_id` nullable, `CHECK` that exactly one is set | Track opens and clicks of transactional and sequence messages |
| `bounces` | add nullable `send_id`; permit a nullable `subscriber_id` | A transactional send can target an address without a subscriber, and its bounce must still be recordable |
| `templates` | `body` holds Liquid instead of Go template syntax | [Templates](06-templates.md) |

## New tables

### `campaign_links`

`campaign_id` → campaigns, `link_id` → links (both cascade), primary key on the pair (migration 6, M3.1). A row records that the campaign's own rendered content produced the link; the public campaign redirect requires it ([Tracking](04-sending.md#tracking)).

### `campaign_deliveries`

`campaign_id` → campaigns, `subscriber_id` → subscribers (both cascade), `status` (`claimed`, `sent`, `failed`, `unknown`, `skipped` when the subscriber lost eligibility before the push), `at`; primary key on the pair, index on (`subscriber_id`, `at`) (migration 7, M3.2). The runner inserts a `claimed` row for every subscriber of a batch in the transaction that advances the cursor, before sending, and settles it per batch. The key makes a second campaign message to the same subscriber impossible. `claimed` rows found when a runner takes over a campaign are from a crash and become `unknown`. `claimed`, `sent` and `unknown` rows count toward the marketing frequency cap from `at`.

Migration 7 also adds `campaigns.runner_lease` and `runner_lease_until`: the runner holding the campaign and its lease expiry.

### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `subscriber_id` | INTEGER NOT NULL → subscribers, ON DELETE CASCADE | |
| `name` | TEXT NOT NULL | `order_paid`, `subscription_canceled`, ... |
| `data` | TEXT JSON NOT NULL DEFAULT '{}' | Event properties |
| `occurred_at` | TEXT NOT NULL | Sent by the app, defaults to receive time |
| `created_at` | TEXT NOT NULL | |
| `idempotency_key` | TEXT NULL | Unique per subscriber when set |
| `enrollments` | TEXT NULL | JSON `{started, ended}` the first request with a key changed, replayed for a repeated key (M5.3) |

Indexes: `(subscriber_id, name, occurred_at)`, unique `(subscriber_id, idempotency_key)`. Retention: configurable, default 400 days, purged by maintenance.

### `sequences`, `sequence_steps`

`sequences`: `id`, `uuid`, `name`, `status` (`draft`, `active`, `paused`, `archived`), `trigger` (JSON), `exit_on` (JSON array of event names), `reentry` (`never`, `after_exit`, `always`), `list_id` (the list that grants marketing permission for this sequence's marketing steps, nullable), timestamps.

`sequence_steps`: `id`, `uuid`, `sequence_id`, `position`, `wait` (ISO 8601 duration, `P3D`), `kind` (`marketing`, `transactional`), `template_id`, `subject` (optional override), `condition` (JSON, nullable), `on_false` (`skip`, `exit`), `cap_policy` (`defer`, `skip`), `max_late` (ISO 8601 duration, nullable), `status` (`active`, `deleted`), timestamps.

Steps are never hard-deleted while enrollments point at them; deleting sets `status = 'deleted'` and the scheduler moves past it. See [Sequences](05-sequences.md).

### `enrollments`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `sequence_id` | INTEGER NOT NULL → sequences | |
| `subscriber_id` | INTEGER NOT NULL → subscribers, ON DELETE CASCADE | |
| `trigger_event_id` | INTEGER NULL → events | The event that started it, for template data and "since trigger" conditions |
| `step_id` | INTEGER NULL → sequence_steps | Next step to run. NULL when finished |
| `due_at` | TEXT NULL | When `step_id` should run |
| `status` | TEXT CHECK IN (`active`, `completed`, `exited`, `canceled`) | |
| `exit_reason` | TEXT NULL | `condition`, `event:<name>`, `unsubscribed`, `blocklisted`, `manual`, `sequence_archived`, `subscriber_deleted` (M5.4) |
| `claimed_until` | TEXT NULL | Scheduler lease |
| `retry_at` | TEXT NULL | When a released enrollment may be claimed again after a failed attempt; `due_at` is kept for `max_late` (M5.4) |
| `created_at`, `updated_at`, `finished_at` | TEXT | |

Indexes: `(status, coalesce(retry_at, due_at))` for the scheduler claim, `(subscriber_id, sequence_id)`, `(sequence_id, status)`, and unique `(subscriber_id, sequence_id) WHERE status = 'active'`: at most one active enrollment per subscriber and sequence. Active sequences are indexed by `trigger.event`.

### `sends`

One row per individual message that is not part of a campaign: transactional API calls and sequence steps.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `uuid` | TEXT UNIQUE | Used in tracking and unsubscribe URLs |
| `source` | TEXT CHECK IN (`tx`, `sequence`) | |
| `kind` | TEXT CHECK IN (`marketing`, `transactional`) | |
| `subscriber_id` | INTEGER NULL → subscribers | NULL for transactional sends to addresses that are not subscribers |
| `to_email` | TEXT NOT NULL | Recipient at send time |
| `template_id` | INTEGER NULL → templates | |
| `enrollment_id`, `step_id` | INTEGER NULL | For sequence sends. Unique `(enrollment_id, step_id)` |
| `list_id` | INTEGER NULL → lists | Unsubscribe scope for marketing sends |
| `idempotency_key` | TEXT NULL UNIQUE | For tx API calls |
| `status` | TEXT CHECK IN (`queued`, `sending`, `sent`, `failed`, `skipped`, `unknown`) | `unknown`: the process died while sending; never retried automatically |
| `skip_reason` | TEXT NULL | `unsubscribed`, `blocklisted`, `frequency_cap`, `condition`, `bounced`; M2.4 tx marketing also uses `not_subscribed`, `unconfirmed`, `list_unavailable`; M5.4 sequence steps also use `late`, `template_unavailable`, `render_failed` |
| `smtp_message_id` | TEXT NULL | Stable `Message-ID` assigned before enqueue commit |
| `error` | TEXT NULL | |
| `payload` | TEXT JSON | Private bounded versioned prepared message, including encoded bytes |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | |
| `claimed_until` | TEXT NULL | Outbox lease; expiry does not authorize replay |
| `next_attempt_at` | TEXT NULL | Proven transient transactional retry deadline |
| `retry_of` | INTEGER NULL → sends | Unique manual resend parent, cleared if parent is deleted |
| `attempted_at` | TEXT NULL | Latest outbox claim, committed with `sending` before SMTP and kept through `unknown` recovery (migration 3, M2.4) |
| `created_at`, `sent_at` | TEXT | |

Indexes: `(status, created_at)`, `(status, next_attempt_at, id)` for due work, unique non-null `retry_of`, and `(subscriber_id, kind, sent_at)` for the frequency cap (M2.4).

### `webhooks`, `webhook_deliveries`

`webhooks`: `id`, `url`, `secret`, `events` (JSON array), `enabled`, timestamps.

`webhook_deliveries`: `id`, `uuid` (the delivery ID in webhook bodies), `webhook_id`, `event`, `payload`, `status` (`queued`, `delivered`, `failed`), `attempts`, `next_attempt_at`, `last_error`, `claimed_until`, timestamps. Retried with backoff for up to 24 hours, then marked `failed`.

## Migrations

- Numbered SQL files in `migrations/`, embedded in the executable, applied in order at startup inside one transaction each. The applied version is stored in `PRAGMA user_version`.
- **The first migration is the full v1 schema**, not a translation of listmonk's migration history.
- Forward-only. The runner validates a contiguous manifest and rejects databases ahead of the executable. It takes one SQLite-consistent `VACUUM INTO` snapshot before a pending batch on a database with a previous version or user schema; an error prevents migration. It keeps each successful earlier migration if a later one fails. No public backup command exists yet.
- The production manifest embeds `0001_init.sql` at version 1. The migrated baseline has no seeded application rows; future owners supply settings, roles, users and templates. Migration bodies omit transaction commands and PRAGMAs, which the runner and connection own.
- Within each file transaction, SQLite parses one complete statement at a time, including trigger bodies and keyword identifiers. Top-level transaction/connection commands, PRAGMAs and EXPLAIN are rejected before preparation; EXPLAIN can otherwise cause PRAGMA preparation side effects. Migration SQL is static with no bound parameters. Each parsed SQL text must match the remaining source prefix before execution; all statements and the version update share the file's transaction.
- `VACUUM INTO` makes a consistent live snapshot including committed WAL content; it is synchronous, requires free disk space, and cannot run inside a transaction. It rebuilds the database and can change implicit rowids in tables without an explicit `INTEGER PRIMARY KEY`. The runner verifies integrity and version, publishes a unique completed file, and leaves a recognizable partial directory if interrupted. SQLite documents that an interrupted snapshot can be incomplete; it is never published as a completed snapshot. Migrations run at startup under the single-process model: writes by a separate process after the snapshot are not captured. See [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) and [backup techniques](https://www.sqlite.org/backup.html).

## Importing from listmonk

Not in v1. Later, an `iglo.email import-listmonk <postgres-url>` command can read a listmonk database directly with `Bun.sql` (built-in Postgres client), converting templates from Go syntax where possible and reporting the ones it cannot convert.
