# B7: load and memory

Host: the shared VM (16 GiB, other projects running), Bun 1.4.4, compiled build where noted. Not
CI thresholds. "Before" is `origin/main` at 2b6c324 run from an archive under
`node_modules/.cache/b7-before` (same scripts); "after" is this change.

## 1. Parent memory for a 1,000,000-ID selection (`test/subscribers/measure-stage.ts`)

1,000,000 subscribers; the parent is the test process holding the fixture server (the raw
query child is separate). RSS sampled every 5 ms while the body is read to the end.

| Request | Response | RSS before → peak, before B7 (MiB) | After B7 (MiB) |
|---|---|---|---|
| `GET /api/subscribers?per_page=all&query=…` | 238 MiB | 58.3 → 162.1 | 59.0 → 72.2 |
| `GET /api/subscribers/export?query=…` | 138 MiB | 64.9 → 102.7 | 64.0 → 91.1 |
| `PUT /api/subscribers/query/blocklist` (raw) | 14 B | 68.9 → 152.2 | 68.4 → 78.7 |
| `GET /api/subscribers?per_page=all` (built-in) | 238 MiB | 72.6 → 72.6 (*) | 68.3 → 68.3 (*) |

(*) The synchronous page loop starves the sampler; the peak is not captured. The built-in page
held its IDs before B7 too (`column()`); it now stages them like the raw one.

Growth fell from about 100 MiB (raw page and bulk) to 5-13 MiB. The remainder is a batch of rows
and the response stream. Responses and statuses were identical (same byte counts, 200). Seeding
took 83-84 s either way.

## 2. WAL under continuous polling (`bun test/analytics/measure-budget.ts wal 60`)

A writer commits 50 rows a second with `synchronous = FULL` and autocheckpoint on. Three pollers,
started 0, 0.75 and 1.5 s apart, loop on two helper slots; each read holds its snapshot for 1.5 s
(`test/analytics/hold-child.ts`), so snapshots overlap continuously.

| Run, 60 s | Reads | WAL size every 5 s (MiB) |
|---|---|---|
| Before: no forced gap | 80 | 6.4, 12.8, 19, 25.5, 31.8, 38.1, 44.5, 50.8, 57.2, 63.5, 69.8, **76.2** |
| After: gap after 15 s, then checkpoint | 79 | 6.4, 12.8, 19, **20.3**, 20.3, 20.3, … 20.3 |

Before, the WAL grows at the write rate for as long as the polling lasts. After, it stops at the
size reached when the first gap came (15 s plus the reads still running) and is then reused. The
reader went from 80 to 79 reads: each forced gap costs one read's duration per 15 s. A first
attempt that only paused admission (no checkpoint) did not help: the pause was too short for the
automatic checkpoint to land, so the reader now runs `PRAGMA wal_checkpoint(PASSIVE)` in the gap.
Short reads (46 ms) never kept the WAL from resetting, with or without the gap (3.9 MiB both).

## 3. Many slow analytics downloads (`bun test/analytics/measure-budget.ts egress`)

40 clients each request a 19.1 MiB analytics body (near the 32 MiB cap) and never read; the
helper is a stand-in that prints the bytes. Two helpers, 32 queued, as in production.

| Run | Served | Refused | Parent RSS before → peak (MiB) |
|---|---|---|---|
| Before: no budget | 34 | 6 (queue full, 429) | 33.6 → 930.6 |
| After: 64 MiB egress budget | 6 | 34 (egress 503 or queue-full 429) | 43.0 → 239.6 |

Memory now follows the budget (64 MiB, plus one maximum response per running helper and the
server's own socket copies) instead of the number of clients. The 503 comes before the helper
starts, or when a queued read reaches the front, so no body is cut short.

## 4. Event latency under the M6.1 mixed load

`M61_WINDOW_MS=120000 bun test/perf/m61/mixed.ts mixed`, compiled build, 8 × 10 campaign workers,
2 sequences, tx trickle; results in `B7-results.jsonl`. The only variable is how long the event
group-commit waits before it flushes (`setImmediate`, today; 3 ms for the experiment). Commits are
FULL in both, and every event still resolves after its own commit, so D22 is untouched.

| Event flush | Events in window | p50 / p95 / p99 / max (ms) | Campaign rate | tx accept p95 (ms) |
|---|---|---|---|---|
| `setImmediate` (current) | 11,996 / 12,000 | 32.4 / 96.5 / 177 / 373 | 72.7/s | 68 |
| after 3 ms | 11,993 / 12,000 | 31.4 / 118.6 / 503 / 901 | 74.6/s | 81 |

The host was busier than for M6.1 (other projects running; 51 ms p95 there), so only the pair is
comparable, and one pair is one sample. A longer window did not help and made the tail worse.
Reasoning: at 100 events/s a 3 ms window rarely holds more than one event, so it saves almost no
commits, while the thread's blocking time comes from the other loops' commits (outbox claim,
`skip_reason` and outcome, scheduler, campaign progress), which an event write cannot batch with
without moving those writes into one shared transaction. That crosses the messaging, scheduler
and campaign modules, which B7 does not own, and a coalescing point that holds their commits back
trades their latency (and for sends, at-most-once ordering) for the events'. No change was kept.
The backlog line stays, with this evidence.
