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
