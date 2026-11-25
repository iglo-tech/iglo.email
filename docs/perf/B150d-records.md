# B150d record handler measurement (D173)

`test/sources/records-measure.ts` measures records per second through the record handler
(`src/sources/records.ts`) in a catch-up against the real PocketBase 0.40.5 binary. A first stream
subscribes (its marker is set) and stops; PocketBase receives 10,000 events records over 100 users
through its batch API; a second stream on the same database catches them all up through the full
handler and reaches live. The project has one grant rule naming the records' event and one active
external sequence on it (`reentry: always`, a transactional step one day out), so every record does
the whole path: the strict trigger match, the recipient-view read (one HTTP request), and one write
transaction with the subscriber upsert (an update after each user's first record), the grant, the
exit of the user's running enrollment, the new enrollment and the dedupe entry. Memory is the
process's RSS and JS heap sampled every 50 ms; "before" is after a forced GC with PocketBase
already holding the records.

**Setup.** 2026-11-25, `agents-workhorse-01` (Linux x86-64, 12 cores, 30 GB), Bun 1.4.5, source run
(not compiled). PocketBase's data directory under `/tmp` (tmpfs) in both runs; only the iglo.email
database directory changes. Database pragmas as in production (WAL, `synchronous = FULL`). One run
each; load average 1.4 to 2.0 during the runs (other sessions shared the host).

| iglo.email database on | Catch-up | Records/s | RSS before → peak | Heap before → peak |
|---|---:|---:|---:|---:|
| `/tmp`, tmpfs | 5.4 s | 1,856 | 87.4 → 118.2 MiB | 12.0 → 17.8 MiB |
| `node_modules/.cache/`, xfs on NVMe (`/dev/nvme0n1p2`) | 60.8 s | 164 | 87.4 → 97.4 MiB | 12.0 → 14.6 MiB |

Creating the records took 1.5 s in both runs. Both ended with 100 active enrollments (one per user:
each record replaced the user's previous one), no retry-queue row and no attention line.

**Reading.** On disk the commit dominates, as in B150b: B150b's minimal handler (only the dedupe
entry in its transaction) caught up 182 records/s on the same disk, and the full handler 164, so the
handler's writes add about 10 % to a commit of about 5.5 ms. On tmpfs the per-record recipient read
dominates (B150b's minimal handler did 16,252 records/s there; one loopback request per record
brings it to 1,856). Memory stays bounded: records are handled one at a time from pages of 1,000,
and the handler keeps nothing per record. A smaller run (500 records over 20 users, tmpfs) did
1,457 records/s.

Live rates are far below either number; a backlog after a long outage is handled at the disk's
commit rate. Batching several records into one commit is still the change if such backlogs became
routine (D171); it is not made here.

This is a bounded local experiment and sets no CI threshold. Run it with
`bun test/sources/records-measure.ts <iglo-data-parent-dir> [count] [users]`.
