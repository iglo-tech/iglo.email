# B144a: backup per project and instance, before and after

`backup` with no flag now snapshots `instance.db` and every registered project into one directory
([14-projects.md](../design/14-projects.md) section 12; D158). Each database keeps the M6.2 method
(read-only source, `VACUUM INTO` with the sync helper, sealed hold, integrity check), so the cost per
database is unchanged and a whole backup adds one such pass for `instance.db` and one per project.
These are local observations on one host, not CI thresholds.

## Setup

- Host: `agents-workhorse-01`, Ubuntu 26.04, Linux 7.0.0-44 x86-64, AMD Ryzen 5 5600 (12 threads),
  30 GB RAM, native (D147). Bun 1.4.5. Other task workers were running on the host (load average
  2.7 at the start, 4.6 at the end), so single runs vary by about ±25%.
- Before: `origin/main` at `9624c9a`, exported with `git archive`, `bun install --frozen-lockfile`,
  `bun run build`. After: this branch's working tree, `bun run build`. Both executables were copied
  aside and run from there.
- Data directories under `$HOME/scratch-b144a` (ext4, not tmpfs).
- Harness: `MEASURE_DIR=$HOME/scratch-b144a bun test/perf/projects/backup.ts <executable> <label>
  300000 3`. The server is started once to create the schemas and stopped; subscribers are then
  written directly. Each run is `backup --data-dir <dir> --output <fresh path>` with no other flag,
  timed from spawn to exit; peak RSS is the child's `VmHWM`, sampled every 5 ms.
  - **one:** the primary project with 300,000 subscribers.
  - **ten:** the primary and nine more projects, 1,000 subscribers each. Before copies only the
    primary (main's `backup` acts on it, D151); after copies `instance.db` and all ten projects.
- Order: before, after, after, before; three runs each.

## Results

| Shape | Side | Seconds (runs) | Peak RSS MiB (runs) |
|---|---|---|---|
| one | before | 2.16, 2.28, 2.30 / 1.64, 1.66, 1.68 | 89.3, 89.3, 90.2 / 88.9, 89.1, 88.4 |
| one | after | 2.05, 2.19, 2.59 / 1.92, 1.97, 1.80 | 88.2, 90.1, 87.9 / 90.4, 89.8, 89.7 |
| ten | before (primary only) | 0.22, 0.24, 0.24 / 0.18, 0.17, 0.18 | 88.6, 88.6, 88.8 / 87.9, 87.4, 86.8 |
| ten | after (11 databases) | 0.80, 0.76, 0.74 / 0.74, 0.74, 0.75 | 89.6, 90.2, 89.1 / 88.5, 89.4, 90.5 |

## Reading

- **One project of 300,000 subscribers:** median 1.92 s before and 2.01 s after, inside the run-to-run
  spread of this loaded host. The added `instance.db` snapshot is small next to the project's. Peak RSS is
  87–90 MiB on both sides: snapshots are written one at a time, so memory does not grow with the
  number of databases.
- **Ten small projects:** 0.75 s for eleven databases, about 55 ms per database, mostly the sync
  helper's spawn and the fsyncs of each snapshot, its manifest and its folders. Before took 0.2 s
  because it copied only the primary. Peak RSS is unchanged.
- The server's commit latency during a backup is not re-measured: each database is still read the
  way M6.2 measured (`docs/perf/M6.2-backup.md`), one after the other.
