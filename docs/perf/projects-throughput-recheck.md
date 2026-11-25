# Outbox throughput recheck after B143b

Question: has outbox throughput regressed on `main`? The B141 ([projects-B141](projects-B141.md))
and B145b ([projects-B145b](projects-B145b.md)) series measured about 520–560 msg/s. The B143b
series ([projects-B143b](projects-B143b.md)) measured about 119 msg/s on both `main` and its
branch. Local observations on one host, not CI thresholds.

**Verdict: no regression.** All four builds below measure the same throughput, within 1–2%. The
difference between 520 and 119 msg/s comes from where the data directory is stored, not from the
code.

## Setup

- Host: native Linux x86-64, 12 threads, Bun 1.4.5. No other worker ran tests. The 1-minute load
  average was recorded before every run (in the raw lines) and was 0.43 to 1.45.
- Builds: each SHA was unpacked with `git archive` under `node_modules/.cache/recheck/<sha>` and
  compiled with `bun run build`. Executable SHA-256 prefixes:
  - `e9a65b8` (`origin/main`, B143b merged): `2f3f884e0a71fb2f`
  - `77fafdf` (B141 and B145a merged): `d60640604134187d`
  - `60373c4` (B145b merged): `c7b5d4eab2d8f4f7`
  - `93498a4` (B143a merged): `ac831508fe3b972f`
- Harness: `bun test/perf/projects/throughput.ts <executable> <sha>` with the B141 defaults:
  `messaging.max_send_rate` 0, 2,000 async `POST /api/tx`, then one campaign to 5,000
  subscribers, a loopback sink and HTTP only. The script is the same at all four SHAs.
- Order: three rounds, alternated as `e9a65b8 77fafdf 60373c4 93498a4`, then the reverse, then
  the forward order again.
- Two data-directory locations (the script's `MEASURE_DIR`):
  - **disk**: the script's default, `$HOME/scratch-b138b`, on xfs on NVMe.
  - **tmpfs**: a directory under `/tmp`, which is a tmpfs on this host.
- Raw lines: [`projects-throughput-recheck-disk.jsonl`](projects-throughput-recheck-disk.jsonl)
  and [`projects-throughput-recheck-tmpfs.jsonl`](projects-throughput-recheck-tmpfs.jsonl).

## Results

| SHA | Disk outbox msg/s (runs) | Disk median | tmpfs outbox msg/s (runs) | tmpfs median |
|---|---|---:|---|---:|
| `e9a65b8` (main) | 121.8, 121.6, 121.2 | **121.6** | 665.4, 661.6, 670.3 | **665.4** |
| `77fafdf` | 121.6, 120.4, 122.1 | **121.6** | 646.0, 676.9, 671.9 | **671.9** |
| `60373c4` | 121.8, 122.1, 121.7 | **121.8** | 673.7, 673.5, 668.1 | **673.5** |
| `93498a4` | 121.7, 122.2, 121.2 | **121.7** | 666.4, 675.7, 672.2 | **672.2** |

- Compared with `77fafdf`, `main` is 0.0% different on disk and −1.0% on tmpfs. That is inside the
  run-to-run spread and well under the 10% bisection threshold, so no bisection was run.
- Campaign throughput is also flat. It was 1,514–1,548 msg/s on disk and 1,817–1,887 msg/s on
  tmpfs for every SHA.

## Why 119 versus 520

- **The parameters are the same.** B143b used the same script (`test/perf/projects/throughput.ts`)
  and the same workload as B141: rate 0, 2,000 tx and 5,000 recipients. The settings do not
  explain the gap.
- **The outbox is limited by fsync.** On disk, every build takes about 8.2 ms per message
  (2,000 messages in 16.4 s). A `dd oflag=dsync` run of 4 KiB writes to the same directory took
  about 5.3 ms per write. The outbox writes `sends` several times per message and commits each
  write durably. On tmpfs the fsync costs nothing, so the same code reaches about 670 msg/s. The
  campaign path claims recipients in batches, so it loses only about 18% on disk.
- **B143b's ~119 msg/s matches the disk figure.** It ran the script with its default data
  directory, which is on disk.
- **B145b's ~521 msg/s matches tmpfs.** Its harness (`guard-throughput.ts`) creates the data
  directory with `mkdtemp(os.tmpdir())`, which is `/tmp` and therefore a tmpfs.
- **B141's ~548 msg/s also matches tmpfs, but this is an inference.** B141 used the same
  `throughput.ts` and recorded load averages of 4–8, but it did not record where its data
  directory was. 548 msg/s cannot be reached on this disk by any of the four builds, so B141 most
  likely ran with `MEASURE_DIR` on `/tmp`.

## Note for future measurements

A throughput figure is comparable with another only if both used the same data-directory
filesystem. Record that filesystem in every throughput report. It might also be worth having
`throughput.ts` print it in each JSON line, but this change leaves the script as it is.

The disk figure reflects production, which runs on a real disk. If its ~120 msg/s for async
transactional and marketing sends from one instance is too low, that is a design question about
committing durably per message. It is not a regression.
