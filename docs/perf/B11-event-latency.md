# B11: event latency under mixed load

Host: the shared VM, Bun 1.4.4, compiled build, `origin/main` at f0e7627, started on a quiet host
(no other iglo.email suite; load average 2.2 to 3.3 at start; other work raised it to about 7
during run 3). Command: `M61_WINDOW_MS=120000 bun test/perf/m61/mixed.ts mixed`.
Raw result lines: `B11-results.jsonl`. Not CI thresholds.

## 1. Where the write lock goes (run 2)

A temporary probe in `writeTransaction` (not committed: it would be process-global state) timed
every write transaction from `BEGIN IMMEDIATE` to the end of `COMMIT`, keyed by the callback.
The whole run, 120 s window plus the 45 s seed:

| Writer                                      | Commits | Total held | Mean    | p95     | Max     |
| ------------------------------------------- | ------- | ---------- | ------- | ------- | ------- |
| Events (group commit)                       | 11,476  | 29.3 s     | 2.55 ms | 5.2 ms  | 15.5 ms |
| Seed (subscriber create, before the window) | 11,560  | 20.3 s     | 1.76 ms | 3.2 ms  | 14.9 ms |
| Sequence scheduler                          | 1,200   | 4.3 s      | 3.55 ms | 6.3 ms  | 15.1 ms |
| Loop claim (outbox, mail, whole run)        | 5,686   | 4.2 s      | 0.74 ms | 1.9 ms  | 35.6 ms |
| Outbox outcomes (`finishAll`)               | 1,437   | 2.0 s      | 1.39 ms | 2.6 ms  | 7.9 ms  |
| Tx accept                                   | 240     | 0.9 s      | 3.66 ms | 6.5 ms  | 11.5 ms |
| Campaign progress (once per batch)          | 9       | 0.09 s     | 10.4 ms | 16.1 ms | 16.1 ms |
| Lease renew                                 | 10      | 0.02 s     | 1.6 ms  | 5.8 ms  | 5.8 ms  |

Events commit about once per event (11,476 commits for 12,000 events at 100/s), so a group
rarely holds more than one. All the other loops together hold the lock about 11.5 s in 165 s.
Apart from startup (a 35.6 ms claim and a 36 ms migration), no other writer's commit holds the
lock longer than 16.1 ms (campaign progress, 9 commits; the others peak at 15.1 ms or less), and
their p95 is 2 to 6.5 ms (campaign progress 16.1 ms, n = 9). Campaign progress, outcomes and claims
are already batched (`claimBatch`, `finishAll`, once per campaign batch). With `bun:sqlite`
synchronous on one connection, the time a transaction "holds the lock" is time the main thread
is blocked.

The event writer is the largest user: 29.3 s of the run. Its transactions include sequence
trigger evaluation (`exitThenTrigger` in `src/events/store.ts`) as well as their own fsync, so
"not a commit problem" does not exclude the event writer's own transactions. The probe does not
split that time between evaluation and fsync.

B7's reading (the event tail comes from the other loops' commits) is not supported by these
numbers: no other writer's commit is long or frequent enough to explain a 5 % tail of 23 to 25 ms
against a 5.7 ms p50.

## 2. One `synchronous = NORMAL` sample (experiment only)

Run 3 used `synchronous = NORMAL` (the guard in `connection.ts` relaxed for the run, reverted), so
no commit waits for a disk flush. D22 forbids this; it was run only to size what a D22 change could
buy. **It is one sample, taken under host disturbance**: other work raised the load to about 7,
MemAvailable fell from about 11.5 to 9.4 GiB (11,808 to 9,630 MiB), peak in-flight requests were 16 where both FULL runs
had 8, and the maximum latency doubled. That kind of interference inflates p95, p99 and max. One
disturbed sample against two FULL samples can neither show that the difference is noise nor
that it is real.

What each run carried locally (all three result lines say `dirty: true`; every run had the
one-line `mixed.ts` change that passes `B11_PROBE_FILE` to the server):

| Run | Source hash | Probe                                   | Pragma |
| --- | ----------- | --------------------------------------- | ------ |
| 1   | `de2db21a…` | first version (call-site stack labels)  | FULL   |
| 2   | `b46d35b2…` | second version (callback-source labels) | FULL   |
| 3   | `912ef3d3…` | second version                          | NORMAL |

So all three carried a probe; the probe version differs between runs 1 and 2, and run 3 differs
from run 2 only by the pragma (and the host).

| Run                   | Events | Event p50 / p95 / p99 / max (ms) | Campaign/s | Tx accept p95 (ms) | Tx delivery p50 / p95 (ms) |
| --------------------- | ------ | -------------------------------- | ---------- | ------------------ | -------------------------- |
| 1: FULL               | 12,000 | 6.05 / 25.3 / 38.0 / 74.5        | 79.85      | 28.1               | 29.6 / 87.7                |
| 2: FULL               | 12,000 | 5.66 / 23.0 / 33.7 / 73.5        | 79.88      | 26.6               | 28.0 / 79.4                |
| 3: NORMAL (disturbed) | 12,000 | 3.58 / 21.9 / 39.4 / 151.8       | 79.86      | 22.9               | 16.5 / 52.7                |

Gains the NORMAL sample showed against the two FULL runs: event p50 −37 to −41 %, tx accept p95
−14 to −19 %, tx delivery p50 −41 to −44 % and p95 −34 to −40 %, and a shorter seed (31 s against
44 s). The event p95 moved from 23.0 to 25.3 ms to 21.9 ms, 1.1 ms below the lower FULL run (less than
the 2.3 ms spread between the two FULL runs) and with the disturbance above. Confirming any of these needs at least three alternating
FULL/NORMAL runs on a quiet host with the same command.

## 3. Outcome

No change was made, so no before/after pairs were run (there is no candidate to compare). The
smallest options were each ruled out by the numbers: coalescing campaign progress or outcome rows
(already one commit per batch; 0.09 s and 2 s of lock time), skipping the empty claim transactions
(about 4 s of lock time in 165 s, at 0.1 to 0.7 ms each) and a shared commit point (B7 reasoning,
now with the lock-time evidence). The invariants were not touched.

The tail is attributed to main-thread CPU (campaign rendering, SMTP pipe, sequence evaluation,
HTTP) by elimination: no event-loop delay histogram or CPU profile backs it, so a process-model
change has no measured expected gain. A future measurement should split event-loop delay by cause.

The backlog line stays owner-only: an owner decision on D22 (measured gain above, one disturbed
sample) and/or a process-model change (gain not measured).
