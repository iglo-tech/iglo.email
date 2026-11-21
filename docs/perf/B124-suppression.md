# B124 suppression: before and after

Brief B124 / [D125](../design/09-decisions.md#d125-a-self-wiped-person-is-not-silently-re-opted-into-marketing-lead-2026-11-20).
A self-wipe leaves a suppression, and while it stands an event's grant, a create, an import and a
marketing sequence start check it. The check costs one read of the database's secret and one indexed
lookup, and it runs only for a row that asks for a list, an event that asks for a grant, and an event
that would start a marketing sequence. This measures the event path with and without a grant, before
and after the change.

- **Host:** an Apple silicon macOS workstation running the Linux arm64 image `oven/bun:1.4.5` under
  Docker, Bun 1.4.5 in the container. The data directory sits on the Docker bind mount (`fuse`), not
  tmpfs. The measurement needs Linux: the compiled executable never became ready on the macOS host
  itself (the same readiness timeout the macOS run of the MCP tests hits), so the runs are in the
  container. Compare only within this file.
- **Command:** in each export, `PERF_VARIANT=<name> [EVENTS_MEASURE_GRANT=1] bun test/events/measure.ts events`,
  piped through a summary that drops the per-second samples. The `events` scenario only: 100 events/s
  open loop for 60 s against the compiled `dist/iglo.email`, 2,000 subscribers, `idempotency_key` on
  every event. No sends.
- **Variants:**
  - `before`: `origin/main` at 5145461, no grant on any event.
  - `after`: this branch at 33d857c (the code measured; the later commit changes only this document),
    same workload, no grant. This measures the new code on the path that does not use it.
  - `before-grant`: `origin/main`, every event also sends `subscriber.grant_lists: [list]`.
  - `after-grant`: this branch, the same grant. Each grant now also reads the suppression, once per
    event, after the upsert.
- **Raw output:** one summary per run, printed by the measure script (not stored).

## Results

Latency in milliseconds, 6,000 requests per run, every one answered `200`, none shed. One run each.

| Variant | Acceptance p50 | p95 | p99 | Commit p50 | p95 | p99 | In-flight peak |
|---|---|---|---|---|---|---|---|
| `before` | 5.88 | 8.20 | 10.58 | 3.64 | 5.52 | 7.95 | 3 |
| `after` | 5.86 | 8.13 | 10.75 | 3.65 | 5.58 | 7.93 | 4 |
| `before-grant` | 6.21 | 9.03 | 13.39 | 4.02 | 6.43 | 10.12 | 7 |
| `after-grant` | 6.16 | 9.17 | 12.40 | 3.94 | 6.47 | 9.81 | 3 |

## Reading

- Without a grant, the branch is within noise of `origin/main` at every percentile. The new check is
  not reached on that path.
- With a grant, the branch is about 0.05 ms lower at p50 than `origin/main`, and about 1 ms lower at
  p99. One run cannot separate that from noise, so the reading is only that the suppression read adds
  no measurable cost to a grant, on an empty suppressions table (see the caveat below).
- No request was shed, and each run stored the same 6,020 rows: the 6,000 events and the measure
  script's setup rows.

## Not measured

- **The sequence-start path.** An event starts a sequence with a marketing step only through the
  trigger, and the check runs there only when such a sequence matches the event. The `events`
  scenario starts no sequence, so the check is never reached in these runs. Measuring it needs a
  scenario with a running marketing sequence and its scheduler, which the measure script does not
  set up. It is one check per matching sequence on that event, read on the write connection in
  the same transaction, so it is bounded by the number of marketing sequences the event triggers.
- **A populated suppressions table.** The table is empty in every run here: the benchmark makes no
  self-wipes. Each check is therefore a miss on an empty index. A table with suppressions is an
  index hit or miss on a larger B-tree, which these numbers do not show. The numbers are the cost of
  the read path on an empty table only.
- The public signup and the import are not in this measurement. Each adds one suppression lookup per
  row that asks for a list, inside its own write transaction. The import's budget check (D61) counts a
  suppressed row's list changes as if they would happen, so it can refuse a batch a little early;
  that is a correctness trade, not a latency one, and it is recorded in D125.
- A single run of 60 s per variant. The difference between the two runs of the same tree is the noise
  floor, as in [B84](B84-event-grant.md).
