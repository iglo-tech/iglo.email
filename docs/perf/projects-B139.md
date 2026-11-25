# B139: settings split, before and after

The instance keys move to `instance.db`, and a project's settings read becomes its own rows plus the
one instance reader's value ([14-projects.md](../design/14-projects.md) section 4; D154). The send
path reads SMTP and the send rate through that read, so the B138b throughput method is repeated.
These are local observations on one host, not CI thresholds.

## Setup

- Host: `agents-workhorse-01`, Ubuntu 26.04, Linux 7.0.0-44 x86-64, AMD Ryzen 5 5600 (12 threads),
  30 GB RAM, native (D147). Bun 1.4.5. Load average 0.2 at the start.
- Before: `origin/main` at `4251567`, exported with `git archive`, `bun install --frozen-lockfile`,
  `bun run build`. After: this branch's working tree with the code under review, `bun run build`.
  Both executables were copied aside and run from there.
- Data directories under `$HOME/scratch-b139` (ext4, not tmpfs). Mail goes to a loopback sink.
- Harness: `test/perf/projects/throughput.ts` (B138b). Since B139 it sets its keys through
  `/api/instance/settings` with the admin's session when the build serves it, else through
  `/api/settings`, so the same script measures both sides.

## Outbox and campaign throughput (one project)

`MEASURE_DIR=$HOME/scratch-b139 bun test/perf/projects/throughput.ts <executable> <label>`: a fresh
data directory per run, `messaging.max_send_rate` 0, campaign pacing out of the way, SMTP
`max_conns` 10; 2,000 async `POST /api/tx` (50 in flight), then one campaign to 5,000 subscribers.
Three runs per side, alternating the order each round:

| Round | Before: outbox msg/s, campaign msg/s | After: outbox msg/s, campaign msg/s |
|---|---|---|
| 1 | 124.7, 1658.1 | 123.9, 1629.6 |
| 2 | 120.7, 1651.2 | 124.1, 1617.3 |
| 3 | 123.9, 1690.3 | 123.9, 1631.6 |
| **median** | **123.9, 1658.1** | **123.9, 1629.6** |

Outbox: unchanged. Campaign: −1.7%, inside the 5% gate; every after run (1617–1632) was below
every before run (1651–1690), so it is a small real cost, not noise. A campaign batch reads its settings more often than the outbox does, and
each read now runs two short queries (the project's rows, then instance.db's) where it ran one; the
rows read are the same in number. The instance reader could cache until its own write and save the
second query, but a write by another connection would then go unseen (D88), so it keeps the
re-read (D154).

## Not measured here

- Idle cost: the split adds one table to instance.db and no loop; B138b's idle figures stand.
- Mixed load across projects: it needs the dispatcher (B141).
