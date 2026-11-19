# B103: v1.3.0 release run flakes (runner drive, media eviction)

Source: release run 44159976600 (tag `v1.3.0` on de36d91). Both `build` jobs failed in `bun run
check`; nothing was published. Two tests failed: the runner's tracked-links test on x64
(`test/campaigns/runner/runner.test.ts`) and the media eviction test on arm64
(`test/media/media.test.ts`). This note records what was measured and what was ruled out. The
runner failure's cause is the wall-clock render deadline (D110), found in B103 run 1's log. The
holder of the media test's extra buffer under load is not established.

## Summary

| Item | Reproduced before | Cause | Change |
| --- | --- | --- | --- |
| 1. Runner tracked links (x64) | Not reproduced: 0 failures in 143 runs of the file or test (host, arm64 and amd64), and in 5 full arm64 suites (see section 1) | The wall-clock render deadline (D110): one message's render took more than 1 s of real time under CPU contention, threw `template render limit exceeded`, and the subscriber was recorded `failed`, so the campaign finished one push short. The send path's clock-based waits were ruled out as causes (section 1). | The render deadline is removed (D110, with a test that fails before the change and passes after). The drive no longer steps the injected clock. The wall bound stays at 60 s, real time only. The failure message names the logged errors. |
| 2. Media eviction (arm64) | 19 of 192 loaded runs failed the reachability check (`Expected: 1, Received: 2`) | The reachability observation is unstable across identical runs. The product reads each batch once, and the cache evicts as designed. The holder of the extra buffer under load is not established (section 2). | The test counts distinct attachment buffers handed to its messages (one read per batch), instead of GC reachability. Mutation check: disabling eviction fails it with `Expected: 6, Received: 2`. |

The runner's mechanism is a product defect, the wall-clock render deadline. It is fixed by D110, which
records the decision and the scope (Liquid only; Markdown is B104, D111). The consent-skip visibility
gap (section 3) and the media buffer's holder are open and are not changed here.

## 1. Runner tracked links

### Reproduction count

The failure needs the campaign to finish with one subscriber not pushed (`pushes 299`, `sent 299`,
`to_send 300`, status `finished`). It never occurred on this host in the runs below. Each row is one
process (or one full suite) and each was checked for `(fail)`:

| Setup | Runs | Failures |
| --- | --- | --- |
| macOS host, tracked-links test, 8 parallel | 24 | 0 |
| arm64 container, whole file, 4 parallel | 12 | 0 |
| arm64 container, whole file, 8 parallel | 16 | 0 |
| arm64 container, tracked-links, 8 parallel (instrumented) | 16 | 0 |
| arm64 container, whole file, 16 parallel (instrumented) | 16 | 0 |
| arm64 container, tracked-links, 16 parallel | 32 | 0 |
| arm64 container, full `bun run test` (four workers) | 3 | 0 |
| arm64 container, full `bun run test`, pinned to 4 CPUs | 1 | 0 |
| arm64 container, full `bun run test`, pinned to 2 CPUs | 1 | 0 |
| arm64 container, neighbouring suites then the file, one process | 1 | 0 |
| amd64 emulation, whole file | 1 | 0 |
| amd64 emulation, tracked-links, 8 parallel | 24 | 0 |
| amd64 emulation, full `bun run test`, pinned to 4 CPUs | 1 | 0 (2 unrelated tests failed on time limits, see below) |

Drive variants (not the committed test; scratch copies, removed afterwards): clock step 1 to 100,000 ms
per iteration, random steps with random settle timing (28 seeded runs), forced `Bun.gc(true)` every
3 iterations, batch size 1 to 20, concurrency 1 to 5, a 40 ms CPU spin per emailer push, and a memory
cap of 160 to 256 MB. None dropped a subscriber.

The release run's clock had moved 98,818,500 ms (27.4 h) in its 60 s wall bound. That is 9.9 million
drive iterations at 10 ms each, so the drive spun for most of the minute. Campaign progress is
independent of that spin, so the campaign itself had already finished when the wall bound ended the
drive.

### Lead hypothesis: a clock-based bound fired for one message

The send path has these clock-based waits. Each was checked for whether it can settle a
subscriber without a push, in this test:

- **Render retry** (`render` in `src/campaigns/runner/runner.ts`): on `RenderCapacityError`, 50 attempts,
  each `sleep(20)` on the injected clock, then a `failed` outcome. The error needs the renderer's
  `active` count to reach 4. The runner renders with `renderSync`, which holds `active` only inside
  one synchronous call, and nothing else in this test renders asynchronously (the only async
  `render` caller is the template preview route). **Cannot fire here.**
- **Rate pacing** (`messageRate`): one worker's last 1000 push times, so 1000 pushes per window.
  The test pushes 300 across 5 workers. **Not engaged.**
- **Sliding window**: disabled in the test settings. **Not engaged.**
- **Heartbeat** (`leaseMs / 3` on the clock): renews the lease and cannot change an outcome. **Cannot
  drop a message.**
- **Lease expiry**: needs a second holder. The test starts one runner, and a 30 s lease is renewed by
  the heartbeat and at every claim. **Cannot occur.**
- **Render deadline** (not a clock-based wait of the send path, but a real-time deadline inside the
  renderer): liquidjs `renderLimit: 1000`, a deadline on `performance.now()`, checked during each
  render. A render that takes more than one real second under CPU contention throws `template
  render limit exceeded`; the runner records that subscriber `failed` and never retries it. **This is
  the mechanism of the release failure.** It is removed by D110.

Verdict: the clock-based waits of the send path cannot drop a message in this test, so the hypothesis
as stated is ruled out. The release failure's mechanism is the render deadline. The release run's own
log has no error text (its drive printed no logged errors at the time). The same log line was
reproduced under CPU contention in B103 run 1, which named the subscriber (`p0091@x.test`).

### Decisive question: does a never-pushed subscriber get a recorded, visible outcome?

Two fault-injection runs answered it through the runner with the fake emailer (scratch tests,
removed afterwards):

| Fault | Delivery row | Log line | Campaign counts | Visible to an operator |
| --- | --- | --- | --- | --- |
| A: render error for one subscriber (work limit) | `failed` | `error rendering message (bad) (p2@x.test): range limit exceeded` | sent 4, to_send 5, finished | Yes: the log names the subscriber and cause |
| B: subscriber unsubscribed between claim and push | `skipped` | none | sent 4, to_send 5, finished | Partly: only the count shows a difference, and no reason is stored |

Every path that can leave a claimed subscriber unpushed records a row: `failed` (render error, with a
log line), `skipped` (ineligible or changed at push), `unknown` (ambiguous emailer outcome or an
abandoned claim, with a log line), or a cursor rewind for an unsent subscriber (retried later). The
product therefore never drops a subscriber with no record. The gap is in section 3.

### Change

- The drive steps the clock by 0 instead of 10 ms. Nothing this test asserts needs time, so fake time
  no longer moves while renders are in flight. This removes a timing variable from the test. It is not
  the fix for the release failure: that fix is the render deadline removal (D110), which removes the
  mechanism.
- The 60 s wall bound stays, real time only. Measured: about 2.7 s on the B101 profile host, 14 s in
  the full suite on four CPUs, 16 s on two CPUs. The 60 s bound is more than 3x the slowest of those.
- The drive's failure message now names the runner's logged errors (count and the first three), so
  if this recurs the message says why a subscriber was not pushed.

### Emulation note

Under amd64 emulation on four CPUs, the full suite had two failures that are unrelated to the
runner: `raw-query time limit and admission > the deadline holds while the reader is paused` (2.1 s)
and `compiled executable > for hostile root URL values` (25 s). Both passed in CI's x64 job (1.0 s
and 5.6 s). They are host-speed effects of emulation.

## 2. Media eviction

### Reproduction count (before)

The committed test's check was `await carried.reachable()` after the campaigns finished: the number
of distinct attachment buffers still reachable after `Bun.gc(true)`. Scratch copies of the test,
with the same setup, ran in arm64 containers under parallel load and counted the same check:

| Batch | Runs | Mismatches (reachable != 1) |
| --- | --- | --- |
| 16 parallel, held and final checks | 32 | 2 |
| 16 parallel, held and final checks | 48 | 3 |
| 16 parallel, with heap snapshots on mismatch | 48 | 4 |
| 16 parallel, with stack scrub before the final check | 64 | 10 |
| **Total** | **192** | **19** |

Every run in the three instrumented batches (160 runs) carried exactly six distinct buffers, one per
batch. The extra reachable buffer was one buffer from an earlier batch, which the cache had already
evicted.

### What was measured about the extra buffer

- A V8-format heap snapshot of a failing run shows exactly two 8 MiB `ArrayBuffer`s. Each has a
  single incoming edge, a `WeakRef` internal edge, and no strong path from the roots. The snapshot
  does not draw typed-array-to-buffer edges, so the test's own message reference is also invisible
  to it. The snapshot does not show what holds the extra buffer.
- A 4000-deep stack overwrite and a second collection, before the final check, did not clear the
  extra buffer in any of the 10 mismatched runs of that batch. So a stale stack slot is not what keeps
  it alive, as far as this test can tell. The holder is still unidentified.
- The extra buffer was a different earlier batch in different runs (buffer indices 2, 3 and 4 of 0 to 5),
  so it is not a fixed reference from the test.

Conclusion: the reachability count depended on something the test cannot observe or control, and its
cause was not established. The eviction and the re-read are deterministic, and the count of distinct
buffers was never wrong in any run.

### Change

`carriedBuffers` counts distinct buffers by identity (a `WeakSet`, so it keeps nothing alive). A
buffer handed to a message counts once. A cache hit repeats a buffer, so it adds nothing, and a second
read within one batch adds one. The eviction test now asserts six distinct buffers (one read per batch of
two alternating 8 MiB files under a 9 MiB budget), checked while the sixth send is held. After the
campaigns finish, the test asserts that each campaign sent all three of its messages. The held check is
a read count: it shows each batch read its file, which is eviction and re-read. It does not show that
memory was released, and a batch that read twice would still carry one buffer, so repeated reads within
one batch are not observable with `batchSize: 1`.

Mutation check: with the cache's eviction loop disabled, the test fails with `Expected: 6`,
`Received: 2`. The shared-attachments test keeps its `carried() === 1` check and loses its
reachability check.

Not covered by this test any more: the memory release of an evicted buffer. That was only observable
through collection, which the test cannot make deterministic.

## 3. Finding: consent skips are recorded but not visible

Fault B above. A subscriber who becomes ineligible between claim and push gets a `skipped` row in
`campaign_deliveries` and nothing else: no log line, no reason, and no API or page reads that table
(only the runner's SQL and the frequency-cap lookup touch it). The campaign's `sent` and `to_send`
show the difference. This does not match the brief's bar ("journaled ... with a reason ... visible")
for consent skips, but the release failure's path is not this one (the test changes no consent), and
closing the gap needs an owner decision: store a reason (a migration), log an attention line, or
surface the table. That decision is not made here. Recommended as a follow-up brief.

## Evidence bar

Acceptance (`bun run check` and the rest) and the before/after counts are in the PR body, not here,
so this note does not change after the checks run.
