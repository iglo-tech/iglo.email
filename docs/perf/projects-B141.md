# B141: dispatcher measurements

Required by `AGENTS.md` for sending and scheduling changes and by [14-projects](../design/14-projects.md) section 16. Decision: [D155](../design/09-decisions.md#d155-the-dispatcher-b141-lead-2026-11-25).

## Setup

- Host: native Linux x86-64, 12 cores (D147).
- **Before:** `origin/main` at `e6e3d0c` (B142 merged), built from a `git archive` under `node_modules/.cache/b141-control`, executable SHA-256 `ba8ac19560e97074…`.
- **After:** this branch's head, executable SHA-256 `09732f4d9df8307a…` (series 2). Series 1 used an earlier branch build that woke the marketing loop on every enqueue and checked the hold twice per push; both were fixed after it, and series 2 measures the final code.
- Both compiled executables, a loopback SMTP sink, HTTP only. Order alternates per run (odd runs before first, even runs after first). Medians of 5 runs.
- **Host load:** other workers (B142, B143a, B144a, B145a, B147) ran tests, e2e and their own measurements on this host during both series; it was not possible to measure while no other task ran. The 1-minute load average is recorded before every run in the raw files (series 1: 3.0 to 11.0; series 2: 4.0 to 8.1). Alternation exposes both sides to the same load, and the spread inside each side is wider than the difference between sides for the outbox.
- Raw lines: [`projects-B141-series1.jsonl`](projects-B141-series1.jsonl) (first throughput series, then the mixed-load series), [`projects-B141-series2.jsonl`](projects-B141-series2.jsonl) (final throughput series and the `MAX_CLAIM` comparison).

## Throughput, one project (`test/perf/projects/throughput.ts`)

`messaging.max_send_rate` 0 (unpaced), 2,000 async `POST /api/tx`, then one campaign to 5,000 subscribers; time to the sink's last message. Before, the campaign pacing keys are raised out of the way (concurrency 10, rate 100,000); after, they do not exist.

| Series 2 (final head) | Before | After | Change |
|---|---|---|---|
| Outbox, msg/s (runs) | 548.0, 491.7, 530.7, 651.4, 676.5 | 516.3, 539.0, 564.0, 621.3, 652.9 | |
| Outbox, median msg/s | **548.0** | **564.0** | +2.9% |
| Campaign, msg/s (runs) | 1443.9, 1296.6, 1316.5, 1537.3, 1629.0 | 1551.3, 1464.1, 1743.2, 1777.2, 1866.5 | |
| Campaign, median msg/s | **1443.9** | **1743.2** | +20.7% |

No regression above 5%; the campaign is 35 times the 50 msg/s target. The campaign gain is the batch: every granted recipient is pushed at once instead of by ten workers that each await their message.

Series 1 (earlier branch build) had the outbox at 405.0 before and 347.5 after (−14%), campaign 938.9 and 1121.8, under load 7 to 11. The outbox drop came from the marketing loop's look (a write transaction) on every transactional enqueue and a second hold query per push; the enqueue wake now names the kinds it queued, and the duplicate check is gone (D155). Series 2 is the gate.

## `MAX_CLAIM` (campaign batch size)

Same script, 200 tx and 5,000 recipients, three builds differing only in `MAX_CLAIM`, run in the order 50, 100, 200, three rounds:

| `MAX_CLAIM` | Campaign msg/s (runs) | Median |
|---|---|---|
| 50 | 1762.2, 1625.6, 1660.2 | 1660.2 |
| **100** | 1776.5, 1796.4, 1742.2 | **1776.5** |
| 200 | 1820.3, 1753.2, 1674.0 | 1753.2 |

100 is kept: 50 is about 7% slower, 200 is no faster and holds twice the rendered messages per batch. At any positive rate the grant is the smaller bound anyway (`2 × rate` slots: 28 at the default 14).

## Mixed load, three projects at rate 14 (`test/perf/projects/mixed.ts`)

Project `a` runs a campaign to 2,000 readers; project `b` either queues 600 async marketing sends (`marketing`) or runs a campaign of its own to 600 readers (`campaign`); the primary makes a synchronous transactional call every 500 ms. Window 30 s once all three are under way. Latency is from the call to the sink's receipt of that message (start plus the loopback SMTP hand-off). Series 1, build of series 1 (the scheduling code is the same as the final head's).

| Mode | Side | Tx p50 ms | Tx p99 ms | Receipts/s | Share main / a / b |
|---|---|---|---|---|---|
| marketing | before | 4 | 10 | 29.6 | 60 / 414 / 414 |
| marketing | after | 39 | 75 | 13.9 | 60 / 0 / 356 |
| campaign | before | 3 | 31 | 29.7 | 60 / 415 / 415 |
| campaign | after | 40 | 75 | 13.9 | 60 / 179 / 177 |

- **Before**, each project had its own limiter at 14 msg/s, so three projects sent 29.7 msg/s together: twice the instance's rate, the budget invariant 7 forbids. Transactional mail was fast only because its project's limiter was otherwise idle.
- **After**, the instance sends 13.9 msg/s in all. A transactional message waits for the next start, half an interval (36 ms) on average, at most one interval (71 ms) plus SMTP: p99 75 ms, far inside the horizon plus one slot (2,071 ms, invariant 4). Marketing goes before campaign work, so project `a`'s campaign gets nothing while `b`'s marketing backlog lasts (section 7: campaigns run at whatever capacity is left). Two campaigns share the rest evenly (179 and 177 of 416).
- p99 per run, after: 75, 75, 73, 76, 80 (marketing) and 75, 76, 75, 78, 72 (campaign).
