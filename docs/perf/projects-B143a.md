# B143a: idle cost of projects created at runtime

Projects can now be created while the server runs (`POST /api/instance/projects`,
[14-projects.md](../design/14-projects.md) section 10, D157). This compares their idle cost with
B138b's projects registered before the start ([projects-B138b.md](projects-B138b.md)). These are
local observations on one host, not CI thresholds. Nothing on the send path changed.

## Setup

- Host: `agents-workhorse-01`, Ubuntu 26.04, Linux 7.0.0-44 x86-64, AMD Ryzen 5 5600 (12 threads),
  30 GB RAM, native (D147). Bun 1.4.5.
- Before: `origin/main` at `9624c9a` (B139 merged), exported with `git archive`,
  `bun install --frozen-lockfile`, `bun run build`. After: this branch at `3960cd7` (the measured
  code; later commits change docs, tests and page markup only), `bun run build`. Both executables
  were copied to `$HOME/scratch-b143a` and run from there, with data directories there (ext4).
- **Load:** other workers' tests ran on the host throughout (load average 5.8 to 8.6). RSS is not
  affected by that; CPU time is the process's own (`/proc/<pid>/stat` user + system), which load
  inflates only through cache and scheduler contention. Every comparison below ran side by side, at
  the same time, so both sides saw the same load.
- Harnesses: `test/perf/projects/idle.ts` (B138b: projects registered in `instance.db` before the
  start) and the new `test/perf/projects/idle-runtime.ts` (a fresh install, then each extra project
  created through the instance API, timed; RSS five seconds after the last create; RSS and CPU over
  the idle minutes, also per minute).

## Results

Run A, four processes side by side, 10 idle minutes each:

| | Before, 1 project | Before, 10 registered | After, 10 registered | After, 10 created at runtime |
|---|---|---|---|---|
| RSS after start / after the creates | 81.6 MiB | 133.7 MiB | 131.6 MiB | 137.7 MiB (84.6 before the creates) |
| RSS after 10 idle min | 75.5 MiB | 124.4 MiB | 124.7 MiB | 126.8 MiB |
| CPU over 10 idle min | 0.60 s | 1.77 s | 1.73 s | 3.22 s |
| One create | | | | 406–442 ms |

An earlier pair of the same harness (after, 1 and 10 created at runtime, side by side): 1 project
82.7 → 79.0 MiB and 0.67 s; 10 projects 136.8 → 125.9 MiB and 3.70 s; creates 397–420 ms.

Run B, alone (other workers still loaded the host), 10 created at runtime, 15 idle minutes:
136.3 → 128.2 MiB, 4.55 s, CPU per minute
`0.33, 0.27, 0.26, 0.26, 0.30, 0.46, 0.43, 0.38, 0.33, 0.27, 0.26, 0.25, 0.27, 0.24, 0.24` s.

## Reading

- **No change for projects registered before the start:** 10 projects idle the same on both sides
  (1.77 s and 1.73 s, RSS within 2 MiB). The request counter and the instance log buffer cost
  nothing measurable.
- **RSS of a runtime-created project:** (137.7 − 84.6) / 9 = 5.9 MiB each, the same as B138b's
  5.8 MiB per registered project, well under the 15 MB to investigate. Growth is linear.
- **Create time:** about 420 ms per project: its migrations, the fresh-install seed and the admin's
  copy, the same work B138b measured as about 440 ms of startup per fresh project. Creates run one
  at a time (D157); requests to other projects are served meanwhile.
- **Idle CPU of runtime-created projects is higher:** about 0.26 s per minute for ten (0.4% of one
  core), against about 0.17 s for ten registered before the start. Run B shows it flat over 15
  minutes, so it is a steady cost and nothing spins. Not investigated further here; a likely cause
  (unverified) is that loops started one project at a time keep their timers apart, where loops
  started together share wake-ups. A restart wires every project at start, as registered ones are.
- Compared with B138b's figures (0.45 s for 1 project, 1.19 s for 10 over 10 minutes), today's
  before side is already higher (0.60 s, 1.77 s) with B139 merged and under this host's load; the
  side-by-side columns above are the comparison that holds load equal.
