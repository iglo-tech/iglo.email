# B150e send-time lookups (D174)

`test/sources/send-time-measure.ts` runs one campaign to 10,000 recipients through the campaign
runner (`src/campaigns/runner/runner.ts`). The runner fixture's emailer stands in for the
dispatcher and accepts each push at once, so the time measured is the runner's own: claims, source
reads, renders, eligibility checks and progress writes. Batches are `MAX_CLAIM` (100) recipients.

- **`source`:** every recipient is source-linked (an `external_id`) and read from the real PocketBase
  0.40.5 binary before its batch renders, at most `SOURCE_LOOKUPS` (8) reads at a time. 1 % of the
  users are renamed in the source first, so 100 of the batches also write one name change each.
  The recipients "view" is a plain PocketBase collection: 10,000 auth records would each hash a
  password. A read is the same `GET /api/collections/<view>/records/<id>` either way.
- **`none`:** no source, no `external_id`. This is the existing path. The same script runs it on an
  export of `origin/main` (cc0e1a9) as the "before" figure.

"Batch lookup" is the time from a batch's first read to its last read or write. That is the delay
B150e adds before the batch renders. "Read" is one recipients-view request.

**Setup.** 2026-11-25, `agents-workhorse-01` (Linux x86-64, 12 cores, 30 GB), Bun 1.4.5, run from
source (not compiled). PocketBase's data directory is under `/tmp` (tmpfs) in every run; only the
iglo.email database directory changes. Database pragmas are as in production (WAL,
`synchronous = FULL`). Load average was 1.1 to 1.5. The source runs were made twice; the
no-source runs twice on each head.

| Database on | Head | Mode | Campaign | Recipients/s | Read p50 / p95 / max | Batch lookup p50 / p95 / max |
|---|---|---|---:|---:|---:|---:|
| tmpfs (`/tmp`) | `origin/main` | none | 2.1 s | 4,696 / 4,686 | – | – |
| tmpfs (`/tmp`) | B150e | none | 2.1 s | 4,702 / 4,688 | – | – |
| tmpfs (`/tmp`) | B150e | source | 3.3 / 3.2 s | 3,065 / 3,112 | 0.6 / 1.0 / 51 ms | 8.7 / 10.4 / 62 ms |
| xfs on NVMe | `origin/main` | none | 3.3 s | 3,007 / 2,969 | – | – |
| xfs on NVMe | B150e | none | 3.3 s | 3,025 / 3,020 | – | – |
| xfs on NVMe | B150e | source | 4.9 / 4.9 s | 2,023 / 2,021 | 0.7 / 1.1 / 56 ms | 14.3 / 18.9 / 74 ms |

The maxima are each run's first read, which signs in the service account. Every run sent 10,000
with no error and no attention line. RSS at the end was 199 to 236 MiB in every mode; the fixture
holds the whole campaign's pushes in memory.

**Reading.**

- **No source: no regression.** Without a source the runner does what it did before: one
  `sendTime` check per batch, which returns at once when no recipient has an `external_id`, or
  when the project has no source. The two heads are within 1 % on both filesystems.
- **With lookups:** 100 reads per batch, 8 at a time, cost 9 ms on
  tmpfs and 14 ms on disk per batch of 100. On disk the extra time is the rename commits: one short
  write transaction per changed recipient. Unchanged recipients write nothing. Whole-campaign
  throughput drops by about a third, to 2,000 to 3,100 recipients a second. That is still far
  above any SES send rate this runs at: the dispatcher's rate, typically 14 to a few hundred a
  second, sets the pace, and a batch's grant covers a 2 s horizon.
- **A remote source** adds its round trip to each read: at 30 ms, a batch's reads take about
  100 / 8 × 30 ms ≈ 0.4 s, within the grant's horizon. The lease is renewed while the reads run.
- **Memory** stays bounded by the batch: the plans of one batch (at most 100) are kept, and nothing
  per recipient outlives it.

Sequence steps read one subscriber per step, on the scheduler's existing per-enrollment path, so
the step's added cost is one read (plus a short write when something changed). There is no batch
to measure there. B150c measured a single source condition at about 0.1 s against the same binary.

This is a bounded local experiment and sets no CI threshold. Run it with
`bun test/sources/send-time-measure.ts <iglo-data-parent-dir> [count] [source|none]`.
