# B122: empty-campaign deferral (D120), before and after

D120 changes when the campaign runner finishes a running campaign that has no recipients: on the first scan after its start, not on the wake that started it. This note measures that change and checks that real sends are unchanged. It is a before/after record, not a CI threshold.

## Setup

- **Host:** `oven/bun:1.4.5` container on linux/arm64 (Apple silicon, OrbStack), as user `bun`. Nothing else ran in the container while measuring.
- **Before:** `origin/main` at `f37de0b`. Its `src/`, `test/` and `.github/` are identical to the B122 branch base `08ac50f`: the commits since then change only `docs/briefs/`, `docs/status.md` and decision numbering.
- **After:** the B122 head `838bb19` (code), compiled with `bun run build`.
- **Median of 20** for the empty-campaign timing. Each sample creates a new list and an empty campaign, then starts it.

## 1. Empty campaign: start to `finished`

Two clocks are measured, both from the status change that starts the campaign to the first read that shows `finished`.

- **Injected clock** (the runner fixture, `runnerFixture()` in `test/campaigns/runner/fixture.ts`). The clock delta is the time that the runner, on its own clock, takes to finish the campaign. The wall figure is the real time the fixture's drive loop spends on that sample; it measures the runner's work under a fake clock, not production latency.
- **Real clock** (the compiled `dist/iglo.email` over HTTP, data directory on disk, `PUT /status` then polling `GET` every 5 ms). This is the time an admin or client waits.

| Measure | Before (`origin/main`) | After (B122 head) |
|---|---|---|
| Injected clock, start to `finished` | 0 ms (20 of 20) | 5000 ms (20 of 20) |
| Fixture wall time per sample, median (min–max) | 5.0 ms (3.3–9.4) | 9.7 ms (8.8–14.6) |
| Real clock, start to `finished`, median (min–max) | 2.6 ms (2.3–5.5) | 5013.9 ms (5008.6–5021.3) |

Before, the wake finished the campaign at once, so the real-clock figure is the HTTP round trip. After, the campaign stays `running` for one scan interval (5 s), then the first scan finishes it. Both sides finish with `sent` 0 and the finished notification.

## 2. Real sends unchanged: existing campaign throughput

The existing harness is `test/campaigns/runner/measure.ts mixed`, run with `M32_SCENARIOS=campaign` (scenario `d22-campaign`: a campaign of 3,900 subscribers to a loopback SMTP sink, 60 s window, `concurrency` 5, `rate` 10). It is documented in [M3.2-runner.md](M3.2-runner.md). Three runs per side:

| Run | Before: delivered in window | Before: rate per second | After: delivered in window | After: rate per second |
|---|---|---|---|---|
| 1 | 767 | 12.78 | 770 | 12.83 |
| 2 | 772 | 12.87 | 769 | 12.82 |
| 3 | 769 | 12.82 | 768 | 12.80 |
| Median | 769 | 12.82 | 769 | 12.82 |

The most messages in any one second was 14 on every run, both sides. The harness's `backlogAtWindowEnd.sent` field read 0 on every run, both sides; it is pre-existing and was not investigated here.

Conclusion: the change leaves the throughput of a campaign with recipients unchanged within run-to-run variation (767–772 before, 768–770 after).

## Bounded in-memory state

The deferral uses the runner's existing `retryAt` map (`src/campaigns/runner/runner.ts`), keyed by campaign ID.

- An entry is set when a running campaign with no recipients is first visited, and removed when that campaign finishes (its next visit) or starts with recipients.
- A campaign that is **paused or cancelled inside its 5 s window keeps its entry until restart**, because pause and cancel do not clear `retryAt`. The same is true of the existing compile-error retry entries.
- The bound is one entry (a campaign ID and a timestamp; a V8 map entry of this shape is estimated at under 100 bytes, not measured) per campaign that was started with no recipients and then paused or cancelled within one scan interval. Reaching 1 MiB would take on the order of ten thousand such campaigns in a single process lifetime. An admin would have to create, start and pause that many empty campaigns without a restart, which is far beyond the administrative rate this server is built for, and a restart clears the map.
- Known consequence: if such a paused campaign is later resumed and still has no recipients, its stale entry is already due, so the resume's wake finishes it at once instead of after a scan. The outcome matches listmonk's (finished within a scan interval) and nothing is sent. Clearing the entry on pause would remove this, but it adds a write to the pause path for a rare case, so it was not done in B122.

## Reproducing

The probes were run as scratch files, not committed (this change is documentation only). Method:

1. Injected clock: `runnerFixture()`, `f.start()` once, then for 20 iterations create a list and an empty campaign, record the clock and `performance.now()`, call `f.status(id, "running")`, then `f.until(id, "finished")`.
2. Real clock: start `dist/iglo.email serve` on a loopback port with a fresh data directory, provision an API user as `test/contract/owned.ts` does, then for 20 iterations create a private single-opt-in list and an empty campaign on it, `PUT` status `running`, and poll `GET` every 5 ms until `finished`.
3. Throughput: `M32_SCENARIOS=campaign bun test/campaigns/runner/measure.ts mixed` after `bun run build`, three times per side.
