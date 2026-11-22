# B128: event times (D124), before and after

**What changed on the measured path.** `POST /api/subscriber-events` (and each item of the batch route) now compares an event's parsed `occurred_at` with the server clock, once, and refuses it when it lies more than 15 minutes ahead ([D124](../design/09-decisions.md#d124-event-times-late-transactional-steps-and-test-subjects-lead-2026-11-20)). That is one `Date.parse` and one comparison per event that sends `occurred_at`. No query, no write, no schema change. The scheduler, the send path and the campaign runner are not touched by the measured change.

**Method.** `test/events/measure.ts events`, the events-only scenario of the events API measurement (real HTTP against the compiled executable; open-loop events at a fixed 10 ms cadence for a 60 s window, 6,000 events per run, a loopback sink for the unused send load). Base is `origin/main` at `9e31cac`, and head is the B128 commit `db0b285` on `task/B128-event-time-late`. Each was exported with `git archive` and built as its own tree, so the source differs only in the B128 files. Both executables were built inside the same container (`oven/bun:1.4.5`, linux arm64, Docker on Apple silicon through OrbStack), and the runs were interleaved base, head, base, head, base, head, one container for all six runs, each run's data directory on the container's own overlay filesystem. The executables' hashes are in the run output: base `828f9a7d…`, head `538928b1…`.

**Results** (milliseconds, from the runs' `eventsOnly` section; 6,000 events and 6,000 `200` answers in each run, no shed, no in-flight tail after the window):

| Run | Variant | Accept p50 | Accept p95 | Accept p99 | Commit p50 | Commit p99 |
|---|---|---:|---:|---:|---:|---:|
| 1 | base | 7.75 | 15.83 | 53.65 | 5.51 | 48.21 |
| 1 | head | 7.53 | 12.62 | 18.98 | 5.18 | 16.65 |
| 2 | base | 7.28 | 13.48 | 23.59 | 5.09 | 21.94 |
| 2 | head | 5.07 | 9.99 | 19.50 | 3.11 | 16.72 |
| 3 | base | 4.81 | 8.29 | 14.73 | 2.99 | 12.92 |
| 3 | head | 4.87 | 8.57 | 19.45 | 3.01 | 16.96 |
| **median** | base | **7.28** | **13.48** | **23.59** | **5.09** | **21.94** |
| **median** | head | **5.07** | **9.99** | **19.45** | **3.11** | **16.72** |

**Reading.** The medians favour head, but they are not an improvement claim: base's own runs span 4.8 to 7.8 ms at p50, wider than the gap between the medians, and the container shares its host with other work. The change adds one `Date.parse` and one comparison per event, a few tens of nanoseconds against a 5 ms commit, so it is below anything these runs can resolve. The result is no regression on the events path; the 60 s windows measured no event refused or shed.

**Not measured.** The campaign test subject (D124, the `[Test] ` prefix on a campaign test message) and the transactional `max_late` rule. The test-send prefix is one string concatenation per test message on a path capped at 1,000 recipients and four concurrent requests (`src/campaigns/routes.ts`), so no test-send number is recorded here. The `max_late` rule is the scheduler's existing check, unchanged in code; its tests are `test/scheduler/late-transactional.test.ts`.

Note (lead, review r1): the `test/events/measure.ts` workload sends no `occurred_at`, so the new future-time comparison does not run in these measurements; they show that the events path is otherwise unchanged. The comparison itself is one clock read and one integer compare per event.
