# B150b stream catch-up measurement (D171)

`test/sources/stream-measure.ts` measures the realtime stream catching up 100,000 events records
against the real PocketBase 0.40.5 binary. A first stream subscribes to one name (its marker is
set) and stops; PocketBase receives the records through its batch API (1,000 per request, one user,
small `data`); a second stream on the same database catches them all up and reaches live. The
handler is the contract's minimum: one write transaction per record holding only the stream's
dedupe entry, so the numbers are the stream's own cost plus one SQLite commit per record. Memory is
the process's RSS and JS heap, sampled every 50 ms; "before" is after a forced GC, with PocketBase
already holding the records.

**Setup.** 2026-11-25, `agents-workhorse-01` (Linux x86-64, 12 cores, 30 GB), Bun 1.4.5, source
run (not compiled), real clock. PocketBase's data directory under `/tmp` (tmpfs) in both runs; only
the iglo.email database directory changes. Database pragmas as in production (WAL,
`synchronous = FULL`). One run each; load average about 2.3 at the start of both (other workers
shared the host), 1.4 at the end.

| iglo.email database on | Catch-up | Records/s | RSS before → peak | Heap before → peak |
|---|---:|---:|---:|---:|
| `/tmp`, tmpfs | 6.2 s | 16,252 | 73.9 → 111.0 MiB | 6.2 → 27.0 MiB |
| `node_modules/.cache/`, xfs on NVMe (`/dev/nvme0n1p2`) | 550.5 s | 182 | 79.0 → 103.7 MiB | 5.9 → 24.8 MiB |

Creating the records took 15.3 s and 15.4 s. Both runs ended with 100,000 dedupe entries (all
records sit inside one lookback of the marker, so none was pruned) and no attention line.

**Reading.** Memory stays bounded: pages of 1,000 records are handled one record at a time and the
live buffer holds at most 4 MiB of text, so the peak heap is about 20 MiB over the baseline
whether 2,000 or 100,000 records are behind (a 2,000-record run on tmpfs peaked at 7.9 MiB heap,
79.8 MiB RSS). Throughput on disk is the commit: one `synchronous = FULL` transaction per record
costs about 5.5 ms on this disk, which the spec's "one record at a time, one transaction" asks for
(B150d's handler adds its writes to the same transaction, not more commits). A catch-up of 100,000
records therefore takes about nine minutes on this disk; live rates and a 30-minute reconnect's
backlog are far below that. Batching several records into one commit would be the change if a
backlog that size became routine; it is not made here (D171).

This is a bounded local experiment and sets no CI threshold. Run it with
`bun test/sources/stream-measure.ts <iglo-data-parent-dir> [count]`.

## B155b: the live path and the session signals (D177)

The paragraph above holds for the catch-up. On the live path, before B155b, each record took two
commits: the handler's transaction, then the marker move in a transaction of its own. Since D177
the marker move and the prune run inside the record's own transaction, so a live record takes one
commit too. The measurement now also times 2,000 records created while the stream is live, after
the catch-up (`liveRecords`, `liveSeconds`, `liveRecordsPerSecond`).

**Setup.** 2026-11-26, the same host, Bun 1.4.5, source run, real clock, 5,000 records. The
iglo.email database was under `$HOME` (xfs on NVMe, `/dev/nvme0n1p2`) and PocketBase in the
harness's tmpfs directory. Load average 3.2 at the start and 2.9 at the end (other workers shared
the host). Each tree ran once: "before" is an export of `origin/main` at 2c4b7e8 with the same
measurement script, "after" is this branch.

| Tree | Catch-up records/s | Live: 2,000 records | Live records/s |
|---|---:|---:|---:|
| before (`origin/main`) | 177 | 13.1 s | 152 |
| after (B155b) | 182 | 11.7 s | 171 |

An earlier 10,000-record pair measured catch-up only (before the live part was added): 180 and 179
records/s. The catch-up is unchanged and the live path is about 12% faster. It is not twice as
fast because a live record also waits for its realtime message and the handler's own commit; the
saved commit is the marker move.

**`AbortSignal.any` (item 4).** The stream makes a composite of a per-session (or per-pause)
controller and its long-lived `stopping` signal for each session. A standalone script built
360,000 such composites, each with an `abort` listener, aborting each controller and yielding every
1,000. After `Bun.gc(true)` the heap stayed 0.02 MiB over its baseline at 10,000, 60,000, 160,000
and 360,000. Bun releases them, so the stream keeps `AbortSignal.any`. A 30-minute reconnect makes
48 sessions a day.
