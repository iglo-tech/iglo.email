# B149b: mixed load on the current build, and migration 34 in isolation

Required by B149b item 12 ([D165](../design/09-decisions.md#d165-dispatcher-ses-account-and-bounce-routing-hardening-b149b-lead-2026-11-25)), following the B141 review: re-measure the mixed load on an idle host with the data directory on disk and on tmpfs, and measure migration 34 (`idx_sends_due_kind`) on its own. Local observations on one host, not CI thresholds.

## Setup

- Host: native Linux x86-64, 12 cores, Bun 1.4.5. Four other B149 workers shared the host, so every run waited until the 1-minute load average was under 2 and recorded it (1.00 to 2.00, in the raw lines).
- Build: this branch's code at `8998d44` (B149b's code changes on `origin/main` `33d6a7b`), compiled with `bun run build`, executable SHA-256 prefix `44ec32c4c397db3e`.
- Filesystems: **disk** is `$HOME/scratch-b149b/disk`, xfs on NVMe; **tmpfs** is a directory under `/tmp`, an 8 GB tmpfs on this host.
- Raw lines: [`projects-B149b-mixed.jsonl`](projects-B149b-mixed.jsonl) and [`projects-B149b-due-kind.jsonl`](projects-B149b-due-kind.jsonl). Each result line follows a line naming its filesystem and load. The tmpfs mixed series was interrupted after run 2's `marketing` (a host service restart killed the background runner); `campaign` run 2 and run 3 of both modes were run again in the foreground and are marked `"rerun": true`.

## Mixed load, three projects at rate 14 (`test/perf/projects/mixed.ts`)

The B141 harness unchanged: project `a` runs a campaign to 2,000 readers; project `b` queues 600 async marketing sends (`marketing`) or runs its own campaign to 600 readers (`campaign`); the primary project makes a synchronous transactional call every 500 ms. Window 30 s. Latency is from the call to the sink's receipt. Three runs per cell; p50 and p99 are the medians of the runs.

| Filesystem | Mode | Tx p50 ms (runs) | Tx p99 ms (runs) | Receipts/s | Share main / a / b |
|---|---|---|---|---|---|
| disk | marketing | **45** (46, 43, 45) | **83** (80, 89, 83) | 13.8 | 60 / 0 / 355 |
| disk | campaign | **48** (47, 48, 49) | **75** (73, 75, 75) | 13.8 | 60 / 178 / 176 |
| tmpfs | marketing | **40** (42, 40, 39) | **74** (75, 74, 73) | 13.8 | 60 / 0 / 355 |
| tmpfs | campaign | **41** (39, 42, 41) | **76** (75, 76, 78) | 13.8–13.9 | 60 / 178–179 / 176–177 |

- The current build matches B141's table (p50 39–40 ms, p99 75 ms, 13.9 msg/s, the same shares) within a few milliseconds. B141 did not record its filesystem; these figures fit either.
- At rate 14 the filesystem barely matters: disk adds about 5 ms to the median and up to 10 ms to the p99 of one mode, the durable commits of the sync call's own send. The instance rate, not fsync, is the limit.
- Transactional p99 stays far inside the horizon plus one slot (2,071 ms, invariant 4).

## Migration 34 in isolation (`test/sends/measure-due-kind.ts`)

Two databases at the current schema (35) with 1,000,000 settled sends of both kinds over 300 days and 5,000 subscribers; in one, `idx_sends_due_kind` is dropped again, which is the claim path before migration 34 (only the older `idx_sends_due (status, next_attempt_at, id)`). Three repetitions. `claim`: 200 outbox claims of one kind (`claimBatch`, 10 rows, one write transaction each, synchronous=FULL) while 100,000 queued rows of the other kind wait. `writes`: 20,000 queued transactional sends inserted in one transaction, claimed by the outbox's claim and settled by `finishAll`, medians of the three. `migration`: 0034's own SQL on the filled database without the index.

| Filesystem | Index | Tx claim behind marketing, p50 / p99 ms | Marketing claim behind tx, p50 / p99 ms | Insert 20,000 ms | Claim 20,000 ms | Settle ms |
|---|---|---|---|---|---|---|
| disk | without (before 34) | 376 / 634 | 302 / 609 | 779 | 19,405 | 297 |
| disk | **with** | **7.1 / 17.1** | **7.3 / 17.5** | 420 | 15,312 | 189 |
| tmpfs | without (before 34) | 238 / 369 | 237 / 326 | 364 | 2,386 | 207 |
| tmpfs | **with** | **1.08 / 2.11** | **1.07 / 2.02** | 349 | 2,323 | 215 |

- **Claim latency.** Without the index a claim of one kind scans the other kind's backlog: 238 ms on tmpfs and 376 ms on disk per claim of 10 rows, so a 100,000-row marketing backlog would cap transactional claims at a few per second. With it, 1.1 ms on tmpfs and 7.1 ms on disk, where the disk figure is the claim's durable commit. The plan is `SEARCH sends USING COVERING INDEX idx_sends_due_kind (status=? AND kind=? AND next_attempt_at=?)`.
- **Write cost.** Not measurable above the spread: on tmpfs insert, claim and settle are within 4% either way; on disk the run with the index is faster in every phase, which is disk variance, not the index. A fourth index entry per row is small next to the per-commit fsync.
- **Migration.** `CREATE INDEX` on 1,100,000 rows took 1.4 s on disk and 1.2 s on tmpfs, and grew the file by 51 MB (about 47 bytes a row). It runs once, inside the upgrade's write transaction after the pre-migration snapshot.

## The on-disk async outbox

[projects-throughput-recheck](projects-throughput-recheck.md) measured the async outbox (`POST /api/tx` with `async`, rate 0) at about 120 msg/s with the data directory on disk and about 670 msg/s on tmpfs: each message is several durable commits, so it is fsync-bound. Campaigns batch their writes and reach about 1,500 msg/s on disk. D165 records why that is accepted.
