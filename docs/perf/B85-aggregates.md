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
the decision, and another subscriber has the same number of events with the same name, so each
read is bounded by the subscriber and name index and not by the table. Each figure is the median
of five runs after one warm-up, through `createEventAggregates`, the reader the event store exposes
to the scheduler. At 1,000 and 10,000 events the harness first checks the totals against values
computed from the data, so the timings measure correct answers. At 100,000 it checks that every
`download_finished` aggregate is refused with no total, and that `count_actions` (exactly 10,000
events) is complete.

The bound (D100): each aggregate reads at most 10,000 matching events (`AGGREGATE_LIMIT`), through a
subquery with `LIMIT 10001` on the index, newest first. Over the limit the step is skipped, so the
read stops at the limit. Two runs on this host, `run 1 / run 2`:

| Events in window | `count` | `sum` of `data.items` | `distinct` of `data.source_id` | `count` with `where` | Ten aggregates together |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 0.07 / 0.07 ms | 0.56 / 0.57 ms | 0.93 / 0.92 ms | 0.56 / 0.57 ms | 6.1 / 6.3 ms |
| 10,000 (at the limit) | 0.53 / 0.52 ms | 6.2 / 6.0 ms | 9.4 / 9.9 ms | 6.0 / 6.2 ms | 65 / 67 ms |
| 100,000 (over the limit) | 0.56 / 0.50 ms | 6.3 / 6.7 ms | 9.4 / 13.7 ms | 11.8 / 12.3 ms | 6.2 / 6.4 ms * |

\* Over the limit the first aggregate of the set is refused and the read stops: the decision costs
one bounded read, not ten.

Worst case, nine aggregates that each read exactly the limit and then one that is over it (the
decision reads all nine before it stops): **54 / 59 ms** at 100,000 events. This is the most a
decision can cost with ten aggregates, about the cost of the ten-at-the-limit row above. The brief's
threshold is 250 ms per decision.

Before the bound (the branch as first published, no limit, reads of every matching event):

| Events in window | `count` | `sum` | `distinct` | `count` with `where` | Ten aggregates together |
|---:|---:|---:|---:|---:|---:|
| 100,000 | 2.4 ms | 64 ms | 95 ms | 65 ms | 709 ms (first run), 769 ms (second run) |

Each aggregate costs time linear in the events it reads, because SQLite parses each row's JSON
`data`: `count` does not read the data, the others do. The `where` read also visits the
subscriber's non-matching events in the window, which the limit does not count.

## Reproduce

```sh
bun test/scheduler/measure.ts 10000 3          # throughput, run on the branch and on the control
bun test/scheduler/measure-aggregates.ts 5     # one decision, by fn and size, the over-limit case and the worst case
```

The control is `origin/main` archived to `node_modules/.cache/b85-control` (`git archive origin/main
| tar -x -C …`, with `node_modules` linked to the checkout's), so its tests are never discovered.
Section 1 was measured before the limit and not re-run for this change: the limit touches only the
aggregate read, and a step without aggregates never reaches it.
