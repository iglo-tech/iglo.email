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
- The benchmark is a scratch script outside the repository. Its statements are the ones listed here,
  copied from `src/messaging/sends.ts` (the list, and `capFreeAt`) and from the dashboard's request.

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
updates the same number of indexes. A fresh 1,000,000-send insert took 8,898 ms on schema 27 and
8,927 ms on schema 28 (one run each, within noise). The migration itself took 9,481 ms on the
1,000,000-send database, including the runner's pre-migration `VACUUM INTO` snapshot.

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

## Decision

Migration 0028 is accepted: the status-filtered send log and the dashboard drop from about half a
second to microseconds, the count stays at 25 ms, and writes cost the same. Decision D135's "no
measurement" was wrong; this note is the measurement it needed.
