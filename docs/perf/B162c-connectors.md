# B162c: PocketBase vs iglo.base through their connectors (D190)

Catch-up throughput and a 10,000-recipient campaign with send-time lookups, run through each
connector (`connectors[name].create`, as production does) against its own release binary:
PocketBase 0.40.5 and iglo.base 1.3.0. The scripts are the B150b and B150e measurements with a
connector argument added (`pocketbase` is the default and runs exactly as before):

- `bun test/sources/stream-measure.ts <data-dir> 100000 <connector>`
- `bun test/sources/send-time-measure.ts <data-dir> 10000 source <connector>`

**Setup.** 2026-11-28, `agents-workhorse-01` (Linux x86-64, 12 cores, 30 GB), Bun 1.4.5, source run
(not compiled), real clock, branch `task/B162c-iglo-base-connector` (base 7cb2da83 plus this
change). Each binary's data directory is in the harness's temporary directory under
`TMPDIR=$HOME/b162c-acceptance/tmp` (xfs on NVMe, `/dev/nvme0n1p2`). The iglo.email database
directory is named per row. Database pragmas as in production. Load average 1.3 to 2.3 throughout
(other workers shared the host). Logs: `$HOME/b162c-acceptance/logs/measure-*.log`.

## Catch-up (100,000 events records)

A first stream sets its marker and stops; the binary gets the records through its batch API (1,000
per request); a second stream catches them all up, then 2,000 more records arrive live. One run per
row.

| iglo.email database on | Connector | Catch-up | Records/s | Live records/s | RSS before → peak | Heap before → peak |
|---|---|---:|---:|---:|---:|---:|
| xfs (`$HOME`) | pocketbase | 553.7 s | 181 | 173 | 70.0 → 105.3 MiB | 5.5 → 25.6 MiB |
| xfs (`$HOME`) | iglo.base | 552.4 s | 181 | 174 | 76.7 → 114.2 MiB | 5.5 → 26.8 MiB |
| tmpfs (`/tmp`) | pocketbase | 5.9 s | 17,018 | 3,080 | 74.5 → 111.2 MiB | 5.5 → 26.4 MiB |
| tmpfs (`/tmp`) | iglo.base | 4.5 s | 22,170 | 3,571 | 72.8 → 108.4 MiB | 5.5 → 23.1 MiB |

Creating the records took 16.8 s (PocketBase) and 15.9 s (iglo.base). Every run ended with 100,000
dedupe entries and no attention line.

**Reading.** On disk the commit per record (`synchronous = FULL`, about 5.5 ms here, B150b) decides
the rate, so the two connectors are equal. With the database on tmpfs the source's own share shows:
iglo.base serves catch-up pages about 30% faster than PocketBase. Memory is the same bound either
way (pages read one record at a time, the 4 MiB live buffer).

## A 10,000-recipient campaign with lookups

Every recipient is source-linked and read from the source per batch at send time (B150e); 1% of
the users are renamed first. The emailer is the runner fixture's stand-in, so the time is the
runner's: claims, source reads, renders, eligibility and progress writes. iglo.email database on xfs
(`$HOME`). Two runs each.

| Connector | Run | Time | Sent/s | Read p50 / p95 / max | Batch lookup p50 / p95 / max | RSS |
|---|---:|---:|---:|---:|---:|---:|
| pocketbase | 1 | 5.1 s | 1,947 | 0.7 / 1.3 / 60.3 ms | 15.1 / 18.0 / 76.9 ms | 216.5 MiB |
| pocketbase | 2 | 5.1 s | 1,944 | 0.7 / 1.3 / 53.6 ms | 15.1 / 18.0 / 71.1 ms | 206.6 MiB |
| iglo.base | 1 | 6.5 s | 1,530 | 1.4 / 6.3 / 59.2 ms | 29.1 / 34.3 / 99.2 ms | 289.0 MiB |
| iglo.base | 2 | 6.5 s | 1,541 | 1.3 / 5.4 / 59.2 ms | 28.4 / 36.3 / 101.1 ms | 217.6 MiB |

All 10,000 were sent once in every run, with no error.

**Reading.** A single recipient read by ID takes about twice as long on iglo.base (p50 1.3–1.4 ms
against 0.7 ms), so a 100-recipient batch's lookup takes about 29 ms against 15 ms and the campaign
runs at about 1,540 sends/s against 1,945. Both are far above the SES rates the queue plans for, so
the difference does not limit a send. The RSS of the first iglo.base run (289 MiB) did not repeat
(217.6 MiB in run 2) and is the process's, not the connector's: the connector holds no more state
for one binary than the other.

This is a bounded local experiment and sets no CI threshold. Nothing in the sending, scheduling or
storage paths changed in B162c: the PocketBase rows match B150b (182 records/s on disk, 16,252 on
tmpfs) and B150e (2,023 recipients/s on xfs, read p50 0.7 ms) within the noise of a shared host.
