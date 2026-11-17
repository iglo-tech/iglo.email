# B92: CI steps on main

Before and after on this host (x86-64, 16 GiB, verify lock held for each run). The CI run is 43960943873 on main (2026-11-16). This note covers the sending-path change; the other changes are test-only.

## Sending path (D104): queued sends cancelled at shutdown

`bun run sends:production`, real `dist/iglo.email` with one SMTP connection:

| | Remainder row after SIGTERM (never attempted) |
| --- | --- |
| before | `failed` (`'failed' !== 'queued'`, `test/sends/production.ts:351`) |
| after | `queued`; the restart sends it, and the run ends with `sends:production` exit 0 |

The emailer's unit test `test/messaging/deadline.test.ts` pins the stage: before `stage: "local"`, after `stage: "not-started"`, and `sink.connections()` stays at 1. Nothing is added to SMTP traffic: the held send is still cancelled as `unknown`, and the queue expiry is unchanged.

No latency or memory measurement applies: the change is one branch in the cancel path, taken only after `close()` begins.

## Test-only fixes

- `messaging:fixture`: the caller zeroed its attachment bytes before the send settled; the sink received zeros (`AAAAAAAAAAA=`). The same message with the buffer left alone was `AAECDQp/gP8=`. The emailer shares attachment bytes with the caller until the send settles, by design (`media.test.ts` pins one shared buffer per campaign). The fixture now zeroes them after the result.
- `sends:production`, isolation step: the fixture seeded rows at its fixed 2026-01-02 clock. Production compacted those payloads at startup (30-day send-body retention), so `resend` returned 409 `Conflict`. The seed now runs at the present time, using the existing `SENDS_FIXTURE_CLOCK_OFFSET`.
- `templates:compiled` (arm64): `bwrap` fails on a missing source (`Can't find source path /lib64`); the arm64 runner has no `/lib64`. The sandbox binds `/lib64` only when present. The arm64 branch was not run on this host.
- `test/media/media.test.ts` (eviction and shared-buffer tests): the assertion read process-wide `arrayBuffers`, which counts everything a worker process holds, and a worker runs several test files in turn. The test now counts the distinct attachment buffers its own messages carried that are still reachable after a full collection. Mutation checks: with the eviction budget raised to 64 MiB, the eviction test fails (2 buffers reachable); with the cache disabled, the shared test fails (5 buffers carried instead of 1). The flake itself did not reproduce on this host, so the before run is not shown.
