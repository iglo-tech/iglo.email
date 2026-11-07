# B31: event latency tail by cause

Host: the shared VM, Bun 1.4.4, `origin/main` at 1914155, command
`M61_WINDOW_MS=120000 bun test/perf/m61/mixed.ts mixed` under `measurement.lock`, one run at a
time. Raw result lines: [`B31-results.jsonl`](B31-results.jsonl); probe output of run A:
[`B31-probe-run-a.json`](B31-probe-run-a.json). Not CI thresholds.

**Every run was disturbed.** Load at start was 2.5 to 4.6 (the rule is below 2) because other
projects ran on the host, and all runs are 2 to 3 times slower than B11's quiet runs (event p50
5.7 ms, p95 23 ms). Shares below are for this loaded host; the disk part in particular grows with
host I/O load. No sleeping for quiet was done.

## Probe (opt-in, harness only)

`test/perf/m61/tail-probe.ts`, enabled by `M61_TAIL_PROBE=<dir>` in `mixed.ts`; `M61_CPU_PROF=<dir>`
runs the server under `bun --cpu-prof --cpu-prof-md` (Bun 1.4.4 has it; it works on the source
run, not the compiled executable). Both run the server from source (`bun src/main.ts`), not the
compiled build. Nothing under `src/` changed. The probe preloads into the server, brackets every
synchronous `bun:sqlite` call (`COMMIT` charged to the tables its transaction touched), `JSON.parse`
and `JSON.stringify`, and measures event-loop lateness with a 1 ms timer. Each late tick (8 ms or
more) is split among the bracketed work that overlapped it, the rest is "unbracketed". It records
only between SIGUSR1 and SIGUSR2 (the window). Limits: the `gc` performance observer reported no
entries in Bun 1.4.4, so GC is not separated (it is inside "unbracketed"); the cpu profile covers
the whole run including the 45 to 95 s seed, so the table below cuts the `.cpuprofile` to the
window (first to last event flush sample, 119 s).

## Results

Event acceptance latency (ms), 12,000 events, campaign 76.6 to 79.1/s:

| Run | Build                          | Load at start | p50 / p95 / p99 / max    |
| --- | ------------------------------ | ------------- | ------------------------ |
| A   | source + probe                 | 2.5           | 29.4 / 68.9 / 96.5 / 200 |
| B   | compiled, no probe (control)   | 4.4           | 26.8 / 58.8 / 75.0 / 177 |
| C   | source + `--cpu-prof`          | 4.6           | 33.2 / 70.0 / 92.1 / 207 |
| D   | compiled + settings experiment | 2.5           | 19.3 / 44.7 / 58.1 / 90  |
| E   | compiled + settings experiment | 3.9           | 19.8 / 43.5 / 54.3 / 100 |

The probe's own cost is within the spread of the control (A against B and C).

**Blocked time by cause (run A).** The loop was late (1 ms timer, 8 ms or more) for 101 s of a 131 s
window; timer lateness p50 was 11 ms, p95 39 ms.

| Cause                                                                 | Late time | Share |
| --------------------------------------------------------------------- | --------- | ----- |
| COMMIT (fsync wait), events transactions                              | 29.6 s    | 29 %  |
| COMMIT, outbox/send claims and outcomes                               | 11.4 s    | 11 %  |
| COMMIT, scheduler (`settings+enrollments`)                            | 5.2 s     | 5 %   |
| `JSON.parse` / `stringify`                                            | 4.9 s     | 5 %   |
| other SQL (settings reads, events insert, sequence evaluation, sends) | 7.0 s     | 7 %   |
| unbracketed (JS CPU, HTTP, render, SMTP, GC)                          | 42.7 s    | 42 %  |

Event writer split: the events transaction body (insert 1.5 s, sequence evaluation 1.6 s bracketed
over the window) is small; its `COMMIT` is 36.8 s of wall time over 7,678 commits (mean 4.8 ms, max
24 ms). So the event writer's cost is its fsync, not its own SQL or sequence evaluation. Savepoints
and `BEGIN` are 0.3 s.

**The unbracketed 42 % (run C, window).** Main-thread time by inclusive frame (frames overlap):

| Frame                                                        | Time   | Share of 119 s |
| ------------------------------------------------------------ | ------ | -------------- |
| `projectRaw` (`settings.read()`)                             | 45.1 s | 38 %           |
| of it `foldField` self time (`src/settings/validate.ts:126`) | 35.9 s | 30 %           |
| email / nodemailer                                           | 41.9 s | 35 %           |
| campaign runner                                              | 41.1 s | 35 %           |
| events `flush` (incl. commit wait)                           | 20.5 s | 17 %           |
| sequence scheduler                                           | 13.6 s | 11 %           |
| outbox                                                       | 11.9 s | 10 %           |
| template render                                              | 3.7 s  | 3 %            |

`settings.read()` rebuilds and validates every setting on each call (`bindFull`): for each stored
key it does `Object.keys(shapes).find(name => foldField(name) === foldField(key))`, which is
quadratic with two regex replaces per comparison. It is called per subscriber request, per
campaign message push (`main.ts` settings getter in `messaging/email.ts`), per scheduler decision
and so on: the probe counted its settings query 17,052 times in the 130 s window (201,848 is the
whole "other SQL" group, not settings reads), so each read costs about 2.6 to 2.8 ms of main-thread
time on this host. It is the single largest main-thread cost.

Commit labels are approximate: the probe charges each COMMIT to every table read since the last
commit, including reads outside a transaction (so scheduler commits show as
`settings+enrollments`), and COMMIT time includes WAL checkpoints run inside it, not only fsync.

## Experiment: precomputed fold map (not committed)

One change in `bindFull`: build a `Map` of folded shape names once per call instead of the nested
`find`. Same result (first matching shape wins). Compiled build, same command, two runs: event p50
19.3 and 19.8 ms against 26.8 to 33.2 (control B, C), p95 44.7 and 43.5 against 58.8 to 70.0, p99
58.1 and 54.3 against 75.0 to 92.1, max 90 and 100 against 177 to 207, tx accept p95 39 and 40
against 51 to 58, tx delivery p50 94 and 101 against 129 to 135. Campaign rate unchanged (79.1,
76.6 to 78.1). Both after-runs were disturbed like the controls; they are two samples, so the size
is indicative (about −35 % at p95), not a confirmed figure. A bigger fix (cache `read()` until the
settings table changes) would remove the rest.

This lives in `src/settings/` (not a module this task owns), so it is **not** in this PR.

## Outcome (D88)

- Two causes, roughly half and half of blocked time on this host: commit fsync waits (about 46 %,
  of which the events writer is 29 %), and main-thread CPU, of which the largest single item is
  `settings.read()` re-binding.
- The fsync part has no cheap fix: D86 keeps FULL, and moving writes off the main thread is a
  process-model change.
- The CPU part has a cheap fix outside `events`/`sequences`: `settings.read()` (follow-up B32).
- Nothing in `src/events` or `src/sequences` is the cause, so neither changes.
