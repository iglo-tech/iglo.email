# B42: runner test flake investigation

Test: `test/campaigns/runner/runner.test.ts`, "tracked links personalized per subscriber do not accumulate across batches" (line 573). Its reported failures were 30 s timeouts under `bun run check` (4 workers) and a 5 s timeout in a serial `bun test test/campaigns` run (#86, #90).

Status: the flake was **not reproduced** on this host and no runner defect was found. This file records what was measured and what was ruled out, so the next attempt starts from it. No timeout, retry or skip was changed.

## Reproduction attempts

Host: 6 cores, 16 GiB RAM. Fixture data directories are created under `os.tmpdir()`, which is `/tmp`, a tmpfs (RAM-backed).

| Run | Runs | Result | Wall time |
| --- | --- | --- | --- |
| Whole runner file, serial, idle | 10 | 10 pass | 16.3–17.5 s per file run |
| Whole runner file, serial, four CPU burners | 10 | 10 pass | 20.1–30.0 s per file run |
| `bun test test/campaigns`, serial (2 files, 49 tests) | 1 | pass | 28.0 s; target test 1.22 s |
| Target test alone | 1 | pass | 1.35 s |
| `bun test --parallel=4 --timeout=30000` over `test/campaigns test/backup test/tx test/webhooks test/analytics test/media test/users`, after `bun run build` | 1 | 272 pass, 0 fail | 109 s |

The parallel run included a temporary probe file in `test/campaigns/runner/`. It passed and was removed before any commit.

## Instrumented copy of the test body

A temporary copy of the test body (not committed) recorded what the loop does.

- Unloaded: 73 `drive` iterations; 14 `sleep(0)` batch pauses and 15 heartbeat `sleep(10000)` calls; no idle sleep and no lease-length sleep.
- Commits: 332 per run, 25–56 ms in total, largest single commit 0.5–6.4 ms.
- Renders: 300 per run. Unloaded: total about 444 ms, maximum 9.2 ms. Under four burners: total 719–1522 ms, maximum 25–37 ms. The LiquidJS render deadline (`renderLimit: 1000`, `src/templates/renderer.ts:192`) was never approached. No render errors in any run.
- Heap growth between the first and last measurement: about 1.5 MB in every run (asserted below 6 MB).
- One event-loop turn (`await Bun.sleep(0)`): p50 1 µs, p95 4 µs idle; p95 3 µs and maximum 0.09 ms under four burners. The `setImmediate` maximum under load was 2.4 ms.
- Full GC (`Bun.gc(true)`): 15–24 ms in a fresh process. 20 ms when the debug copy ran after the full runner file in the same process, so no heap accumulates across files. With a synthetic ballast of 3 million live objects, each full GC took 320–540 ms and the copy took about 2 s. That shows GC cost grows with live heap, but nothing in the real run creates that heap.

## Ruled out

- Real time in the runner path. A search of `src/campaigns`, `src/loops`, `src/messaging`, `src/unsubscribe` and `src/db` finds no `Date.now`, `performance.now` or `setTimeout` other than the Liquid render deadline. The runner SQL takes every time as a bound parameter from the injected clock.
- The render deadline. Its worst observed render under load was 37 ms against a 1000 ms limit.
- Long fake-clock waits. The sleep histogram above shows none in a run.
- Commit or fsync cost. `synchronous = FULL` applies, but the data sits on tmpfs and commits total under 60 ms.
- A shared heap between files. The same-process run showed no growth.
- Random identifiers. Their lengths are fixed, and the iteration count was 73 in every run.

## Not ruled out

- Host-level stalls. A roughly 1.2 s test would need a 25× slowdown to reach the 30 s limit and about 4× to reach the 5 s serial default. That fits memory pressure (the tmpfs `/tmp` held about 5.4 GiB at the time) or CPU contention from unlocked checks. This was not reproduced.
- Failure shape. `drive` waits up to 20000 iterations, about 140 s of real time at 7 ms per iteration. That exceeds the 30 s limit, so a stall appears as a bare timeout with no state recorded.

## Experiment not valid

A `dd` run with `oflag=dsync` was meant to add fsync contention. `/tmp` is a tmpfs, so the result says nothing about disk fsync.

## Next step

Capture state when the flake does occur: per-test durations from a JUnit report, memory pressure (`/proc/pressure/memory`) and the `drive` iteration count, all from inside the failing worker. Changing `drive` to fail with the pushed count and runner status after a bounded number of iterations would turn a timeout into a diagnosable failure. That is a diagnostic improvement, not a root-cause fix, and was not made here.
