# B49: `drive` bound covers real I/O

Test-harness change in `test/campaigns/runner/fixture.ts`. It affects only how long a test waits
for the runner, not the runner itself. Measured on this host (6 cores, 16 GiB RAM), serially,
under `flock ~/.local/state/iglo-email-cos/verify.lock`.

## Root cause

- B42 (ead051f, `docs/perf/B42-runner-flake.md`) cut the bound of `drive` from 20,000 to 2,000
  iterations (`test/campaigns/runner/fixture.ts:135` on `main`). Each iteration is three
  zero-length `Bun.sleep(0)` yields and one clock advance.
- The media test "two campaigns sharing attachments hold them once" (`test/media/media.test.ts:253`)
  and "attachments over the cache budget are evicted and read again" (`:272`) wait on
  `sendHeld` (`:241-251`). The runner reads each attachment with `readFile`, on the libuv thread
  pool, before it pushes the message (`src/media/filesystem.ts:245`, called from
  `src/media/attachments.ts` `bytes()`). That read takes real time. Zero-length yields do not wait
  for it.
- A zero-length iteration costs about 3–5 µs. Two thousand iterations are about 8 ms of wall time,
  shorter than one disk read under the test's load. The iteration count, not real time, is what ran
  out.

## Evidence

Baseline (`main`, bound 2,000), `bun test test/media/media.test.ts`, one run:

```
error: drive: condition not reached after 2000 iterations (step 50 ms): last condition value false; ... wall 8 ms; pushes 0, pending sends 0, sink messages 0; campaign 1 status running sent 0 to_send 3 lease held; campaign 2 status running sent 0 to_send 3 lease held
 24 pass
 2 fail
```

Both failures came from `sendHeld` (`media.test.ts:265` and `:284`). The failing wait had 0
pushes and the lease held, with wall time 7–8 ms. The reviewer's "wall 11 ms" fits the same
shape.

Probe, with the bound raised to 20,000 (temporary, reverted before the fix): all 26 pass. Waits
that needed more than 2,000 iterations finished in very little real time:

```
PROBE iterations 2349 wall 12 ms
PROBE iterations 2001 wall 7 ms
PROBE iterations 1540 wall 11 ms
```

The wall bound was then measured with a temporary probe test that waits on a condition that never
holds (not committed): it stopped at 10,001 ms after 3,212,255 iterations, about 3.1 µs each, with
the `wall limit 10000 ms` diagnostic. That probe ran with the first 10 s bound. The bound is now
3 s (see "Why 3 s"), so the same wait ends at `wall limit 3000 ms`.

## Change

`drive` stops at `WAIT_WALL_MS` (3 s) of real time or at its iteration cap, whichever comes first.
A fourth optional argument, `wallMs`, replaces the 3 s budget for one wait. The new wall-path test
uses 200 ms. The cap is 10,000,000, a runaway guard that the wall bound always reaches first at
about 3 µs per iteration. The diagnostic error is the same as before (B42's stuck-state message),
and it now says which limit was reached. The B42 regression test passes an explicit limit of 50 and
still fails fast with `condition not reached after 50 iterations`.

The wall-path test, "a wait with no iteration limit ends at the wall bound and names it", passes no
iteration limit and a 200 ms budget. It asserts `wall limit 200 ms`, asserts that `iteration limit`
is absent, and asserts that the wait returns in under 2 s. It sits next to the B42 test in
`test/campaigns/runner/runner.test.ts`.

## Why 3 s

- Bun's default per-test timeout is 5 s. A serial `bun test test/campaigns/runner/runner.test.ts`
  or `bun test test/media/media.test.ts` uses it. `bun run test` and `bun run check` pass
  `--timeout=30000`. A wall bound above 5 s would hit the test timeout first in serial runs, and the
  state dump would be lost. That is B42's second symptom. The bound must sit below the smallest
  timeout the documented commands use.
- Margin, measured: with a 4 s bound, a temporary probe with no budget override (since deleted),
  run serially with the default 5 s timeout, stopped at `wall limit 4000 ms` after 4,001 ms with the
  full state dump. The whole test took 4.70 s, because fixture setup runs inside the test. That left
  about 0.3 s under 5 s, too thin, so the lead set the bound to 3 s. At 3 s the same test has about
  1.3 s of room for setup. Under load, the setup margin is the number to watch.
- The media waits that failed need 7–12 ms of wall time (the 1,540–2,349 iteration probes above).
  With four CPU burners (`yes > /dev/null`), the slowest whole test across the runner and media files
  (serial, JUnit) took 1.88 s (the tracked-link test). That is a whole test, so a single wait is
  shorter and has at least about 1.6× headroom under the 3 s bound.
  These numbers come from the independent review of 19adf2c.
- A wait that never completes spends about 3 s of one core before it fails. Real waits finish in
  milliseconds, so the cost falls only on tests that fail anyway.

## Rule

When a shared test helper changes, run every file that imports it in isolation, one at a time, and
do not rely on the full suite alone. B42 changed `drive` and measured one consumer. Its full runs
passed while the media tests failed intermittently under `--parallel=4`. List the consumers with
`grep -rl runnerFixture test`. Today they are `test/campaigns/runner/runner.test.ts` and
`test/media/media.test.ts`. `test/media/measure.ts` is an opt-in measurement script, not a test.

Rejected: sleeping 1 ms of real time per iteration after the first 100 iterations. It fixed the
media tests, but the rate-limit tests in the runner file wait on fake-clock time for many
iterations, and each pause added real time to them. Measured with the same five runs as the
accepted change (serial, under the lock):

| Variant | Runner file, 5 runs | Mean |
| --- | --- | --- |
| Before (bound 2,000) | 18.10, 18.01, 18.43, 18.34, 17.44 s | 18.06 s |
| Rejected: 1 ms pause after 100 iterations | 18.74, 19.61, 21.42, 20.04, 21.01 s | 20.16 s |
| Accepted: wall bound, cap 10,000,000 | 16.98, 17.34, 17.39, 18.20, 18.05 s | 17.59 s |

Per-test JUnit timing for the rejected variant showed the increase in
`D59 pacing never exceeds the per-worker rate in any one-second window` (+1.12 s),
`concurrency and the per-worker message rate bound sends` (+0.59 s) and
`the sliding window holds sends until the window is over` (+0.35 s). Those tests do not touch
the disk.

## Timing after the change

- Runner file (`test/campaigns/runner/runner.test.ts`): 16.98–18.20 s over 5 runs (above), against
  17.44–18.43 s before. No slowdown beyond noise.
- B42 regression test ("a wait that never completes fails with the stuck state"), run alone:
  686 ms before the change, 659 ms after. Its own limit (50) is reached, so the wall bound does
  not apply to it.
- Wall-path test ("a wait with no iteration limit ends at the wall bound and names it") and the
  B42 test, run together by name (`--test-name-pattern`), serially under the lock: 1.53 s for both,
  including fixture setup.
- Media file (`test/media/media.test.ts`): 26 of 26 pass in 10 of 10 isolated runs, 13.95–14.30 s
  each. This run, alone: 26 pass, 14.17 s. Runner file, alone: 31 pass, 18.21 s.

## Other `drive`-style loops

- `test/messaging/send-rate.test.ts` has its own `drive` with a 20,000-iteration cap and no
  wall bound (`:373-380`). Its waits that use small explicit caps (for example `:677`, `:832`,
  `:840`, `:847`, `:1013`, `:1022`) wait on real sink I/O, so they share the risk class. They
  have not failed here, so this change leaves them alone.
- `test/media/storage.test.ts:201` waits for an upload's temporary write with a 20,000-iteration
  zero-length loop and no wall bound. It has not failed here either. If it does, it needs the
  same wall bound.
- Single `Bun.sleep(0)` yields elsewhere (`test/events`, `test/tx/gate`, `test/analytics`,
  `test/import`, `test/maintenance`) are single steps, not waits, so they are unaffected.

## See also

- [B42 runner flake](B42-runner-flake.md): the bound and the stuck-state diagnostic this change
  keeps.
