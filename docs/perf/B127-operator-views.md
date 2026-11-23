# B127 operator views: reads on sends and events

Round 1 review (PR #192): the dashboard read the newest sent row on every load, which sorted every
sent row. Migration 0028 replaces the status index so the filter and the newest-first order are both
served by the index. Every new read that B127 adds on `sends` or `events` is listed below with its
plan and its time at a million sends.

## Setup

- `bun` 1.4.5 on macOS arm64, one file database (`openDatabase`, WAL), the production schema.
- 1,000,000 sends: 950,000 `sent` (50,000 of them still hold a payload, the rest were compacted, as
  retention leaves them) and 50,000 `skipped`. Half are `tx`, half `sequence`; subscriber IDs cycle
  through 5,000 subscribers, so each has 200 sends.
- Each query is run seven times after its plan is read; the median is reported, with the min and max.
- The read benchmark is a scratch script outside the repository. Its statements are the ones listed here,
  copied from `src/messaging/sends.ts` (the list, and `capFreeAt`) and from the dashboard's request.
- The write and analytics measurement is `test/sends/measure-status-index.ts`, run as
  `bun test/sends/measure-status-index.ts 1000000 20000 3`: one database migrated to schema 27 and one to
  schema 28, each filled with the same million sends (5,000 subscribers), then three repetitions of the
  send path's write work, and the two analytics reads through the production store.

## Before and after migration 0028

| Read | Before (schema 27) | After (schema 28) |
|---|---|---|
| Dashboard count, `status = 'sent'` (`count(*)`) | 25.2 ms, `COVERING INDEX idx_sends_due (status=?)` | 24.6 ms, `COVERING INDEX idx_sends_status_id (status=?)` |
| Dashboard page, `status = 'sent'`, one row, newest first | **490.5 ms**, `INDEX idx_sends_outbox (status=?)` + `USE TEMP B-TREE FOR ORDER BY` | **0.02 ms**, `INDEX idx_sends_status_id (status=?)` |
| Send log page, `status = 'sent'`, 100 rows, newest first | **970.4 ms**, same temp sort | **0.12 ms**, `INDEX idx_sends_status_id (status=?)` |

The dashboard's count is the one read that still costs a scan: it counts 950,000 index entries, about
25 ms, and it is kept because the dashboard shows the number. It runs once per dashboard load, not on
any send path.

The send path's plans on the same data, before and after: the claim (`min(id)` of new and due queued
rows) and the next-due read stay on `idx_sends_due`, and compaction stays on `idx_sends_compactable`.
Only the lease expiry (`status = 'sending'`) changes index, from `idx_sends_due` to `idx_sends_status_id`,
and it reads the same rows.

Write cost: migration 0028 drops one status index and creates one, so each insert and status change
updates the same number of indexes. The migration itself took 9,481 ms on the 1,000,000-send database,
including the runner's pre-migration `VACUUM INTO` snapshot.

**Write path at a million sends (B127 r2).** Each repetition inserts 20,000 queued sends in one
transaction, then claims each one (`queued` to `sending`) and settles it (`sending` to `sent`), one
transaction per claim and per settle, with `synchronous = FULL`. Medians of three repetitions, in
milliseconds, from three invocations of the script on the same macOS arm64 host (other agents' containers
were running on it, so the spread between invocations is the noise):

| Phase | Run A, schema 27 | Run A, schema 28 | Run B, schema 27 | Run B, schema 28 | Run C, schema 27 | Run C, schema 28 |
|---|---|---|---|---|---|---|
| Insert 20,000 | 673 | 573 | 577 | 578 | 945 | 757 |
| Claim 20,000 | 3,506 | 3,324 | 3,547 | 3,327 | 4,231 | 3,789 |
| Settle 20,000 | 4,597 | 4,553 | 4,504 | 4,136 | 5,092 | 5,074 |

No phase is slower on schema 28 beyond the spread between invocations. A status change updates the same
two status-prefixed indexes on both schemas (`idx_sends_due` and the status index, which migration 0028
swaps), so the index count per write is unchanged.

**Migration 0029 (B127 r2, `enrollments.exit_condition`).** The migration adds one nullable column with
no default, which SQLite does not rewrite rows for: `ALTER TABLE enrollments ADD COLUMN` on one million
enrollment rows took 14 ms (run C). A condition exit writes its text in the statement that already ends
the enrollment, so the scheduler's write does not change except for that one column.

**Analytics reads that moved to the new index.** `sends-by-template` and `sends-by-step` filter on
`status = 'sent'` and `sent_at` in a range. On schema 27 their `SEARCH sends` used `idx_sends_due (status=?)`;
on schema 28 it uses `idx_sends_status_id (status=?)`. The rest of each plan is unchanged: the temp B-tree
for `GROUP BY`, the views and clicks joins, and the bloom filters. Medians of seven runs, in milliseconds,
with the min and max, from the same three invocations:

| Read | Run A, 27 | Run A, 28 | Run B, 27 | Run B, 28 | Run C, 27 | Run C, 28 |
|---|---|---|---|---|---|---|
| `sends-by-template` | 302 (300–305) | 311 (307–327) | 320 (316–331) | 308 (305–310) | 402 (381–436) | 425 (392–470) |
| `sends-by-step` | 117 (114–122) | 119 (118–123) | 124 (123–127) | 118 (116–124) | 162 (153–173) | 169 (152–180) |

The index is the change; these times are within the spread of the host, so they show no speed-up or
slow-down beyond it.

## Every new read on sends and events

Times are the schema-28 medians above, or the query's plan where no timing is listed.

| Read | Where | Plan and cost at a million sends |
|---|---|---|
| Send log page, unfiltered, 100 rows | `GET /api/sends` | `SCAN sends` in rowid order, stops at `LIMIT`: 0.07 ms |
| Send log count, unfiltered | `GET /api/sends` | `COVERING INDEX sqlite_autoindex_sends_3`: 4.5 ms |
| Send log page, `kind = 'marketing'`, 20 rows | `GET /api/sends?kind=` | `SCAN sends`, stops at `LIMIT`: 0.03 ms (a rare value scans further; the filters are unchanged) |
| Send log page, `source = 'tx'`, 20 rows | `GET /api/sends?source=` | `SCAN sends`: 0.03 ms (same caveat) |
| Send log page, `status = 'sent'`, 100 rows | `GET /api/sends?status=` | 0.12 ms (see above) |
| Subscriber's sends page, 20 rows | `GET /api/subscribers/:id/sends` | `INDEX idx_sends_cap (subscriber_id=?)` + temp sort of one subscriber's rows: 0.20 ms |
| Subscriber's sends count | the subscriber page's count, `per_page=1` | `COVERING INDEX idx_sends_cap (subscriber_id=?)`: 0.01 ms |
| Latest marketing send, per status (cap) | timeline hold, scheduler defer | `COVERING INDEX idx_sends_cap`: 0.00 ms per status |
| Subject per returned row | every send projection | `json_extract` on at most one page of payloads: no index, at most 100 rows |

The send projection's subject, step labels, and (added with the template column) template names are
read for the rows a page returns only. A page is at most 100 rows, and each label is a primary-key or
`json_each` lookup.

## Events, names and holds

These read the sequence and template tables and the enrollments, not `sends`. Plans are from the
migrated database (schema 28, a million sends, no enrollments in it); the enrollment and event
tables hold what a subscriber has, so the plans are what bounds them. No timing is listed: each read
takes at most one page's worth of IDs.

| Read | Where | Plan | Bound |
|---|---|---|---|
| Template names of a page's sends | send log, subscriber sends tab (`templateNames`) | `SEARCH templates USING INTEGER PRIMARY KEY`, `json_each` for the IDs | at most one page of distinct template IDs (100 rows) |
| Sequence names of a page's refused starts | events list (`sequence-names`) | `SEARCH sequences USING INTEGER PRIMARY KEY` | the refused starts of one page of events |
| Step labels of a page's sends | send log (`step-labels`, unchanged) | `SEARCH st` and `SEARCH s` by rowid | at most one page of distinct steps |
| Enrollments an event started or exited | events list (`subscriber-event-links`) | `SEARCH e USING INDEX idx_enrollments_subscriber_sequence (subscriber_id=?)`, then the page's IDs and `{name, at}` pairs | one subscriber's enrollments; the page's events bound the IDs |
| Events of a subscriber, one page | events list (unchanged `events-page`) | `SEARCH events USING INDEX sqlite_autoindex_events_1 (subscriber_id=?)` and a temp sort of that subscriber's events | one subscriber's events |
| Cap hold of each enrollment on a page | subscriber's enrollments list (`listedWithHolds`) | the cap's latest-send read: `COVERING INDEX idx_sends_cap`, 0.00 ms per status (see above) | one read per row with an active marketing deferred wait; other rows read nothing |

The events list adds one enrollment query and one name lookup per page; a subscriber's enrollments
are read once, through the index that already serves the subscriber's enrollment tab.

## Decision

Migration 0028 is accepted: the status-filtered send log and the dashboard drop from about half a
second to microseconds, the count stays at 25 ms, and writes cost the same (three repetitions, three
invocations, above). Decision D135's "no measurement" was wrong; this note is the measurement it needed.
Migration 0029 is accepted on the 14 ms column probe: it rewrites no row, and the send path does not
change.
