# B101: test sends off the real-send pool; runner and media test timing

Brief B101. Decision D109. Measured in the Linux arm64 container (`oven/bun:1.4.4`) on macOS
(Apple silicon) with Docker; burner runs add CPU-bound `sh` loops (`timeout`-bounded) to load the
host, and are local stress, not CI.

## 1. Test sends on their own pool

**Stalled test send, one real send on the same server** (`test/messaging/test-pool.test.ts`,
`max_conns` 2, injected clock; the sink holds DATA replies for the test and the real recipient).

| Code | Stalled test | Real send at the test's 60 s cut |
| --- | --- | --- |
| before (origin/main, test sends share the outbox pool) | `ambiguous`, stage `unknown` | `ambiguous`, stage `unknown` (cut by the test's pool cancel) |
| after (`testPool: true`) | `ambiguous`, stage `unknown` | `accepted`, stage `smtp-complete` |

Shutdown (D104): a stalled test send is drained for 5 s and then settles `unknown`, as a real started
send does (`shutdown drains, then cancels a stalled test send`, passes before and after).

**`sends:production`** (reference harness, root with the Docker socket, `bun run reference:prepare`
first). Every run passes all four cases.

| Case | before | after |
| --- | --- | --- |
| queued reopen, immutable bytes, stable ID | PASS | PASS |
| interrupted claim recovery, stable unknown | PASS | PASS |
| shutdown, socket cancel, queued remainder, reopen | PASS (5087 ms) | PASS (5082 ms, 5108 ms on the final commit) |
| two instances, independent credentials, queues, SMTP, shutdown | PASS | PASS |

Real sends take the same path as before: the pool is chosen by `testPool`, and only test sends pass
it. The shutdown timing is unchanged within noise.

**`messaging:fixture`**: exit 0 before and after; the fixture is silent on success.

## 2. Runner test timing (`test/campaigns/runner/runner.test.ts`, tracked links per subscriber)

The drive is CPU-bound. It renders 300 messages, each with eight tracked links of 7 KB and one link
row per distinct URL. A profiling copy of the test (removed afterwards) on this host: members 0.6 s,
campaign setup 0.03 s, drive 2.7 s over 74 iterations (about 9 ms per message, 36 ms per iteration),
and 15 ms of forced GC. The test itself has no avoidable per-iteration work; the time is product
work per message.

| Run | Result |
| --- | --- |
| before, plain `bun run test` (baseline, two runs) | pass, 1283/0 both |
| before, stress: media+runner+sends at 4 workers, six burners, three runs | links test failed 3/3 at the 15 s wall (`72 iterations, sent 280 of 300`) |
| before, stress: full suite at 8 workers, four burners | links test failed 1/1 at the 15 s wall |
| after (wall 60 s, test timeout 90 s), stress: same as the before command, three runs | 106 pass, 0 fail, 3/3 |

Accepted change: the drive's wall bound is 60 s, and the test's own timeout is 90 s. The memory
assertion (`< 6 MiB` growth after 60 messages) and the 300-member count are unchanged.

## 3. Media cache test (`test/media/media.test.ts`, eviction)

Reproduced once: the full `bun run test` at plain load, final export before this change, run 6 of 6
failed at `media.test.ts:312` with `Expected: 1, Received: 2` (the reachable buffer count after GC).
The test passed in all other full runs (plain and stressed), in 60 reruns of the test alone in one
process, and in ten fresh processes of the whole media file.

Ruled out: the cache's eviction (the cache keeps only the last 8 MiB file, budget 9 MiB, as designed),
the runner's per-batch `attachments` local (it is released when the batch ends), and `readFile`
retention. The remaining explanation is timing-dependent retention of the first file while the
first campaign's batch is still in flight: the runner keeps the first campaign's batch until that
campaign finishes, and a check made while the sixth send is held can see it. Waiting for the first
campaign to finish *inside* the held window deadlocked (the runner keeps a lease on the first
campaign until the held send settles), so that variant was dropped.

Change: the check runs after the held send is released and both campaigns report `finished`, so
only the cache's copy of the last file can remain. The assertion is unchanged (`toBe(1)`).

## Evidence bar

- `bun run test` 20 consecutive passes at plain load on the final commit: see the PR body.
- Stress numbers above, with the failure counts before and after.
