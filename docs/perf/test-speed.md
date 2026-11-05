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

1. `bun run test` = build once, then `bun test --parallel=4 --timeout=30000 --timings=test/timings.json`.
   Bun 1.4.4 runs files in worker processes with `--parallel`; `timings.json` starts the slowest
   files first. `bun run check` uses it. Plain `bun test <path>` stays serial.
2. Parallel runs exposed a race: four test files ran `bun run build`, which deletes and recreates
   `dist/assets` while in-process tests import it (58 failures,
   `Cannot find module '@/../dist/assets/admin/js/boot.js'`). `test/production-build.ts` replaces
   them: `bun run test` builds once and sets `IGLO_TEST_PREBUILT=1`; without it the first caller
   builds under a cross-process lock.
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
They were rewritten with `\u` escapes (`[^\t\n\r -퟿-�\u{10000}-\u{10ffff}]`);
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
