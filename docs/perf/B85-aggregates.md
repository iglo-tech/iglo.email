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

## 2. One decision: aggregates over one subscriber's events

Harness: `test/scheduler/measure-aggregates.ts` (`bun test/scheduler/measure-aggregates.ts 5`).
One subscriber has 1,000, 10,000 or 100,000 `download_finished` events inside the 30 days before
the decision, and another subscriber has the same number of events with the same name, so each
read is bounded by the subscriber and name index and not by the table. Each figure is the median
of five runs after one warm-up, through `createEventAggregates`, the reader the event store exposes
to the scheduler. The harness first checks the totals against values computed from the data
(`count`, `sum`, `distinct`, `where`, and the ten-aggregate set), so the timings measure correct
answers.

| Events in window | `count` | `sum` of `data.items` | `distinct` of `data.source_id` | `count` with `where` | Ten aggregates together |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 0.04 ms | 0.5 ms | 0.8 ms | 0.5 ms | 5.6 ms |
| 10,000 | 0.3 ms | 5.6 ms | 8.6 ms | 5.7 ms | 60 ms |
| 100,000 | 2.4 ms | 64 ms | 95 ms | 65 ms | 709 ms (first run), 769 ms (second run) |

The ten aggregates were four sums (two with `where`), three distinct counts, and three counts, one
of them over `assistant_action`. Each aggregate costs time linear in the events it matches, because
SQLite parses each matching row's JSON `data`: `count` does not read the data, the others do.

### Against the brief's threshold

The brief says: if ten aggregates over 100,000 events each take more than 250 ms per decision,
propose a bound and do not truncate. They take about 0.7 to 0.8 s, so a bound is **proposed** in
D100 and not implemented here. The reads run synchronously on the scheduler's thread, so one such
decision blocks the other loops for that long. Event retention bounds how many events exist; the
proposal is for the lead to decide between a limit per aggregate (ending in a condition-style
error and never a partial total) and a shorter retention for the events aggregates read.

## Reproduce

```sh
bun test/scheduler/measure.ts 10000 3          # throughput, run on the branch and on the control
bun test/scheduler/measure-aggregates.ts 5     # one decision, by fn and size
```

The control is `origin/main` archived to `node_modules/.cache/b85-control` (`git archive origin/main
| tar -x -C …`, with `node_modules` linked to the checkout's), so its tests are never discovered.
