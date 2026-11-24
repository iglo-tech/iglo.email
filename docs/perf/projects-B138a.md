# B138a: composition extraction, before and after

Behaviour-neutral change: `main()`'s wiring moves into `createProject` (`src/projects/compose.ts`), with
the same statements in the same order. Design: [14-projects.md](../design/14-projects.md) section 3 and
section 16. These are local observations on one host, not CI thresholds.

## Setup

- Host: one macOS workstation running OrbStack; every run inside the same Linux arm64 container
  (`oven/bun:1.4.5`, Bun 1.4.5, 8 vCPU, 8 GiB visible to the container). Nothing else was run in
  parallel with a measurement.
- Before: `origin/main` at `9e1281ff`. After: this branch at `d7ac85ba`. Each side was exported
  with `git archive` into a scratch directory, installed with `bun install --frozen-lockfile`, and built
  with `bun run build`. The scratch copies were then given their own repository so the harness can read
  tracked files (`git ls-files`); those scratch commit IDs are not the source commits above.
- Rounds 1 to 3 alternated the order (before, after / after, before / before, after) to limit drift.
- Campaign and outbox data directories were on the container's own filesystem (`/var/tmp`), not the
  shared bind mount.

## Results

Campaign throughput, `bun test/campaigns/runner/measure.ts limits` (10,000 eligible subscribers, rate 10
times concurrency 5, sliding window 2,500 a minute), against the compiled executable:

| Round | Before (`elapsedSeconds`, msg/s) | After (`elapsedSeconds`, msg/s) |
|---|---|---|
| 1 | 747.8, 13.37 | 793.2, 12.60 |
| 2 | 744.2, 13.44 | 744.6, 13.43 |
| 3 | 768.5, 13.01 | 769.6, 12.99 |
| mean | 753.5, **13.27** | 769.1, **13.01** |

Mean throughput is 2.0% lower on the branch, inside the 5% gate, and the per-run spread (12.6 to 13.4
msg/s) is larger than the difference.

Start-up and RSS, `startup.ts` probe (scratch, not committed): a fresh data directory per run; time from
spawn to the first `/health` answer, and `VmRSS` five seconds after that answer.

| Round | Before: health, RSS | After: health, RSS |
|---|---|---|
| 1 | 2444 ms, 93160 KB | 727 ms, 93392 KB |
| 2 | 1255 ms, 93144 KB | 573 ms, 93896 KB |
| 3 | 846 ms, 93216 KB | 461 ms, 94952 KB |
| mean | 1515 ms, 90.99 MiB | 587 ms, 91.88 MiB |

Median start-up is 573 ms on the branch against 1255 ms on main. The first main run was the slowest of the
six, probably a cold cache; this is not verified. Three rounds are too few to call the start-up
difference real. RSS after start is +0.9 MiB (+1.0%) on the branch, inside the 5% gate. The one-project
idle cost in 14-projects section 16 is not measured here.

Outbox throughput, `bun test/perf/m61/outbox.ts 10000 1` (`outbox-backlog`: 10,000 queued marketing
sends and 1,000 transactional sends, overall messages/s; `outbox-no-backlog`: 1,000 transactional sends):

| Round | Before, backlog / no backlog | After, backlog / no backlog |
|---|---|---|
| 1 | 369.3 / 80.3 | 118.8 / 98.6 |
| 2 | 225.4 / 332 | 789.0 / 226.8 |
| 3 | 493.8 / 710.1 | 809.3 / 682.0 |

**Inconclusive.** Within one side the same workload varies by up to about 9 times (80 to 710 msg/s for the
no-backlog run), so these three rounds cannot show a 5% difference either way. This harness also builds
the outbox from `test/scheduler/runtime.ts` rather than from `main()`, so it does not exercise the wiring
this task changes. The outbox code and its signatures are unchanged by this task. A quiet-host
measurement through the compiled executable is the follow-up if the outbox needs a number.

## Known pre-existing result

Every campaign run on **both** sides fails the harness's own assertion `to.length === 10_000`: the sink
receives 10,020 messages, 20 more than the 10,000 eligible, and `onlyEligible` is false. The record is
written before the assertion, so the numbers above are the measured values. This is the same on
`origin/main` and on this branch, so it is not caused by this change. Which 20 addresses receive the
extra mail was not recorded by the harness; it is not investigated here and is reported to the lead as
a separate finding.

## Not measured

- Mixed load with three projects, the idle cost at 10 projects and the 10-minute idle CPU run in
  section 16. Those need the instance and multi-project work of B138b and later.
