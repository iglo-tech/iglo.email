# B155e: source windows, the scheduler's read flag (D180)

Measured 2026-11-26 on `agents-workhorse-01` (Linux x86-64, 12 cores, 30 GB RAM), Bun 1.4.5, before
(the `origin/main` files of `src/conditions/source.ts`, `src/scheduler/scheduler.ts` and
`src/sequences/**` at ae89737) and after (this change), back to back in one checkout. The data
directories are temporary directories in `/tmp`, a tmpfs. Load average 2.1–3.7 during the runs: the
other four B155 tasks were working on the same host. Not a CI threshold.

## What changed on the measured paths

- A step condition's and an aggregate's source query gain an upper bound, `occurredAt <= now + 15 min`
  (one more filter clause). A count with `where` that reads exactly `SCAN_LIMIT` records makes one
  more request (`latest`) instead of failing; below the limit nothing changes.
- Every scheduler decision keeps one boolean and, for an external sequence, wraps its source in a
  small object that sets it after a successful read. Pushed-event decisions read no source.

## Source conditions: `bun test/conditions/measure-source.ts 5`

The B150c workload (one user, 10,000 records, one condition reading every page, ten aggregates at
`AGGREGATE_LIMIT`), against the real PocketBase 0.40.5 binary.

| Read | Before: run 0 / runs 1–4 | After: run 0 / runs 1–4 |
|---|---|---|
| One condition | 169.6 ms / 100.3–191.8 ms | 159.0 ms / 99.8–109.0 ms |
| Ten aggregates (100,000 rows) | 3,526 ms / 3,924–4,398 ms | 2,929 ms / 3,542–4,097 ms |
| Peak RSS | 70–81 MB | 75–83 MB |

## Scheduler: `bun test/scheduler/measure.ts 10000 3`

10,000 due pushed-event enrollments per kind, and 2,000 outbox sends alone and beside the scheduler.

| Run | Before (s per run) | After (s per run) |
|---|---|---|
| Transactional, 10,000 | 3.09, 2.82, 2.88 | 2.85, 3.00, 2.91 |
| Marketing, 10,000 | 3.16, 3.37, 3.12 | 3.36, 3.17, 3.38 |
| Send load alone, 2,000 | 1.76, 1.54, 1.44 | 1.70, 1.53, 1.44 |
| Send load with the scheduler | 4.19, 4.09, 4.03 | 4.33, 4.33, 4.08 |

## Reading

Both are unchanged within the run-to-run spread under this load. The bound is one more comparison
in PocketBase's filter, and the read flag costs nothing a pushed decision can
measure. The `latest` read at `SCAN_LIMIT` happens only where the step used to end `source_error`.
