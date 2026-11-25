# External sources

Status: planned for the next 2.x minor (owner direction 2026-11-25, [D169](09-decisions.md#d169-external-sources-pocketbase-first-owner-2026-11-25)). Briefs: [B150](../briefs/B150.md). Each task adds an "As built" note to the section it implements.

An application that keeps its users' activity in its own PocketBase can let iglo.email read that activity there instead of pushing events to `/api/events`. PocketBase stays the only store of what users did: iglo.email copies none of it. The source is event-driven (a live subscription); nothing polls it on a timer.

The events API and the local `events` table stay for applications that push. A sequence uses one or the other, never both.

## 1. The interface

`ExternalSource` is a small interface with PocketBase as its first and only adapter (D89: one adapter until a second is needed; the interface exists so sequence code does not depend on PocketBase details). One source per project, configured in the project's settings.

| Operation | Meaning |
|---|---|
| `subscribe(topics, handler)` | Live records (events `create`, users matching the leaving filter) |
| `catchUp(topic, from, page)` | Keyset pages of records created (or updated, for users) at or after a bound |
| `recipient(externalId)` | The recipients-view row of one user: address, name, opt-out field, other fields; `null` when absent |
| `record(id)` | One events record; `null` on 404 |
| `latest(filter)` | The newest events record matching a filter |
| `count(filter, upTo)` / `exists(filter)` | A bounded count; existence |
| `scan(filter, fields, limit)` | Keyset pages over `(occurredAt, id)` for aggregates |

Every operation takes an `AbortSignal` and a timeout. Errors are classified as **transient** (network error, timeout, 5xx, 429) or **permanent** (400, 403, 404 where a record was not expected to vanish, a missing field). No operation ever runs inside a SQLite transaction.

## 2. Settings (project keys)

Secrets are stored and masked as the SES secret key is.

- URL; service-account credentials: an auth collection the operator creates for iglo.email (for example `services`), identity and password (secret).
- Events collection and field mapping: `user` (relation to the user), `name`, `data` (JSON), `occurredAt`, `key` (optional idempotency key).
- Recipients collection, typically a view, and its mapping: `email`, `name`, opt-out field. Addresses are read here, never from the auth collection (auth collections hide `email` from non-owners unless `emailVisibility` is on).
- Users collection to watch for people leaving and its filter (for example `deletedAt != ''`).
- `grant_lists` rules: "an event matching P grants lists L" (P: event name plus optional `data.*` equality; L: list IDs of this project).

The source URL is refused by `webhooks.block_private_addresses` (instance key, D122) exactly as a webhook target is: a project admin chooses the URL, so the same server-side request guard applies. One narrow exemption (D169, amended): the instance key `sources.private_hosts`, a list of host names an instance admin sets, lets a source URL whose host is on the list resolve to a private, loopback, link-local or unique-local address while the block stays on. Matching is exact and case-insensitive on the URL's host (no wildcards, no IP ranges, at most 20 entries); the resolved address is still checked at every connection, so the exemption covers only those names. Project admins and API tokens cannot change it (instance key, instance session only). Webhook targets never use it. With the block off, nothing changes.

## 3. What iglo.email stores

- **Subscriber:** the address (needed for consent, suppressions, bounces, List-Unsubscribe and campaigns), consent and lists, the existing `external_id` ([03](03-data-model.md)) = the PocketBase user ID, and a display name refreshed from the source.
- **Enrollments:** as today, plus `trigger_external_id` and `trigger_occurred_at` (`trigger_event_id` stays for pushed events), `error_since`, and the `source_error` / `trigger_missing` exit reasons.
- **Send log:** as today.
- **Stream state:** one resume marker per subscription topic; a dedupe table `(record_id, record_created)`; a per-record retry queue (record, attempts, next attempt, last error, terminal flag).

Not stored: the events themselves, or any recipients-view field other than address and name.

## 4. Receiving records

- **Client.** A `fetch`-based SSE client for PocketBase's realtime protocol (Bun has no `EventSource`): `GET /api/realtime`, read `PB_CONNECT` for the client ID, then `POST /api/realtime` with `{clientId, subscriptions}`, authenticated as the service account. A topic with a filter is `events/*?options=<encodeURIComponent(JSON.stringify({query:{filter}}))>`. The token is refreshed before it expires; a 401 re-authenticates once. A reset or close at any point (PocketBase's idle and forced closes, a proxy cutting a quiet stream) is routine: reconnect with backoff and catch up, with no attention line. Attention is written only when connecting keeps failing for 15 minutes, or authentication or the subscription is refused permanently. The client sends no keepalive (PocketBase reads none); a source URL through a proxy that cuts quiet streams works but reconnects more often, so a direct internal URL is preferred (operations).
- **Topics.** Events `create`s, filtered to the union of names used by an active sequence's trigger, an active or paused sequence's `exit_on`, and the `grant_lists` rules; split into several topics past PocketBase's 2,500-character filter limit; re-subscribed when a sequence or rule changes. Users, filtered by the leaving filter. Only `create` acts for events.
- **Unsubscribed names never create a subscriber.** An event named by no trigger, exit or grant is never received. Conditions still query every name (section 6).
- **Start-up and reconnect.** Subscribe first and buffer live records; catch up with `created >= marker − 15 s`, the same filter, sorted `created,id`, in keyset pages, skipping IDs in the dedupe table; drain the buffer (dedupe again); continue live. The marker advances only after a batch is committed. Users leaving are caught up the same way on `updated`. The dedupe table is pruned relative to the marker, never by wall clock. A new source's marker starts at "now", never at epoch.
- **One record at a time.** All source reads for a record (the trigger condition, the recipient lookup) happen before one SQLite write transaction that applies the subscriber upsert, `grant_lists`, the existing exit-then-trigger path (with the record's `occurredAt`) and the dedupe entry.
- **Retry queue.** A transient failure puts the record in a persistent per-record retry queue (attempts, next attempt, backoff on the injected clock); a terminal failure is shown in attention. A queued record never blocks the stream.
- **Address conflict.** Another subscriber of the project may hold the incoming address. Check that holder's `external_id` in the recipients view:
  - the holder now has another address: update the holder's address;
  - the holder is gone or has no `external_id`: end its enrollments; then if the incoming user has no subscriber, re-point the holder row to them (blocklist, unsubscribes and cap history stay); otherwise, in one transaction, carry the holder's blocklist (through the normal blocklist path) and unsubscribes onto the incoming row, delete the holder and set the address. Grants still refuse over any carried unsubscribe;
  - two live users in the view with one address: a terminal conflict in attention.

## 5. Consent

`grant_lists` rules on the source are applied before exit-then-trigger, so a zero-wait marketing step sees the consent. A grant is refused when the recipient's opt-out field is set, or iglo.email has the address unsubscribed from that list, suppressed (D125/D128) or blocklisted. A grant never overrides an unsubscribe.

## 6. Sequences on a source

- A sequence chooses its source: `"source": "events"` (default, pushed events) or `"source": "external"` (the project's source). A project without a configured source refuses `external`.
- **Trigger.** `trigger.event` and the `data.*` equality form of `trigger.where` match the record. New `trigger.condition` (external sequences only): a history condition evaluated against the source when the trigger arrives, with `since` durations counted back from the trigger's `occurredAt` and counts including the trigger (for example "2+ `order_paid` with `data.product = prepaid` within `P180D`"). It is what a `reentry: never` sequence needs, where a step condition would enroll, exit and block for ever. The condition form of `trigger.where` (evaluated inside the event transaction for pushed events) is refused on external sequences; `trigger.condition` is refused on pushed ones (D169: one way each).
- **Trigger reference.** `since: trigger`, reschedule and windows use `trigger_occurred_at` locally. `trigger.data`, step preview and the timeline fetch the record when needed; a 404 ends the enrollment with `trigger_missing` (the subscriber stays). Preview, test sends and manual or test enrollments accept a string `trigger_external_id`; `latest()` supplies a default.
- **Conditions and aggregates read the source.** Same condition language. `{event, since, where, count}` and step aggregates (`count`, `sum`, `distinct`) compile to PocketBase filters on the events collection: window strictly `occurredAt > since`; dates as PocketBase stores them (`YYYY-MM-DD HH:mm:ss.sssZ`); values escaped as filter literals (there are no bound parameters over HTTP).
  - Exists: `perPage=1&skipTotal=1`. Count thresholds read up to the comparand + 1.
  - Aggregates: keyset pagination on `(occurredAt, id)`, `skipTotal=1&fields=id,occurredAt,data`, capped at `AGGREGATE_LIMIT` on the window before `where`, as today.
  - PocketBase compares JSON loosely (section 9), so `where` is re-checked strictly, with the condition language's type rules, on fetched rows; where that matters for a count, pages continue until enough strict matches.
  - New condition kind `{ "recipient": "<field>", "op", "value" }` reads a recipients-view field, with `attr`'s operators and type rules.
  - `sql` predicates are refused on external sequences.
  - Evaluation is async.
- **Failures.** An error or timeout never counts as false or zero. Transient: retry with the scheduler's existing backoff for at most 72 hours (`error_since`). Permanent (400/403: a renamed field, a broken rule): fail fast. Terminal: the enrollment exits with `exit_reason = 'source_error'`, shown in the sequence UI and attention. A step never runs past an unevaluated condition.

## 7. Sending and leaving

- **Fresh recipient at send time** (address and name), for sequence steps and for campaigns to source-linked subscribers. An address change goes through section 4's conflict and opt-out handling. The campaign runner fetches per batch before render and eligibility; on a transient error it pauses and rewinds the batch instead of failing deliveries (marketing at-most-once: a rewound message was never handed to the emailer).
- **Leaving.** A user absent from the recipients view is leaving: end the enrollments and remove the subscriber, at send time and in real time on a matching users update. PocketBase does not broadcast a hard delete of a user that does not match the subscription filter, so send time is the backstop.
- **Names.** A generic Liquid filter `first_name`: the first word if it starts with a letter, contains no `@` and is at most 24 characters, else empty (`{{ subscriber.name | first_name | default: "there" }}`). A source-linked subscriber's name may be empty; there is no name-from-email fallback.

## 8. Tests

Against the real PocketBase 0.40.5 binary (official release, checksum-pinned, downloaded into an owned test-excluded cache such as `node_modules/.cache/`, and downloaded in CI), never a mock of its protocol: realtime and reconnect catch-up, the lookback and dedupe, the retry queue, conflict resolution and leaving, condition and aggregate compilation including the loose-JSON re-check, `trigger.condition`, `source_error`, and `first_name`. The binary is a test tool only; the shipped executable gains no dependency.

## 9. PocketBase facts (0.40.5, measured 2026-11-25)

- **Realtime.** Each message is sent from its own goroutine on an unbuffered channel, so a live connection blocks rather than drops; loss happens only around a disconnect. Records created in a transaction are broadcast after commit. Order is not guaranteed. Connections close after 5 idle minutes and after 30 minutes regardless, so reconnect and catch-up are routine. A subscription filter applies to every action, so a hard delete of a user that does not match is not broadcast.
- **Filters.** `data.n > 5` also matches the string `"10"`; `data.b = true` matches `1` and the reverse; `= 10` and `= "10"` are exact; a missing key matches `= null` but not `= ""`; `!=` includes missing keys.
- **Paging.** `perPage` is silently capped at 1000; `skipTotal=1` returns `totalItems: -1`.
- **Errors.** A duplicate unique value is a 400 with `data.<field>.code = "validation_not_unique"`.
- **Auth collections** hide `email` from non-owners unless `emailVisibility` is on.
