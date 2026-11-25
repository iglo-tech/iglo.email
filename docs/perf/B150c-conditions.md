# B150c: conditions and aggregates on a source (D172)

Measured 2026-11-25 with `bun test/conditions/measure-source.ts 5`: the real PocketBase 0.40.5 binary
(the B150a harness) and the adapter in one Bun 1.4.5 process on `agents-workhorse-01` (Linux x86-64,
12 cores, 30 GB RAM). PocketBase's data directory is in `/tmp`, a tmpfs; iglo.email's side writes
nothing. Load average 0.32 before the run and 1.03 after it (nothing else running). Not a CI
threshold.

## Workload

One user with exactly `AGGREGATE_LIMIT` (10,000) `view` records a second apart, `data` of
`{items, kind, hit}`, seeded through PocketBase's batch API (1.5 s).

- **One condition:** `{event: "view", where: {"data.kind": "a"}, count: {gte: 4000}}`. The filter
  narrows to the 3,334 records with `kind = "a"`; each is re-checked strictly and the count needs
  more than there are, so every page is read (4 pages of up to 1,000 rows, keyset on
  `(occurredAt, id)`, plus the adapter's token confirmation of the short last page).
- **Ten aggregates at the limit:** four `count`, three `sum` of `data.items`, three `distinct` of
  `data.kind` with a `where`. Each reads its whole window (10,000 rows, 10 or 11 pages) before the
  strict `where`, as the local aggregates do; nothing is shared between aggregates.

## Results (5 runs)

| Read | Run 0 (cold) | Runs 1–4 | Peak RSS |
|---|---|---|---|
| One condition | 161.7 ms | 99.3–103.5 ms | — |
| Ten aggregates (100,000 rows) | 3,571 ms | 3,370–4,035 ms | 70–79 MB |

Raw lines:

```
{"name":"seed","records":10000,"ms":1549.5}
{"name":"condition","run":0,"ok":true,"ms":161.7}
{"name":"ten-aggregates","run":0,"ok":true,"a0":10000,"ms":3571,"peakRssMb":78.7}
{"name":"condition","run":1,"ok":true,"ms":99.3}
{"name":"ten-aggregates","run":1,"ok":true,"a0":10000,"ms":3745.3,"peakRssMb":71.9}
{"name":"condition","run":2,"ok":true,"ms":101.7}
{"name":"ten-aggregates","run":2,"ok":true,"a0":10000,"ms":4034.7,"peakRssMb":70.5}
{"name":"condition","run":3,"ok":true,"ms":103.5}
{"name":"ten-aggregates","run":3,"ok":true,"a0":10000,"ms":3463.1,"peakRssMb":71.2}
{"name":"condition","run":4,"ok":true,"ms":101.2}
{"name":"ten-aggregates","run":4,"ok":true,"a0":10000,"ms":3370.5,"peakRssMb":70.4}
```

## Reading

- A step at the worst case (ten aggregates each at the limit) takes about 3.5 s of source reads,
  about 35 µs per row, almost all of it PocketBase answering pages. That is far inside the
  scheduler's 5-minute lease, and the reads happen outside any SQLite transaction, so the scheduler's
  other enrollments and the HTTP server are not held.
- Memory stays bounded by one page at a time (at most 1,000 rows, a body at most 32 MiB): the
  process peaked at 79 MB, including the test harness.
- A pushed-event sequence takes none of this path (`source = 'events'`): its condition and
  aggregate code is unchanged, so its timings (D100's `test/scheduler/measure-aggregates.ts`) are
  not re-measured here.
