# B119: media buffer reachable after GC under load

Source: the open item "Media: under parallel load one extra campaign attachment buffer stays
reachable after GC; holder unidentified" in [`status.md`](../status.md), first recorded in
[`B103-release-flakes.md`](B103-release-flakes.md) (section 2). Brief [B118 § B119](../briefs/B118.md).
Decision [D141](../design/09-decisions.md#d141-media-bytes-after-gc-are-measured-and-bounded-not-fixed-lead-2026-11-23):
accepted with evidence, not fixed. The holder of the campaign buffer is **not** identified.

Host: macOS arm64 (this workstation), Bun 1.4.5, a `campaignsFixture` (in-process production wiring,
loopback SMTP sink, injected clock). Scratch probes lived outside the repository and are removed;
the one committed test is `test/media/upload-retention.test.ts`.

## A measurement pitfall found on the way

`process.memoryUsage().arrayBuffers` does **not** count typed arrays made in JavaScript. Measured
with one forced GC after each step (`bun` on this host):

| Allocation (8 MiB, kept alive) | `arrayBuffers` (MiB) | `external` (MiB) |
| --- | --- | --- |
| `new Uint8Array(8 MiB)` | 0 | 8.02 |
| `Buffer.concat(chunks)` | 0 | 8.02 (+8) |
| `Response.arrayBuffer()` | 8 | 8.02 |
| `fs.readFile` | 8 | 8 |

An upload body is a JavaScript `Uint8Array` (`Buffer.concat` in `src/media/routes.ts`), so the counter
cannot see it. The first upload probes in this investigation used `arrayBuffers` and reported 0; they
are not evidence and are not reported below. Every upload figure here uses `external`. The campaign
attachments come from `readFile`, which `arrayBuffers` does count, so the campaign figures are valid
on either counter.

## 1. Uploads over HTTP: no body is retained

Real `Bun.serve` on a loopback port, the router of the fixture, eight parallel uploads per wave,
each 8 MiB with a 64 KiB streamed body. `external` after a forced GC, against a baseline taken before
the first upload:

| Probe | Uploads | `external` after GC (MiB) |
| --- | --- | --- |
| Uploads only | 16 | +0.74 |
| Uploads only | 48 | +0.95 |
| Uploads only | 144 | +1.33 |
| Mixed load: uploads, a truncated 1 MiB upload, a 429 at the admission limit, downloads, one download in three cancelled after its first chunk; a GC every 3 ms while a round is in flight; 12 parallel requests per round; 20 rounds | 240 requests | +0.35 after the first round, then +0.84 after the twentieth; the last five rounds add +0.03 |

A retained body would add 8 MiB per upload (128 MiB at 16). The residue is 1 MiB at 144 uploads, not
body-sized, and it flattens under mixed load. The per-request overhead of about 4 KiB is not
investigated further; it is far below any buffer.

Heap-snapshot class counts (V8 format, after a forced GC, `Bun.generateHeapSnapshot`) before and after
the uploads, the same at every size: `File` 4 to 4 or 5, `Blob` 5 to 5 or 6, `FormData` 1 to 3 or 4,
`Request` 1 to 5 or 6, `Response` 1 to 13, `ReadableStreamDefaultReader` 1 to 3. These are the
objects of the last wave in flight, bounded by the eight-upload admission limit (`MAX_UPLOADS`), and
they do not grow with the number of uploads.

The committed guard, `test/media/upload-retention.test.ts`, drives sixteen 8 MiB uploads over a real
socket and asserts `external` grows by less than 32 MiB after a forced GC. Mutation check: pinning each
request body in a module-level array (temporary edit of `src/media/routes.ts`, reverted) fails it with
`Received: 134600156` (128 MiB). Without the mutation it passes.

## 2. Campaign attachments: one extra batch buffer at a held point

The scenario is the one in `test/media/media.test.ts` ("attachments over the cache budget"): two
campaigns, one 8 MiB file each, alternating batches of one message, `attachmentCacheBytes` 9 MiB, so the
cache keeps one file. A held push is the sixth. The count is `arrayBuffers` after two forced GCs,
above the baseline taken before the campaigns start. The legitimate value is 8 MiB: the batch in flight
(the cache holds the same buffer after a read).

| Set | Runs | Held points | Held points at 16 MiB | After the campaigns finish | Notes |
| --- | --- | --- | --- | --- | --- |
| A | 64 | 1 per run | 2 | 8 MiB in 64 of 64 | 16 parallel processes, `bun test` each |
| B | 96 | 1 per run | 1 | not recorded | heap snapshot taken at each 16 MiB point |
| C | 192 | 1 per run | 3 | 8 MiB in 192 of 192 | same extra still present after one `setImmediate` and after a 20 ms sleep |
| D | 32 | 48 per run (24 batches of two campaigns, every push held) | 0 | 8 MiB in 32 of 32 | series 8 MiB at all 1,536 points |
| E | 1 process | 12 (12 iterations, one held point each, 12 spinner threads on 8 cores) | 0 | 8 MiB in 12 of 12 | |
| F | 1 process | 6 (`attachments()` alone, no runner, results dropped, GC between reads) | 0 | | 300 reads quiet and 300 under 12 spinner threads: 8 MiB every time |

So the extra appears in 6 of 352 single-point runs (1.7%) and never in 1,536 long-run points or 600
module-only reads. In every run where the finish was recorded (256), the count after the campaigns
finished is the cache's one file. The extra is present at the held point and gone at the end.

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
conservative stack word. Neither was confirmed.

## Bound and why it is bounded

- **Observed size:** at most one extra 8 MiB buffer at a time, never two, across 352 single-point runs
  and 1,536 long-run points. A campaign batch is at most 10 MiB (`MAX_BYTES`, 10 files), so one extra
  batch is the most that was ever seen.
- **Not accumulating:** long-run series stay at the legitimate 8 MiB from the first batch to the
  forty-eighth, and each run ends at the cache's single file.
- **Mechanism of the bound:** the runner holds one batch at a time (`process(batch)` with
  concurrency 1 in this test), and the attachment module holds nothing beyond its 64 MiB cache. The
  extra is therefore one earlier batch's buffer that is released at some later point. This is an
  argument from the observed behaviour and the code shape, not from a proof of the holder.

## Decision

Accepted, not fixed ([D141](../design/09-decisions.md#d141-media-bytes-after-gc-are-measured-and-bounded-not-fixed-lead-2026-11-23)).
No holder was found in `src/media/*`, so no change to the module is made; the upload path is clean
and guarded by a test. The campaign extra is bounded by one batch and does not persist. Identifying
its holder needs a tool that sees native and conservative references, which this host does not have.
If the owner wants it closed, that is the next step, not a change to the attachment cache.

## Commands

- `bun test test/media/upload-retention.test.ts`: passes; mutation check above fails.
- Scratch probes (not committed): the eviction scenario per run as a test file with `Bun.generateHeapSnapshot`,
  run with `xargs -P 16`; the attachment module alone; the upload probes with heap snapshots.
