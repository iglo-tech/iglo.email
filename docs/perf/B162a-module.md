# B162a: idle cost of the sources module

[D188](../design/09-decisions.md#d188-the-sources-module-switch-and-the-connector-list-b162a-lead-2026-11-27).
Measured 2026-11-27 on `agents-workhorse-01` (Linux x86-64, 12 cores, Bun 1.4.5) with
`bun test/sources/module-measure.ts [off|none|connected]`.

**Method.** One in-process instance serves 20 projects on an injected clock. After 30 s of clock
time to settle, the script moves the clock through 10 minutes in 1-second steps and records:

- the clock timers started in that window (every loop waits on `clock.sleep`),
- the timers still pending at the end, by length (ms × count),
- RSS after a full GC, and the CPU time used in the window.

Scenarios:

- `off`: `sources.enabled` false. This build only.
- `none`: on (main has no switch), no project with a source.
- `connected`: on, every project reading one real PocketBase 0.40.5 through the
  fixture schema with a leaving filter.

Two runs each. RSS and CPU vary from run to run by about ±20 MiB and ±50 ms. The timer counts do not
vary, apart from the realtime idle timers (330 s) of streams that are mid-reconnect.

## Before (main 29ee2455)

| Scenario | Timers started | Pending at end | RSS MiB | CPU ms |
|---|---|---|---|---|
| none | 52,202 / 52,202 | 1 s×80, 5 s×20, **15 s×40**, 60 s×20, 300 s×1, 3,600 s×20 | 235.9 / 235.6 | 1,472 / 1,457 |
| connected | 54,640 / 54,634 | as none, 15 s×80 / 81, 330 s×13 / 15 | 249.5 / 284.3 | 1,732 / 1,714 |

## After (this branch)

| Scenario | Timers started | Pending at end | RSS MiB | CPU ms |
|---|---|---|---|---|
| off | **51,402 / 51,402** | 1 s×80, 5 s×20, **15 s×20**, 60 s×20, 300 s×1, 3,600 s×20 | 249.9 / 253.4 | 1,511 / 1,501 |
| none (on, no connector) | 52,202 / 52,202 | as main's none | 255.8 / 241.8 | 1,549 / 1,600 |
| connected | 54,586 / 54,486 | as main's connected, 15 s×80 / 81, 330 s×14 / 17 | 284.1 / 254.4 | 1,766 / 1,787 |

## Reading

- **Off starts no source loop or timer.** With the module off, 20 fewer 15 s timers are pending: the
  records stream's settings watch (`TOPIC_CHECK_MS`), one per project. Off also starts 800 fewer
  timers in 10 minutes (20 projects × 40 checks). The watch waits for a settings change instead of
  a timer. The 20 remaining 15 s timers belong to other loops, not to sources.
- **On with no connector costs what main without a source cost**, timer for timer.
- **Connected is unchanged.** Its extra timers per project are the stream's retry loop (15 s), its
  topic check and its realtime idle timer: the same counts as main.
- RSS and CPU per project differ by less than the noise between runs (about 1 MiB and 2 ms of CPU
  per project over 10 minutes in every scenario).
- **The r1 held check is not measured.** It reads the project's settings once per campaign batch or
  sequence step, and only for a batch with source-linked recipients or a step to a source-linked
  subscriber, right next to the source's own HTTP read, which dominates that path; r2's per-read
  check adds the same settings read only when the source is already missing.
