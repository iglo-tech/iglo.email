# B32: cheaper `settings.read()`

Host: shared VM, Bun 1.4.4, `M61_WINDOW_MS=120000 bun test/perf/m61/mixed.ts mixed` (compiled), one run at a time under `measurement.lock`. Results: [`B32-results.jsonl`](B32-results.jsonl) (hashes and heads inside). Load at start (1 min): 1.5 to 2.5. The rule is below 2: runs starting at or above it are marked disturbed. Not CI thresholds.

| Build                                                                     | Load at start                              | Event p50 / p95 / p99 / max (ms) | Campaign /s |
| ------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------- | ----------- |
| Before (main daa4680), run 1                                              | 1.85                                       | 25.9 / 57.4 / 74.4 / 109         | 78.3        |
| Before, run 2                                                             | not captured (about 2 at the end of run 1) | 26.8 / 59.1 / 75.5 / 120         | 78.2        |
| Fold map only (5b0d404 (a local fold-map-only commit, not pushed)), run 1 | 1.64                                       | 19.6 / 41.4 / 53.1 / 104         | 79.1        |
| Fold map only, run 2                                                      | 1.59                                       | 19.1 / 41.0 / 51.0 / 114         | 79.2        |
| Fold map + row-validated cache (f6058e4), run 1                           | 1.46                                       | 14.6 / 32.4 / 43.3 / 78          | 79.4        |
| Fold map + cache, run 2                                                   | 2.5 (disturbed)                            | 14.6 / 33.5 / 43.8 / 106         | 79.5        |

Event p95: 58 → 41 → 33 ms (about −44 % in all). Executable hashes: before `f67702e3895a24e9`, fold map `49ef111d298d6cfa`, cache `3e9c30bb5b101d34`.

CPU profile (`M61_CPU_PROF`, source run, fold map only): `settings.read` 6.9 % inclusive, `projectRaw` 16.2 %, `foldField` 4.5 % self (it still folds each input key), so the cache was added.

**Cache design.** `read()` runs `SELECT key, value FROM settings` every call (cheap) and compares the rows with those behind the cached projection; equal means reuse. Any writer is seen, including `writeStoredValue` (hold, upload path) and other connections. The result is deep-frozen; `update` always projects from fresh rows. Tests: `test/settings/read-cache.test.ts`; `test/contract/settings-binding.ts` gained a Kelvin-sign nested key case.
