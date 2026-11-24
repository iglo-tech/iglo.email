# B138b: instance and routing, before and after

The data directory becomes an instance (`instance.db`, `projects/<slug>/`) and one server routes by
`Host` ([14-projects.md](../design/14-projects.md) sections 1–3, 16; D151). These are local
observations on one host, not CI thresholds.

## Setup

- Host: `agents-workhorse-01`, Ubuntu 26.04, Linux 7.0.0-44 x86-64, AMD Ryzen 5 5600 (12 threads),
  30 GB RAM, native (D147). Bun 1.4.5.
- Before: `origin/main` at `7d48da5`, exported with `git archive`, `bun install --frozen-lockfile`,
  `bun run build`. After: this branch at `133b4ac` (the measured code; later commits change docs
  and tests only), `bun run build`. Both executables were copied aside and run from there.
- Data directories under `$HOME/scratch-b138b` (ext4, not tmpfs). Mail goes to a loopback sink.
- Harnesses, both committed: `test/perf/projects/throughput.ts` and `test/perf/projects/idle.ts`.
  They talk to the compiled executable over HTTP only, so the same script measures both sides.

## Outbox and campaign throughput (one project)

`bun test/perf/projects/throughput.ts <executable> <label>`: a fresh data directory per run,
`messaging.max_send_rate` 0 (no cap), campaign pacing out of the way (`app.concurrency` 10,
`app.message_rate` 100,000, no sliding window), SMTP `max_conns` 10.

- **Outbox:** 2,000 async `POST /api/tx` (50 in flight), from the first request to the 2,000th
  message the sink receives. This is the method the B138a review asked for: the compiled executable,
  through `main()`, exercising the outbox.
- **Campaign:** one regular campaign to 5,000 subscribers, from `PUT …/status running` to the last
  message.

Six runs per side, alternating the order each round (main first in odd rounds, branch first in even):

| Round | Before: outbox msg/s, campaign msg/s | After: outbox msg/s, campaign msg/s |
|---|---|---|
| 1 | 124.5, 1639.2 | 120.9, 1644.2 |
| 2 | 123.8, 1662.8 | 124.0, 1669.6 |
| 3 | 124.0, 1623.8 | 124.7, 1635.9 |
| 4 | 124.6, 1670.3 | 124.6, 1650.3 |
| 5 | 125.1, 1664.0 | 124.4, 1676.5 |
| 6 | 123.1, 1670.2 | 124.7, 1628.9 |
| **median** | **124.3, 1663.4** | **124.5, 1647.3** |

Outbox: +0.2%. Campaign: −1.0%, inside the per-run spread on both sides (1624–1670 before,
1629–1677 after) and inside the 5% gate. The outbox rate is the same ~124 msg/s on both sides; it
is bound by the outbox's own claim and push cycle, which this change does not touch.

## Idle cost at 1 and 10 projects

`bun test/perf/projects/idle.ts <executable> <label> <projects> 10`: a fresh data directory; with 10
projects, the primary plus nine registered through `src/projects` before the start. Startup is spawn
to the first `/health` answer; RSS is `VmRSS` five seconds after it and after 10 idle minutes; CPU is
the process's user + system time over those 10 minutes (`/proc/<pid>/stat`). The three 10-minute runs
ran side by side; the startup figures are three sequential runs each, nothing else running.

| | Before, 1 project | After, 1 project | After, 10 projects |
|---|---|---|---|
| Startup (3 runs) | 585, 584, 585 ms | 610, 613, 610 ms | 4576, 4562, 4571 ms |
| RSS after start | 80.1 MiB | 80.9 MiB | 133.4 MiB |
| RSS after 10 idle min | 74.5 MiB | 77.5 MiB | 124.4 MiB |
| CPU over 10 idle min | 0.46 s | 0.45 s | 1.19 s |

- **One project** costs what it did: +25 ms of startup (creating and migrating `instance.db`), RSS
  within a megabyte, the same idle CPU.
- **Ten projects:** each extra project adds about 5.8 MiB RSS after start ((133.4 − 80.9) / 9), well
  under the 15 MB to investigate, and about 0.08 s of CPU per 10 idle minutes. Growth is linear and
  nothing spins: idle CPU is 0.2% of one core for ten projects.
- **Startup** grows by about 440 ms per fresh project: each new project database runs its 31
  migrations and seeds its templates, in sequence, before the bind (B52). A restart of an existing
  instance skips the migrations.

## Not measured here

- Mixed load across projects (section 16): it needs the dispatcher (B141).
- RSS under load with many projects: the shared budgets (D151) bound the helper children and the
  attachment memory; the analytics egress budget is still per project (D151, left for later).
