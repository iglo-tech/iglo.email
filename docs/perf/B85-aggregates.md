# B85: event aggregates in sequence steps

Measured on the owner's macOS workstation (Apple silicon, Bun 1.4.4), not the Linux VPS, with
temporary SQLite data directories and a loopback SMTP sink. Numbers are single-host medians and
show the order of magnitude, not a CI threshold. Decision: [D100](../design/09-decisions.md#d100-sequence-steps-read-event-aggregates-lead-2026-11-16).

## 1. Scheduler throughput: steps without aggregates must not regress

Harness: `test/scheduler/measure.ts` (the M5.4 harness, unchanged), 10,000 due enrollments and a
2,000-send outbox load, three repetitions each, medians of per-second throughput.

"Before" is `origin/main` at `7386b5d`, archived with `git archive` under
`node_modules/.cache/` (excluded from test discovery) and run with the same script. "After" is
this branch.

| Path | Before (per s) | After (per s) | Change |
|---|---:|---:|---:|
| Transactional steps, 10,000 enrollments | 2,912 | 2,950 | +1.3 % |
| Marketing steps, 10,000 enrollments | 2,530 | 2,608 | +3.1 % |
| Send load alone (2,000 sends) | 1,949 | 2,033 | +4.3 % |
| Send load while the scheduler runs | 689 | 736 | +6.8 % |

Individual runs: transactional before 2,983 / 2,912 / 2,900, after 2,897 / 2,950 / 3,018;
marketing before 2,765 / 2,436 / 2,530, after 2,581 / 2,643 / 2,608. Run-to-run spread is about
±5 %, so the differences are within noise: no regression.

What the branch adds to a decision without aggregates: one `NULL` check, one more field in the
template data (`"aggregates":{}`), one more compared field in the decided-on check, and one more
column in the scheduler's context read.
## 2. One decision: aggregates over one subscriber's events, bounded

Harness: `test/scheduler/measure-aggregates.ts` (`bun test/scheduler/measure-aggregates.ts 5`).
One subscriber has 1,000, 10,000 or 100,000 `download_finished` events inside the 30 days before
the decision, and another subscriber has as many events with the same name, so each read is
bounded by the subscriber and name index and not by the table. Figures are medians of runs after
one warm-up, through `createEventAggregates`, the reader the event store exposes to the scheduler.
At 1,000 and 10,000 events the harness first checks the totals against values computed from the
data. At 100,000 it checks that every `download_finished` aggregate and each of the ten `where`
misses is refused with no total, and that `count_actions` (exactly 10,000 events) is complete.

The bound (D100): each aggregate reads at most 10,000 events of its name in its window, newest
first, and `where` is applied to those rows only. The limit counts the window, not the matching
rows, so a `where` that matches little does not lower the cost, and a window with more than
10,000 events is refused with no total.

Host: the macOS workstation was shared with other busy processes during these runs (load average
9 to 36), so single timings moved by up to 2×. "Before" is `0351d17` (the bound on matching rows,
so reads of `where` were not bounded) and "after" is this branch. Each build ran six times,
interleaved, with five repetitions per run. Medians of the six runs, with the range in brackets:

| Events in window | Build | `count` | `sum` | `distinct` | `count` with `where` | Ten aggregates | Ten `where` misses |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1,000 | before | 0.07 | 0.65 | 1.0 | 0.6 | 13.8 (7.6–27.4) | not measured |
| 1,000 | after | 0.21 | 1.6 | 2.2 | 0.9 | 9.3 (7.2–14.5) | 8.7 (6.0–13.4) |
| 10,000 (at the limit) | before | 0.64 | 9.4 | 15.5 | 8.9 | 168 (117–238) | not measured |
| 10,000 (at the limit) | after | 0.72 | 11.5 | 16.6 | 8.7 | 91 (75–305) | 125 (83–213) |
| 100,000 (over the limit) | before | 0.54 | 10.1 | 16.2 | 26.2 | 10.6 (6.8–17.7) | not measured |
| 100,000 (over the limit) | after | 0.71 | 9.2 | 16.4 | 9.0 | 11.0 (7.1–25.7) | 9.5 (7.5–20.8) |

Over the limit, the first aggregate read is refused and the decision stops there, so ten
aggregates cost one bounded read. At the limit, ten aggregates cost ten reads of 10,000 rows, the
same work before and after: the medians above differ only through host load. Alternating runs of
ten `where` misses at 10,000 events measured 42 to 48 ms on the earlier build and 42 to 44 ms on
this one (one outlier at 58 ms), so the limit change adds no cost at the limit.

The worst case, nine aggregates that each read exactly the limit and then one that is over it (the
decision reads all nine before it stops), at 100,000 events: **124 ms** median, range 58 to 253 ms,
after; 170 ms (67 to 187) before. The earlier single figure of 54 to 59 ms was not reproduced on
this host under this load. Either way the decision stays well under the brief's 250 ms threshold
at its median, but the range reaches it, and the worst case is the one to watch.

The case the reviewer raised: ten aggregates over the same window of 100,000 events, each with a
`where` that matches nothing.

| Build | Ten `where` misses, 100,000 events in the window | Ten `where` misses, 10,000 events |
|---|---:|---:|
| before (`0351d17`, bound on matching rows) | 595 ms per decision (the reviewer measured 729 ms on the lead's host) | 42 to 48 ms |
| after (this branch) | 6.6 ms per decision, refused at the first read | 42 to 44 ms |

These two `before` columns came from a throwaway script that calls the same `createEventAggregates`
reader on an archive of `0351d17` under `node_modules/.cache/`; it is not committed. The branch's
figures are the harness's `tenWhereMissesMs`.

Before the limit (the branch as first published, no bound, reads of every matching event):

| Events in window | `count` | `sum` | `distinct` | `count` with `where` | Ten aggregates together |
|---:|---:|---:|---:|---:|---:|
| 100,000 | 2.4 ms | 64 ms | 95 ms | 65 ms | 709 ms (first run), 769 ms (second run) |

Each aggregate costs time linear in the events it reads, because SQLite parses each row's JSON
`data`: `count` does not read the data, the others do. Retention bounds what exists: an event
older than the retention window is gone before any aggregate can read it.

### Linux x64, 2026-11-17 (B93)

Re-run of the worst case above on the Linux VPS, with the same script and command
(`bun test/scheduler/measure-aggregates.ts 5`), five separate processes, each with five
repetitions and one warm-up (the script's median). The macOS figures above are left as they were.

Host and provenance: Linux 6.12.116 (Debian 13) virtual machine, 6 vCPUs, dynamic memory
(16 GiB maximum). Bun 1.4.4. Source commit `ac2d74e` (`origin/main`; the branch that adds this
section changes no product code). Script `test/scheduler/measure-aggregates.ts` sha256
`4d16127ab5831e105a67fd08940c2da74ede4bb0823468f9c602d90f89e88741`. The measurement imports the sources, not the
compiled executable; the executable built by `bun run check` (`dist/iglo.email`, sha256
`f09176f84a049896d21d23a1ee46eb8832b2c13186a26ba20c158ea6801d9069`) is recorded for reference only. Runs were made under the measurement lock.

Disturbance: no run was marked disturbed, since the one-minute load average stayed below the
6 CPUs throughout. The load average and `MemAvailable` before and after each of the five runs are
from the run logs, which were kept outside the repository and are not committed:

| Run | Load before | Load after | MemAvailable before | MemAvailable after | Worst case (ms, median of 5) |
|---:|---:|---:|---:|---:|---:|
| 1 | 4.47 | 4.27 | 6.76 GiB | 6.81 GiB | 120.5 |
| 2 | 4.09 | 3.92 | 6.81 GiB | 6.97 GiB | 112.9 |
| 3 | 3.92 | 4.17 | 6.97 GiB | 6.66 GiB | 113.1 |
| 4 | 4.17 | 3.99 | 6.66 GiB | 6.74 GiB | 113.5 |
| 5 | 3.99 | 3.83 | 6.74 GiB | 6.80 GiB | 117.6 |

| Measurement (100,000 or 10,000 events) | Median of five runs | Range of five runs |
|---|---:|---:|
| Ten aggregates, each at the limit (10,000 events) | 136.3 ms | 132.0 to 142.9 ms |
| Ten `where` misses at the limit (10,000 events) | 115.1 ms | 111.3 to 125.2 ms |
| Worst case: nine at the limit, then one over it (100,000 events) | **113.5 ms** | 112.9 to 120.5 ms |
| Ten aggregates over the limit (100,000 events), refused at the first read | 12.9 ms | 12.5 to 18.7 ms |
| Ten `where` misses over the limit (100,000 events), refused at the first read | 12.0 ms | 11.3 to 12.8 ms |

Each run's values are the script's medians of five repetitions. The worst-case median of
113.5 ms is below the 250 ms threshold, and so is the slowest run (120.5 ms). The lead decides the bound.

## Reproduce

```sh
bun test/scheduler/measure.ts 10000 3          # throughput, run on the branch and on the control
bun test/scheduler/measure-aggregates.ts 5     # one decision, by fn and size, the over-limit cases and the worst case
```

The control is `origin/main` (section 1) or `0351d17` (section 2), archived with `git archive` to
`node_modules/.cache/b85-prev` with `node_modules` linked to the checkout's, so its tests are never
discovered. Section 1 was measured before the limit and not re-run for this change: the limit
touches only the aggregate read, and a step without aggregates never reaches it.
