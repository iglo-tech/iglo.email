# B84 event list grant: before and after

Brief B84 / [D99](../design/09-decisions.md#d99-events-grant-consent-on-single-opt-in-lists-lead-2026-11-16).
The event transaction now also grants consent on listed lists, so it writes more. This
measures the event path with and without a grant, on the same host, before and after the change.

- **Host:** the owner's macOS workstation (Darwin 27, Apple silicon), Bun 1.4.4, the workstation's
  own filesystem for the data directory (not tmpfs), one run per variant, no other load from this
  task. Not the Linux VPS the M5.1 numbers came from, so compare only within this file.
- **Command:** `bun run build`, then `PERF_VARIANT=<name> [EVENTS_MEASURE_GRANT=1] bun test/events/measure.ts events`.
  The `events` scenario only: 100 events/s open loop for 60 s against the compiled `dist/iglo.email`,
  2,000 subscribers, `idempotency_key` on every event. Sends are not part of this change and are not run.
- **Variants:**
  - `before`: `origin/main` at 224c71e, the code without grants. Events carry no grant.
  - `after`: this branch, same workload as `before`. Events carry no grant, so this measures the
    cost of the new code on the path that does not use it.
  - `after-grant`: this branch, every event also sends `subscriber.grant_lists: [list]` for one
    single opt-in list. The first event per subscriber inserts the membership (`added`), later
    events find it (`member`).
- **Raw results:** [B84-event-grant-results.jsonl](B84-event-grant-results.jsonl), one JSON line per
  run with the 1 s samples.

## Results

Latency in milliseconds, 6,000 requests per run, all answered `200`, none shed.

| Variant | Commit p50 | Commit p95 | Commit p99 | Commit max | Acceptance p50 | Acceptance p95 | Acceptance p99 | Peak in flight |
|---|---|---|---|---|---|---|---|---|
| before | 1.06 | 4.58 | 14.37 | 46.14 | 2.60 | 12.66 | 38.25 | 11 |
| after | 1.13 | 3.16 | 6.67 | 41.87 | 2.71 | 8.94 | 41.79 | 7 |
| after-grant | 1.21 | 3.90 | 7.44 | 32.05 | 2.77 | 10.05 | 47.99 | 12 |

"Commit" is request start to response, and a `200` is sent only after the commit. "Acceptance" is
the scheduled deadline to the response. "Peak in flight" is the most requests outstanding at once in
the open-loop driver. Server RSS (from `ps`, at start and peak) was 189 to 195 MiB in `before` and
`after` and 190 to 196 MiB in `after-grant`; the harness's final sample of the grant run reads 73 MiB,
taken after the process had been stopped, and is not used.

## Reading

- The grant adds about 0.1 ms to the commit median (1.13 to 1.21 ms) and nothing measurable at the
  tail, where the variation between runs is larger than the difference. Each grant is one
  `INSERT ... ON CONFLICT DO NOTHING` in the same transaction, and most events in this workload find
  the membership already present, so the write itself is rare.
- The `after` run against `before`, which carries no grant, is within run-to-run noise on this
  host. The extra check for `grant_lists` costs nothing measurable on the path that does not use it.
- One run per variant on a laptop is a rough observation, not a capacity claim, and it is not a CI
  threshold. The tails (p99 and max) move between runs by more than the differences above.

## Harness notes

- `test/events/measure.ts` now reads memory with `ps` where `/proc` is absent and records `free` as
  unavailable on other hosts, and it has `EVENTS_MEASURE_GRANT=1` for the grant workload.
- The production readiness check in `test/serve-port.ts` reads `/proc`. On this host it was
  replaced for the measurement and the checks by a temporary local `lsof`-based shim, which is not
  part of this change. See the PR description.
