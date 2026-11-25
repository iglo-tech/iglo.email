# B143b: the forecast's start-time index

Required by `AGENTS.md` for storage changes and by the B143b brief: migration 35 adds
`idx_sends_started ON sends(status, coalesce(attempted_at, sent_at))` so the capacity forecast's
count of each project's sends (`sends.starts`) stops scanning every started row. Measured before
and after on the B145a forecast harness, and the index's write cost on the outbox. Decision:
[D162](../design/09-decisions.md#d162-instance-sending-page-and-the-forecasts-start-time-index-b143b-lead-2026-11-25).
Local observations on one host, not CI thresholds.

## Setup

- Host: `agents-workhorse-01`, Ubuntu 26.04, Linux 7.0.0-44 x86-64, 12 threads, 30 GB RAM, native
  (D147). Bun 1.4.5. A B141a worker was on the host; the 1-minute load average before each run was
  0.4 to 2.6 (below).
- **Before:** `main` at `b23461a` (B145b merged), unpacked with `git archive` under
  `node_modules/.cache/b143b-control`, compiled executable SHA-256 `acef348a93bb0d75…`.
- **After:** this branch, compiled executable SHA-256 `8e3db927ca8ffc44…`. The only storage change
  is the index; `sends.starts` is the same statement.
- Each side runs its own sources and its own executable; order alternates per run.

## Plan

`bun test/perf/projects/sends-started.ts [rows] [writes]` opens an instance (every project migration
applied), seeds rows with every status and every mix of NULL `attempted_at` and `sent_at`, and fails
unless the plan is a search of the index alone and the counts equal a forced table scan
(`NOT INDEXED`) for five `day`/`from` pairs.

| Side | `EXPLAIN QUERY PLAN` |
|---|---|
| Before | `SEARCH sends USING INDEX idx_sends_due_kind (status=?)`: every started row read from the table |
| After | `SEARCH sends USING COVERING INDEX idx_sends_started (status=? AND <expr>>?)` |

The same plan without `ANALYZE`. An index without the `coalesce` (`(status, attempted_at)`) gives
`SEARCH sends USING INDEX idx_sends_started (status=?)` and the script fails (the brief's mutant).
All five counts equal the scan at 100,000 rows (for example `day 24 h, from 12 h: 22,283 / 11,198`).

## Forecast (`test/perf/projects/capacity.ts`, B145a)

21 `GET /api/sending/capacity?count=10000` per run through HTTP with an API user; one project,
`sends` rows and one running campaign's deliveries spread evenly over the last 48 hours (half in
the window). Median and worst per run; the first request's on-demand SES read is in the worst.

| sends | deliveries | Before median ms (3 runs) | After median ms (3 runs) | Before worst | After worst | Load |
|---:|---:|---|---|---|---|---|
| 100,000 | 100,000 | 29.0, 21.4, 27.3 | 12.0, 11.9, 11.8 | 42.2, 25.4, 45.0 | 15.9, 15.4, 16.4 | 0.4–0.5 |
| 1,000,000 | 1,000,000 | 214.6, 227.3, 219.6 | 117.4, 120.5, 117.7 | 223.1, 255.7, 247.6 | 121.7, 123.9, 122.4 | 0.6–2.0 |
| 1,000,000 | 1 | 138.0 | 41.1 | 151.6 | 43.9 | 2.6 |
| 1 | 1,000,000 | 79.1 | 79.2 | 81.9 | 82.0 | 2.6 |

- The `sends` part drops from about 138 ms to 41 ms at a million rows (half in the window): the
  count now reads 500,000 index entries instead of a million table rows, and the window's count
  comes from the same entries.
- The deliveries part is unchanged (79 ms) and is now the larger one. D162 leaves it unindexed:
  only campaigns running or touched in the last 24 hours are read, and a real campaign's deliveries
  mostly fall in the window, so a time index would skip little while costing every campaign claim
  and outcome an index write.
- The demand differs by a few between sides and runs because the harness seeds against the real
  clock and the window moves between seeding and the requests; the plan script checks that the
  counts are identical.

## Write cost

### Outbox throughput (`test/perf/projects/throughput.ts`, B141)

`messaging.max_send_rate` 0, 2,000 async `POST /api/tx` (an insert, a claim and a status update per
row), then one campaign to 5,000 subscribers; compiled executables, a loopback sink.

| Measure | Before (runs) | After (runs) | Before median | After median | Change |
|---|---|---|---|---|---|
| Outbox msg/s | 118.1, 122.0, 117.9, 119.7, 118.8 | 118.7, 118.3, 117.0, 120.1, 119.3 | 118.8 | 118.7 | −0.1% |
| Campaign msg/s | 1504.2, 1519.8, 1506.4, 1433.8, 1406.5 | 1432.3, 1404.0, 1398.4, 1435.6, 1489.2 | 1504.2 | 1432.3 | −4.8% |

Load 1.8 to 2.2. The campaign path writes `campaign_deliveries`, not `sends`, so the index is not on
it; its spread (1,398 to 1,520 across both sides) is the run-to-run noise of this series. The
outbox, which writes `sends` three times per message, is unchanged.

The outbox ran at about 119 msg/s on both sides, against 520–560 msg/s in the B141 and B145b
series of the same script. It is the same on `main`, so it is not this change; it is reported to
the lead.

### Raw SQL (`bun test/perf/projects/sends-started.ts 100000 writes`)

On the seeded 100,000-row table, 20,000 rows inserted 10 per transaction, claimed 10 per
transaction (`queued` → `sending` with `attempted_at`) and finished one by one (`sent` with
`sent_at`); rounds alternate with and without the index. Rows per second:

| Index | Insert | Claim | Finish |
|---|---|---|---|
| with | 23,222, 22,959, 23,741 | 54,953, 57,129, 56,469 | 20,256, 20,829, 20,654 |
| without | 26,553, 26,659, 25,975 | 66,303, 66,246, 62,657 | 24,389, 24,318, 24,065 |

About 5 µs more per insert, 3 µs per claim and 8 µs per finish: 12–18% of the bare statement,
three orders of magnitude below the outbox's per-message time, which is why the end-to-end
throughput does not move.
