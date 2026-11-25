# Test speed (2026-11-05)

Goal: cut the time `bun test` and `bun run check` spend on this host. Bun 1.4.4, 6 cores,
shared with other agents, so every number below is from a loaded host (load average 4–14).

## Result

| | Before | After |
|---|---|---|
| `bun test` (956 tests) | 517 s (owner's B8 round-2 run, load ~4); 650 s (this task, serial, junit, load 8–10) | 167–173 s (`bun run test`, 4 workers) |
| `bun run check` | 547 s (owner's run) | 157 s (load 11), 186 s (final run, load 8–14) |
| Suite runs per role | 2 (`bun test`, then `bun run check`) | 1 (`bun run check`) |

The role-level saving is larger than the single-run one: about 1064 s of suite per role before
(517 + 547) against about 160–190 s after.

## Where the time went

Per-file times (serial, junit) sum to the whole run. Nothing was slow because of a build per file
(`bun run build` takes about 1 s) or hashing: the cost is real elapsed time in tests that drive the
compiled executable as a child process and wait on real clocks, which the injected clock cannot
reach in another process.

- `test/backup/backup.test.ts` 110 s: two cases of 34 s each (SIGKILL and SIGTERM midway through a
  300,000-row snapshot) plus about 30 s of the rest.
- `test/backup/hold.test.ts` 56 s: a restored-install case of 32 s with two 6.5 s quiet periods
  and a 4 s campaign delay against a child server.
- `test/users/auth.test.ts` 60 s: about 40 cases of 1–3 s, each creating users with argon2id
  (about 180 ms per hash under load) and logging in over HTTP.
- The other files are 5–25 s each; the 80 files run one after another on one core, while the
  host has six.

No sleep that the injected clock could replace was found in the slow files. The real-time waits are
against child processes that own their clock, so they stay.

## What changed

1. `bun run test` = check the build once (D168), then `bun test --parallel=4 --timeout=30000 --timings=test/timings.json`.
   Bun 1.4.4 runs files in worker processes with `--parallel`; `timings.json` starts the slowest
   files first. `bun run check` uses it. Plain `bun test <path>` stays serial.
2. Parallel runs exposed a race: four test files ran `bun run build`, which deletes and recreates
   `dist/assets` while in-process tests import it (58 failures,
   `Cannot find module '@/../dist/assets/admin/js/boot.js'`). `test/production-build.ts` replaces
   them: `bun run test` checks the build once and sets `IGLO_TEST_PREBUILT=1`; without it the
   preload checks before each file. A build happens only when the inputs' content hash changed,
   under a lock, in a staging copy whose files are renamed into place (D168).
3. The 5 s default test timeout failed a process-spawning test once under parallel load. The
   script passes `--timeout=30000` (a `[test] timeout` key in `bunfig.toml` is ignored by Bun
   1.4.4). Tests that check timing still assert on the injected clock or a stated bound.
4. `test/subscribers/query.test.ts`: the query runner's time limit was 1500 ms, including starting
   the child. On a loaded host the memory-limit query hit the time limit first. The limit is now
   4000 ms and the "stops within" bound is limit + 3.5 s. The test still checks that the limit
   stops the SQLite work and that the memory cap answers with its own message.
5. `test/backup/interrupted.test.ts` holds the two kill-midway cases, unchanged, so the workers
   share them (the longest file fell from 110 s to 69 s).
6. Duplicate run removed from AGENTS.md and docs/chief-of-staff.md: `bun test` and `bun run build`
   are no longer listed beside `bun run check`.
7. Type check: see below.

No assertion was removed or weakened, and no test was deleted. 956 tests before and after.

## Type check

| | `tsc --noEmit` (TypeScript 6.0.3) | `bun check --no-script` (Bun 1.4.4) |
|---|---|---|
| Cold wall time | 17–32 s (load dependent) | 0.7–1.3 s |
| Errors on this tree | 0 | 2, at first |
| Injected type error | reported | reported, same message and position |

`bun check` reported two errors tsc did not: `TS1516` on the two character-class regexes in
`src/public/archive.tsx` (lines 45 and 49), which wrote U+D7FF and U+E000 as raw characters.
They were rewritten with `\u` escapes (`[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10ffff}]`);
a sweep of every code point shows the two regexes match identically, and `test/public` passes.
This is the only product-source change. After it both checkers pass and `typecheck` is
`bun check --no-script` (`--no-script` because the package.json `check` script shadows the
built-in). `tsconfig.json` already had `types: ["bun"]`, `strict` and `paths` without `baseUrl`,
so nothing else needed to change.

The `typescript` devDependency stays: editors use its language server, and `bun check` replaces
only the command-line check. No new dependency, so no decision record.

## Per-file times, top 15

Before: serial run, junit. After: the `--timings` measurement of a 4-worker run, so each file ran
beside three others and its time includes that contention; they are not comparable one to one.

| # | Before (serial) | s | After (4 workers) | s |
|---|---|---|---|---|
| 1 | test/backup/backup.test.ts | 110.4 | test/backup/interrupted.test.ts | 69.0 |
| 2 | test/users/auth.test.ts | 60.4 | test/users/auth.test.ts | 58.2 |
| 3 | test/backup/hold.test.ts | 56.5 | test/backup/hold.test.ts | 54.1 |
| 4 | test/webhooks/webhooks.test.ts | 24.6 | test/backup/backup.test.ts | 41.3 |
| 5 | test/analytics/analytics.test.ts | 23.6 | test/tx/tx.test.ts | 22.6 |
| 6 | test/tx/tx.test.ts | 22.4 | test/webhooks/webhooks.test.ts | 22.4 |
| 7 | test/bootstrap/cli.test.ts | 19.6 | test/analytics/analytics.test.ts | 20.8 |
| 8 | test/bootstrap/instance-lock.test.ts | 18.6 | test/media/media.test.ts | 20.0 |
| 9 | test/campaigns/runner/runner.test.ts | 17.6 | test/bootstrap/cli.test.ts | 18.5 |
| 10 | test/scheduler/scheduler.test.ts | 17.2 | test/scheduler/scheduler.test.ts | 17.9 |
| 11 | test/campaigns/campaigns.test.ts | 15.1 | test/campaigns/runner/runner.test.ts | 17.5 |
| 12 | test/templates/store.test.ts | 15.0 | test/public/public.test.ts | 17.2 |
| 13 | test/public/public.test.ts | 15.0 | test/bootstrap/instance-lock.test.ts | 17.1 |
| 14 | test/media/media.test.ts | 14.8 | test/bounces/bounces.test.ts | 16.7 |
| 15 | test/bounces/bounces.test.ts | 13.4 | test/campaigns/campaigns.test.ts | 15.5 |

## Remaining cost

About 450 s of CPU time remains across 81 files, so 4 workers cannot go much below 115 s on this
host. Next candidates, none taken here: `auth.test.ts` (argon2id per test user; a test-only cheaper
cost would need a product seam or a preload that wraps `Bun.password`), and the real quiet periods
in `hold.test.ts`, which belong to a child process's clock.

## Reproduce

```sh
bun run check                      # whole gate
bun run test                       # build once, then the parallel suite
bun test --parallel=4 --timeout=30000 --timings=test/timings.json --update-timings  # refresh timings
```

## 2026-11-22: B137, faster and steadier suite (D133)

Hosts. macOS: Apple Silicon, 8 CPUs, shared with other agents; the 1-minute load was 4 to 17 for
the runs below, and up to 134 in a few minutes of the session (those timings are marked). Linux:
Docker (OrbStack) container `oven/bun:1.4.5`, 8 CPUs, user `bun`, `--security-opt seccomp=unconfined
--security-opt apparmor=unconfined`, the tree copied from the committed worktree. Steps that need
Docker (the `reference:run` family) ran against a `docker:27-dind` sidecar that shares its network
namespace with the test container, because the harness checks `127.0.0.1`. Load is `/proc/loadavg`
at the start and end of each container run.

### Results

| | Before | After |
|---|---|---|
| `bun run check`, Linux container, alone | 304 s, 1780 pass, 0 fail (load 6.8 to 11.6) | 357 s, 1780 pass, 0 fail (load 7.4 to 8.5) |
| `bun run check`, macOS | 262 s, 1766 pass, 7 skip, 7 fail (load 5 to 8) | 172 s, 1773 pass, 7 skip, 0 fail (load 4 to 8) |

The Linux wall time did not fall in this measurement: the same host load gave 304 s before and
357 s after. The per-file gains below are real (the interrupted backup file, the send-rate file, the
converter test), but the total at this load did not show them. macOS went from 7 failures to 0.

### Per item

1. **Parallelism.** `--parallel=4` and `--parallel=8`, container, two runs each, back to back, current
   timings file:

   | workers | run | wall (tests) | result | load |
   |---|---|---|---|---|
   | 4 | A | 254.6 s | 1780 pass | 1.1 to 9.4 |
   | 4 | B | 259.8 s | 1780 pass | 5.3 to 7.8 |
   | 8 | A | 198.3 s | 1779 pass, 1 fail (`interrupted`: race while seeding, fixed in `e767fe6`) | 9.0 to 14.2 |
   | 8 | B | 196.7 s | 1779 pass, 1 fail (compiled-server readiness, 8.9 s, the 5 s budget) | 7.8 to 11.4 |

   Eight workers are about 23 % faster but failed in both runs, and each failure is a timing bound
   starved by eight busy cores. Not reliable, so the script keeps **4**. Eight workers also
   failed 23 tests in the first 8-worker container run, taken while the macOS host was at load 44.
   Not tried: a core-count
   expression, or 6 workers.

2. **Timings.** `test/timings.json` listed 103 of 168 files. Refreshed in the container with
   `--update-timings` at 4 workers (load 10 to 13): 168 entries, slowest first. Top: runner (122 s,
   summed over its tests), markdown-liquid (109 s), backup (83 s), auth (80 s). That refresh run
   failed the tracked-links case (65 s, the bound of 60 s); the case is changed in item 7.

3. **`templates:compiled`.** No change. In the container at idle load: the compile takes 78 to
   117 ms (`bun build --compile` of the fixture), the bwrap run takes 285 ms, and the whole step takes
   0.35 to 0.42 s. The 179 s was not reproduced. The step's own limits are 60 s for the compile and
   30 s for the run, so 179 s cannot come from these two phases; it came from the host around the run.

4. **send-rate.** Cause: the sink stamps receipts with the injected clock, and the wait loop moved
   that clock while SMTP I/O was pending. The clock now moves only when no granted send is still in
   flight (grants counted through a wrapper of the limiter), and a wait fails only after 3 s with no
   grant, receipt or send-status change. Every assertion is unchanged.
   - macOS before: 4 of 14 fail on every run (1, 3, 7b, 7c). After: 10 of 10 runs, 14 of 14 each.
   - Container before: 1b flaked once in five runs. After: 5 of 5, 14 of 14 each. An intermediate
     version (no progress budget) failed 1b once in five, so the budget change is part of the fix.

5. **Interrupted backup.** The 300k rows are seeded once in a `beforeAll`, and each case copies the
   stopped data directory into its own base directory. The seed helper now finalizes its statement
   before closing, so the template has one database file (before, a live statement kept the WAL on
   disk, and a copy could race with it).
   - Container before: SIGKILL 40.1 s, SIGTERM 31.9 s, file 73.3 s. After: 3.8 to 4.8 s per case,
     file about 40 s of one-time build and seed, 3 of 3 runs pass.
   - macOS: file 54.6 s before, 49.5 s after (first version, before the seed fix).

6. **Converter worst case.** The single absolute sample (under 1 s, failed at 1006 to 1181 ms
   under load, B120) is now a ratio within the run: the median of three at 64 KiB and at 1 MiB,
   bound 32x. Linear work gives about 16x for 16x the input.
   - Measured, real converter: macOS 14.3, 18.3, 14.3x (load 27 to 93); container 13.9, 15.4, 15.3x.
   - A 4x ratio bound was tried first and rejected: the container measured 4.0 to 5.2x for 4x input,
     too close to a bound of 5.
   - Quadratic check: a scratch copy of `src/messaging/plain.ts` with a quadratic loop in front of
     the conversion (inner step 100). The new test fails at 118.9x. The same stub fails 16 existing
     tests in the file at 8.9 to 22x (bound 5) and 19.5x (bound 6), so the file's ratio tests also
     catch the property.
   - Test count unchanged at 43 in the file.

7. **Slow files.**
   - `runner.test.ts`, tracked links (changed): the 300-message render is CPU-bound, 27 to 65 s in the
     container, and one run in six passed the 60 s bound by a margin of zero. Its wait now fails after
     60 s with no new push and stops at 75 s in all, before the 90 s test timeout. Settling each
     push once (settle is idempotent) replaces a settle of every push on every iteration, which kept
     a core busy. Alone: 38.7 s before, 28.3 s after (container, load 12 and 7). Inside the file:
     24.5 s. The first version of this change let a timed-out loop drive the next test's fixture;
     the final version fixes that.
   - `scheduler.test.ts`, enrollments with a failing condition (changed): the wait gave up at 15 s of
     wall time for 1000 failing evaluations. It now fails after 15 s with no new evaluation; the 60 s
     test timeout still bounds it. Container alone: 51.5 s, passing (was 43 s and failing in the full
     run). macOS: 8.5 s.
   - `hold.test.ts`, no change. The quiet period (6.5 s) covers the campaign runner's 5 s scan
     (`scanInterval` in `src/campaigns/runner/runner.ts`); a shorter period would not cover one full
     scan. Measured time from restart to a released campaign's delivery: 282 to 559 ms in the
     container, 578 ms on macOS (load 12), including the server start.
   - `auth.test.ts`, no change. The cost is argon2id hashing by `Bun.password` with its default
     parameters; no test-only setting exists, so the cost was not lowered.
   - `instance-lock.test.ts`, no change. Its only wait is a 5 s watchdog on runs that must end by
     themselves, and it is not reached in a passing run; the time is process starts.
   - `backup.test.ts`, no change. About 60 small cases; the waits poll every 5 ms for progress.

8. **Other macOS fixes (not in the brief).**
   - `test/templates/render.test.ts`: the caller stopped its server before the body of a 1 MiB reply
     was read (ECONNRESET on macOS; Linux's larger buffers hid it). The body is now read first.
   - `test/backup/fixture.ts`: `seedSubscribers` finalizes its statement before closing (item 5).

### Not changed, open

- `bootstrap/cli.test.ts` readiness: a compiled server's first start of a new binary content took
  1.8 s on macOS, against 0.36 s for a repeat start (`startup` probe, low load). The 5 s budget is
  met at low load, and failed at load 20 to 40 (two cases, baseline). No warm-up added on this evidence.
- `scheduler.test.ts`, enrollments test: 51.5 s alone in the container against a 60 s timeout; its
  1000 sequential event requests are the cost.
- `runner.test.ts`, tracked links: still 25 to 28 s, the render cost itself (a product question:
  about 90 ms per message for 60 KB of link text).

### Judgement calls for review

Three waits measured a real-time budget for CPU-bound or I/O-bound work. They now measure
**progress** (a grant, a receipt, a push or an evaluation) with the stall budget unchanged: send-rate's
`drive`, the tracked-links wait, and the scheduler's `until`. Each still fails at its stall bound
and each test still has its own total limit. This is a change of what the budget measures, so the
owner should confirm it.

### Acceptance

- macOS `bun run check` on the final commit: exit 0; 1773 pass, 7 skip, 0 fail; 172 s.
- Container, in order, as user `bun`: `bun install --frozen-lockfile` exit 0; one `bun run check` on
  the final commit (`1b0c154`): exit 0, 1780 pass, 0 fail, 357 s. Then `bun run ui:verify`,
  `templates:compiled`, `contract:templates`, `contract:normal`, `contract:auth`, `contract:roles`,
  `contract:lists`, `contract:subscribers`, `contract:settings`, `contract:sends`,
  `sends:batch-crash`, `contract:fixture`, `contract:messaging`, `messaging:fixture`,
  `contract:events`, `contract:sequences`, `contract:bounces`, `contract:media`, `contract:import`,
  `contract:webhooks`, `contract:campaigns`, `contract:analytics`, `contract:tx`,
  `contract:unsubscribe`, `contract:public`, `contract:maintenance`, `contract:openapi`: all exit 0.
  The reference-based ones ran against the sidecar.
- The `Configure and probe` step: `apt-get install bubblewrap` and the `bwrap` probe succeed. The
  `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` line cannot run in the container (the
  knob is not in `/proc/sys`); it is a runner-host setting and the probe passes without it.
- An earlier container `bun run check` on `bdd84cb` failed 5 tests (1775 pass): a leak from the
  tracked-links loop (fixed in `1b0c154`) and the scheduler wait. It is not the acceptance run.

## 2026-11-23: B118a, readiness budget and eight workers (B118a item 10)

- **Readiness budget, raised from 5 s to 15 s** (`test/serve-port.ts`, `healthWhenReady`). The budget
  bounds a start that never finishes; a start that fails is seen at once through the exit code. The
  5 s budget was met at low load and failed at load 20 to 40 (the section above). A start on a loaded
  host (eight workers, or amd64 emulation) can take longer without being a failure. A hung start still
  fails by name before the 30 s per-test limit. Readiness is not event-driven: the executable prints no
  start line (application code logs only errors and things that need attention), and polling checks
  that the child itself listens (`listensOn`).
- **Parallelism.** `test/messaging`, `test/tx`, `test/sends` and `test/sequences` (37 files, 291 tests)
  in the container (eight CPUs), back to back, with the current timings file. Both runs passed 291 of 291.

  | workers | wall (37 files) | result |
  |---|---|---|
  | 4 | 104.9 s | 291 pass |
  | 8 | 47.4 s | 291 pass |

  One pair, not a series; the host load differs between runs (other agents). Eight workers did not show
  a readiness or timeout failure in this chunk. The full suite at eight workers was not run in one
  invocation here: it would exceed the 600 s foreground limit, so it ran as five directory chunks at four
  workers. Whether the check's `--parallel=4` moves to eight is the lead's call on the full suite.
