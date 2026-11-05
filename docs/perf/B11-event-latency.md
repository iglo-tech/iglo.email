# B11: event latency under mixed load

Host: the shared VM, Bun 1.4.4, compiled build, `origin/main` at f0e7627, run on a quiet host
(no other iglo.email suite; load average 2.2 to 3.3 at start, one other agent's work raised it to
about 7 at the end of run 3). Command: `M61_WINDOW_MS=120000 bun test/perf/m61/mixed.ts mixed`.
Raw result lines: `B11-results.jsonl`. Not CI thresholds.

## 1. Where the write lock goes (run 2)

A temporary probe in `writeTransaction` (not committed: it would be process-global state) timed
every write transaction from `BEGIN IMMEDIATE` to the end of `COMMIT`, keyed by the callback.
The whole run, 120 s window plus the 45 s seed:

| Writer | Commits | Total held | Mean | p95 | Max |
|---|---|---|---|---|---|
| Events (group commit) | 11,476 | 29.3 s | 2.55 ms | 5.2 ms | 15.5 ms |
| Seed (subscriber create, before the window) | 11,560 | 20.3 s | 1.76 ms | 3.2 ms | 14.9 ms |
| Sequence scheduler | 1,200 | 4.3 s | 3.55 ms | 6.3 ms | 15.1 ms |
| Loop claim (outbox, mail, whole run) | 5,686 | 4.2 s | 0.74 ms | 1.9 ms | 35.6 ms |
| Outbox outcomes (`finishAll`) | 1,437 | 2.0 s | 1.39 ms | 2.6 ms | 7.9 ms |
| Tx accept | 240 | 0.9 s | 3.66 ms | 6.5 ms | 11.5 ms |
| Campaign progress (once per batch) | 9 | 0.09 s | 10.4 ms | 16.1 ms | 16.1 ms |
| Lease renew | 10 | 0.02 s | 1.6 ms | 5.8 ms | 5.8 ms |

Events commit about once per event (11,476 commits for 12,000 events at 100/s), so a group
rarely holds more than one. All the other loops together hold the lock about 11.5 s in 165 s.
No commit of theirs holds it longer than 15.5 ms (the 35.6 ms claim and 36 ms migration are
startup), and their p95 is 2 to 6 ms. Campaign progress, outcomes and claims are already batched
(`claimBatch`, `finishAll`, once per campaign batch).

B7's reading (the event tail comes from the other loops' commits) is not supported: with the
host quiet, event acceptance p95 is 23 to 25 ms against 5.7 ms p50, and no other commit holds the
lock for that long, or often enough to make a 5 % tail.

## 2. Upper bound: no fsync at all

One experiment run with `synchronous = NORMAL` (the guard in `connection.ts` relaxed for the run
only, reverted), so no commit waits for a disk flush:

| Run | Events in window | p50 / p95 / p99 / max (ms) | Campaign rate | tx accept p95 (ms) |
|---|---|---|---|---|
| 1: FULL | 12,000 / 12,000 | 6.05 / 25.3 / 38.0 / 74.5 | 79.85/s | 28.1 |
| 2: FULL | 12,000 / 12,000 | 5.66 / 23.0 / 33.7 / 73.5 | 79.88/s | 26.6 |
| 3: NORMAL (experiment, not allowed by D22) | 12,000 / 12,000 | 3.58 / 21.9 / 39.4 / 151.8 | 79.86/s | 22.9 |

Removing the fsync from every commit cut the median by about 2 ms and the p95 by about 1 to 3 ms
(inside the 2.3 ms spread between the two FULL runs). The tail is therefore not commit time of any
kind: it is the single JavaScript thread being busy with the campaign's rendering and SMTP pipe,
sequence evaluation and the HTTP work for 200 requests a second, while an event waits for its turn.
Batching or shortening the other loops' commits can recover at most the 11.5 s of lock time
above, spread over 165 s, and the NORMAL run shows that even removing all of it would not move the
p95 beyond noise.

## 3. Outcome

No change was made, so no before/after pairs were run (there is no candidate to compare). The
smallest options were each ruled out by the numbers: coalescing campaign progress or outcome rows
(already one commit per batch; 0.09 s and 2 s of lock time), skipping the empty claim transactions
(about 4 s of lock time in 165 s, at 0.1 to 0.7 ms each) and a shared commit point (B7 reasoning,
now with the lock-time evidence). The invariants were not touched.

The backlog line is closed as owner-only: the remaining gain is in moving CPU work off the main
thread (a design change to the process model, not a commit change); FULL durability (D22) is not
the cause.
