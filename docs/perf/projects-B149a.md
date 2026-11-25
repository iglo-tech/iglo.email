# B149a: the Projects page's "sent in 24 h" count

Required by `AGENTS.md` for storage changes and by the B149a brief (item 5, B143a r1): the Projects
page and `GET /api/instance/projects` count each project's sends delivered in the last 24 hours on
every load, synchronously on the shared event loop. B143a's statement
(`status = 'sent' AND sent_at >= ?`) had no index on `sent_at`, so it read every sent row in the
project's history. B149a counts a sent row from its start instead,
`status = 'sent' AND coalesce(attempted_at, sent_at) >= ?`, the expression of B143b's
`idx_sends_started` (migration 35, D162), and the count becomes a covering range search of the
window's index entries. No schema change. Decision:
[D164](../design/09-decisions.md#d164-project-lifecycle-and-instance-pages-hardening-b149a-lead-2026-11-25).
Local observations on one host, not CI thresholds.

## Setup

- Host: `agents-workhorse-01`, Ubuntu 26.04, Linux 7.0.0-44 x86-64, 12 threads, 30 GB RAM, native
  (D147). Bun 1.4.5. Four other B149 workers were on the host; the 1-minute load average at each
  run's start is in the table.
- `bun test/projects/measure-activity.ts [rows] [runs]` opens an instance (every project migration
  applied), seeds `rows` sends over the last 30 days (90% `sent`, about 1 in 30 of them in the
  window, 1 in 50 without `attempted_at`; the rest `queued` or `failed`), and times 21 reads of each
  statement after one warm-up read. **Before** is B143a's statement, copied into the script;
  **after** is `createProjectActivity(db).read(since).sent`, the function the page calls. Both run
  on the same seeded database in the same process.
- Data directory: `/tmp` (tmpfs) and `$HOME/.cache` (xfs on NVMe, on disk), as named per row.

## Plan

| Side | `EXPLAIN QUERY PLAN` |
|---|---|
| Before | `SEARCH sends USING INDEX idx_sends_started (status=?)`: every sent row read from the table |
| After | `SEARCH sends USING COVERING INDEX idx_sends_started (status=? AND <expr>>?)` |

(Before migration 35 the same statement searched `idx_sends_status_id (status=?)`, the plan the
B143a review named: also every sent row.)

## Results

| rows | data directory | Before median / worst ms | After median / worst ms | count (both) | load |
|---:|---|---|---|---:|---|
| 100,000 | tmpfs | 129.4 / 211.1 | 0.23 / 0.27 | 2,999 | 2.1 |
| 1,000,000 | tmpfs | 1,821.5 / 2,650.8 | 2.81 / 2.86 | 29,999 | 3.5 |
| 1,000,000 | disk | 2,506.3 / 3,365.0 | 3.39 / 5.31 | 29,999 | 8.7 |

- At a million sends, one Projects page load spent about two seconds per project on this count
  alone, blocking every project's requests meanwhile; it is now a few milliseconds, proportional to
  the window's sends rather than the history.
- The counts are equal here. They can differ only for a row started before the window and delivered
  inside it (a push in SMTP flight across the boundary, at most the push deadline), which now counts
  in the earlier day, as the capacity forecast already counts it against SES's quota.
- The campaign deliveries part is unchanged (it already reads only campaigns updated in the window,
  by primary key).
