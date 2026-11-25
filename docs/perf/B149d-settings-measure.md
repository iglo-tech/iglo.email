# B149d settings measurement sample (D167)

`test/settings/measure.ts` is M1.2's settings workload ([M1.2-settings.md](M1.2-settings.md)). Since
B139 (D154) split the keys, the script's settings calls went through the contract router
(`test/contract/settings-split.ts`), whose full `PUT /api/settings` reads the project half back with
an extra `GET` (to restore it if the instance refuses its half) before the two writes. The B139 r2
review found that the "Full settings PUT" sample therefore timed a `GET` the M1.2 sample never made.

**Change.** The full-PUT sample now sends the two halves' writes directly: the project keys to
`PUT /api/settings` with the API credential and the instance keys to `PUT /api/instance/settings`
with an instance session made before the sample. No `GET` and no login is inside it. It measures the
writes one M1.2 `PUT` made, as two requests. The other samples are unchanged.

**Setup.** 2026-11-25, `agents-workhorse-01` (Linux x86-64, 12 cores), Bun 1.4.5, compiled
`dist/iglo.email` built from this branch, data directories under `/tmp` (tmpfs). Other B149 workers
shared the host (load average about 1.1 at the start). Three repetitions each, a new process and data
directory per repetition; 20 samples after five warmups, as before. Means in milliseconds.

| Full settings PUT sample | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| Before (router: `GET` + two writes), `origin/main` script | 1.865 | 1.863 | 1.907 |
| After (two direct writes) | 1.474 | 1.509 | 1.530 |

The other samples of the same runs (after): settings `GET` 0.58 ms, per-key `PUT` 0.45–0.47 ms,
restart and `GET` 357–358 ms.

**Baseline.** The "after" row is the new baseline for the full-PUT sample. It is not comparable with
M1.2's 3.06–3.11 ms: that ran on another host (ext4 disk, Bun 1.4.4), with one settings table and one
request. A later change compares with this row on the same setup. This is a bounded local experiment
and sets no CI threshold.
