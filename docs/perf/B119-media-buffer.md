# B119: media buffer reachable after GC under load

Source: the open item "Media: under parallel load one extra campaign attachment buffer stays
reachable after GC; holder unidentified" in [`status.md`](../status.md), first recorded in
[`B103-release-flakes.md`](B103-release-flakes.md) (section 2). Brief [B118 § B119](../briefs/B118.md).
Decision [D141](../design/09-decisions.md#d141-media-bytes-after-gc-are-measured-and-bounded-not-fixed-lead-2026-11-23):
accepted with evidence, not fixed. The holder of the campaign buffer is **not** identified.

Hosts: the upload and campaign probes in sections 1 and 2 ran on macOS arm64 (this workstation,
Bun 1.4.5, a `campaignsFixture` with in-process production wiring, a loopback SMTP sink and an
injected clock). The committed guard, its mutation checks and its stability runs ran in a Linux arm64
container (`oven/bun:1.4.5`, 8 CPUs, 8 GiB) under host load of 13 to 62 from other work. Scratch probes
lived outside the repository and are removed; the one committed test is
`test/media/upload-retention.test.ts`.

## A measurement pitfall found on the way

`process.memoryUsage()` has three counters that matter here, and none of them sees every byte of an
upload:

- `arrayBuffers` counts native ArrayBuffers only.
- `external` counts typed arrays made in JavaScript (a request body, `Buffer.concat`) and native
  ArrayBuffers.
- The `File` that `formData()` returns is not counted by `external`. Once the body is parsed, the 8 MiB
  it holds leave `external` (a separate probe on macOS: −8 MiB against the same body still alive). On
  Linux those bytes sit in a memfd file (Bun's store for a large File), outside the heap and outside both
  counters. The guard reads memfd files from `/proc/self/fd`.
- The `Blob` that `formFile` builds from the body (`new Blob([body])` in `src/media/routes.ts`) is
  counted by `external`, as the table below shows.

Measured with one forced GC after each step (macOS):

| Allocation (8 MiB, kept alive) | `arrayBuffers` (MiB) | `external` (MiB) |
| --- | --- | --- |
| `new Uint8Array(8 MiB)` | 0 | 8.02 |
| `Buffer.concat(chunks)` | 0 | 8.02 (+8) |
| `new Blob([body])` (the copy `formFile` builds) | 0 | 16.02 (+8) |
| `Response.arrayBuffer()` | 8 | 8.02 |
| `fs.readFile` | 8 | 8 |

An upload body is a JavaScript `Uint8Array` (`Buffer.concat` in `src/media/routes.ts`), so
`arrayBuffers` cannot see it. The first upload probes in this investigation used `arrayBuffers` and
reported 0; they are not evidence and are not reported below. So `external` sees the body copies, the
`Blob` that `formFile` builds and the `arrayBuffer()` copy, and it does not see the memfd store of the
`File` that `formData()` returns. Section 1 shows both counters in use.

## 1. Uploads over HTTP: no body is retained

Real `Bun.serve` on a loopback port, the router of the fixture, eight parallel uploads per wave,
each 8 MiB with a 64 KiB streamed body (macOS). `external` after a forced GC, against a baseline taken
before the first upload:

| Probe | Uploads | `external` after GC (MiB) |
| --- | --- | --- |
| Uploads only | 16 | +0.74 |
| Uploads only | 48 | +0.95 |
| Uploads only | 144 | +1.33 |
| Mixed load: uploads, a truncated 1 MiB upload, a 429 at the admission limit, downloads, one download in three cancelled after its first chunk; a GC every 3 ms while a round is in flight; 12 parallel requests per round; 20 rounds | 240 requests | +0.35 after the first round, then +0.84 after the twentieth; the last five rounds add +0.03 |

A retained body would add 8 MiB per upload (128 MiB at 16). The residue is 1 MiB at 144 uploads, not
body-sized, and it flattens under mixed load. The per-request overhead of about 4 KiB is not
investigated further; it is far below any buffer.

Heap-snapshot class counts (V8 format, after a forced GC, `Bun.generateHeapSnapshot`, macOS) before and
after the uploads, the same at every size: `File` 4 to 4 or 5, `Blob` 5 to 5 or 6, `FormData` 1 to 3 or
4, `Request` 1 to 5 or 6, `Response` 1 to 13, `ReadableStreamDefaultReader` 1 to 3. These are the
objects of the last wave in flight, bounded by the eight-upload admission limit (`MAX_UPLOADS`), and
they do not grow with the number of uploads.

### The committed guard

`test/media/upload-retention.test.ts` drives eight 8 MiB uploads in flight at once over a real socket.
After a forced GC (twice) it asserts that neither the growth of `external` nor the growth of the memfd
bytes reaches 4 MiB. Normal growth is 0.3 to 0.5 MiB. The bound is below one 8 MiB body, so keeping
any one body or one File's store fails it. On Linux the memfd check runs; on macOS there is no
`/proc/self/fd`, so the memfd check is skipped and `external` alone runs.

Unmutated, Linux arm64 container: `external` 5,016,532 → 5,363,023 bytes (+0.33 MiB), memfd 0 → 0.

Mutations. Each is a temporary edit of `src/media/routes.ts` in a scratch export of the committed
head, never committed. Each runs `bun test test/media/upload-retention.test.ts` in the Linux container.
"Not reached" means the first failing assertion stopped the test before that check ran.

| Mutation in `src/media/routes.ts` | `external` growth | memfd growth | Result |
| --- | --- | --- | --- |
| none (committed head) | +0.33 MiB (346,491 B) | 0 | pass |
| M1: pin each parsed File (`PINNED.push(file)`, a module-level array) | under 4 MiB (passed) | 64.00 MiB (67,108,864 B) | fails the memfd check |
| M2: pin each `arrayBuffer()` copy (`PINNED.push(bytes)`) | 64.33 MiB (67,456,767 B) | not reached | fails the external check |
| M3: pin each request body (`PINNED.push(body)`) | 64.33 MiB (67,456,277 B) | not reached | fails the external check |
| M4: keep only the last request body (`LAST_BODY = body`) | 8.33 MiB (8,734,867 B) | not reached | fails the external check |
| M5: keep only the last File (`LAST_FILE = file`) | under 4 MiB (passed) | 8.00 MiB (8,388,608 B) | fails the memfd check |

Every failing run prints `Expected: < 4194304`. The previous guard (`external` alone, under 32 MiB)
passes M1, M4 and M5: M1 and M5 hold memfd bytes it cannot see, and M4 holds 8.33 MiB, below its bound.

Stability: the committed test passed in every run of `bun test --parallel=4 --timeout=30000 test/media`
(four files, 38 tests) five times in a row, at host load 24 to 62: 38 of 38 in each run. One earlier
parallel run of `test/media test/campaigns` (221 tests, 12 files) also passed the upload test; that run
had one failure in another file (`test/campaigns/runner/runner.test.ts`, the tracked-links test, a
wall-clock drive timeout under the same load; see the commands section).

## 2. Campaign attachments: one extra batch buffer at a held point

The scenario is the one in `test/media/media.test.ts` ("attachments over the cache budget"): two
campaigns, one 8 MiB file each, alternating batches of one message, `attachmentCacheBytes` 9 MiB, so the
cache keeps one file. A held push is the sixth. The count is `arrayBuffers` after two forced GCs,
above the baseline taken before the campaigns start. The legitimate value is 8 MiB: the batch in flight
(the cache holds the same buffer after a read). All rows are macOS.

| Set | Runs | Held points | Held points at 16 MiB | Count after the campaigns finish | Notes |
| --- | --- | --- | --- | --- | --- |
| A | 64 | 1 per run | 2 | 8 MiB in 64 of 64 | 16 parallel processes, `bun test` each |
| B | 96 | 1 per run | 1 | not recorded | heap snapshot taken at each 16 MiB point |
| C | 192 | 1 per run | 3 | 8 MiB in 192 of 192 | same extra still present after one `setImmediate` and after a 20 ms sleep |
| D | 32 | 48 per run (24 batches of two campaigns, every push held) | 0 | 8 MiB in 32 of 32 | series 8 MiB at all 1,536 points |
| E | 1 process | 12 (12 iterations, one held point each, 12 spinner threads on 8 cores) | 0 | 8 MiB in 12 of 12 | |
| F | 1 process | 6 (`attachments()` alone, no runner, results dropped, GC between reads) | 0 | | 300 reads quiet and 300 under 12 spinner threads: 8 MiB every time |

So the extra appears in 6 of 352 single-point runs (1.7%) and never in 1,536 long-run points or 600
module-only reads. In the 256 runs where the finish was recorded, the count after the campaigns finished
was the cache's one file. That is all these macOS runs show about the finish.

### Linux arm64: the same extra, measured differently (B103)

[B103 § 2](B103-release-flakes.md) counted the extra in arm64 Linux containers under 16 parallel runs.
Its check was the number of distinct attachment buffers still reachable after `Bun.gc(true)` once the
campaigns had finished (`carried.reachable()`): 19 of 192 runs had `reachable != 1`. In the 10 mismatched
runs of its stack-scrub batch, a 4000-deep stack overwrite and a second collection before the final check
did not clear the extra. The macOS rate here (1.7%) and the Linux rate (about 10%) are different, and the
two measures differ too (`arrayBuffers` bytes here, the distinct-buffer count there). This note does not
reconcile them.

Whether the extra is released later is **not shown**: the macOS finish counts above are the only
after-finish data in this note, and the Linux data shows it reachable at the final check. No release
claim is made.

### Heap snapshot at an extra point

Snapshot taken at a 16 MiB point (set B and set C, three of them). Node counts by name show one
`ArrayBuffer` object with no typed-array data edge that could name it, and its only inbound
edge is **weak**, from `(GC roots)`:

```
object ArrayBuffer #78664 inbound 1
    weak: <- synthetic "(GC roots)" #1
```

A snapshot of a normal finished run (no extra) has the same node shape (`ArrayBuffer` with one weak edge
from `(GC roots)`). The V8-format snapshot does not draw typed-array-to-backing-store edges, so a
`Uint8Array` holder cannot be followed to the 8 MiB store. The snapshot therefore shows no strong holder
path, which matches [B103](B103-release-flakes.md): an extra that is not on any strong path from the
roots is held by something the snapshot does not model, such as a native-side reference or a
conservative stack word. Neither was confirmed. B103's failing Linux run, snapshotted, showed two 8 MiB
buffers and the same weak-only edge.

## Bound: what is shown

- **Observed size (macOS):** at most one extra 8 MiB buffer at a time, never two, across 352 single-point
  runs and 1,536 long-run points. A campaign batch is at most 10 MiB (`MAX_BYTES`, 10 files), so one
  extra batch is the most these runs saw. The B103 snapshot is consistent with one extra.
- **Accumulation (macOS only):** the long-run series stay at the legitimate 8 MiB from the first batch to
  the forty-eighth. No Linux run measured accumulation, so none is claimed for Linux.
- **Holder:** not identified. The runner holds one batch at a time in this test (`process(batch)` with
  concurrency 1), and the attachment module keeps its 64 MiB cache. Which earlier buffer stays reachable,
  and what references it, is not shown.

## Decision

Accepted, not fixed ([D141](../design/09-decisions.md#d141-media-bytes-after-gc-are-measured-and-bounded-not-fixed-lead-2026-11-23)).
No holder was found in `src/media/*`, so no change to the module is made. The upload path is guarded by
a test that bounds `external` and memfd growth at 4 MiB. The campaign extra is at most one batch
(10 MiB) beyond the cache at a held point, and its release is not shown. Identifying its holder needs a
tool that sees native and conservative references, which these hosts do not have. If the owner wants
it closed, that is the next step, not a change to the attachment cache.

## 3. Peak memory during uploads (backlog)

An upload can hold up to four copies of its bytes at the same moment: the stream chunks (until the
collector takes them), the concatenated body (`Buffer.concat`), the memfd store of the Blob, and the
`file.arrayBuffer()` copy. With `MAX_FILE_BYTES` at 25 MiB and `MAX_UPLOADS` at 8, that is up to about
800 MiB at peak by arithmetic (4 × 25 MiB × 8). This is bounded, and it is not retention: the copies
are released after each request. It is not measured here. The `MAX_UPLOADS` comment in
`src/media/routes.ts` counts one body, so it understates the peak. Reducing the copies is backlog and
is not part of D141.

## Commands

- `bun test test/media/upload-retention.test.ts`: passes on macOS (external alone, 1.8 s). In the Linux
  arm64 container it passes unmutated (memfd checked, 2.8 to 5.8 s under host load) and fails for each
  mutation in the table in section 1.
- Stability (Linux arm64 container): `bun test --parallel=4 --timeout=30000 test/media`, five runs in a row
  under host load 24 to 62: 38 of 38 pass in each run (66, 61, 68, 31 and 65 s).
- A parallel run of `test/media test/campaigns` (221 tests, host load about 36) passed the upload test and
  failed one test in `test/campaigns/runner/runner.test.ts` (tracked links, "do not accumulate across
  batches") at 91 s. The file alone (under load 13 to 20) failed the same test at 82 s, and the single test
  failed at 91 s; its drive stopped at the 12.8 s wall limit with 125 of 300 pushes, sent 120 and logged no
  errors. These are wall-clock drive timeouts in a CPU-bound test, not wrong values, and not a media failure.
  They are not changed here.
- Scratch probes (not committed): the eviction scenario per run as a test file with `Bun.generateHeapSnapshot`,
  run with `xargs -P 16`; the attachment module alone; the upload probes with heap snapshots.
