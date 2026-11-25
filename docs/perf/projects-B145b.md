# B145b: effective rate and quota guard measurements

Required by `AGENTS.md` for sending changes and by the B145b brief: the guard's check runs on every grant, so outbox and campaign throughput are measured before and after, with no SES API keys and with a snapshot far from the hold line. Decision: [D161](../design/09-decisions.md#d161-effective-rate-and-quota-guard-b145b-lead-2026-11-25).

## Setup

- Host: native Linux x86-64, 12 cores (D147). No other worker ran tests or measurements during the series; the 1-minute load average before each run was 0.8 to 2.0 (in the raw lines).
- **Before:** `main` at `77fafdf` (B141 and B145a merged), unpacked with `git archive` under `node_modules/.cache/b145b-control`. It reads the SES snapshot but paces by `messaging.max_send_rate` alone and has no guard.
- **After:** this branch.
- **Harness:** `test/perf/projects/guard-throughput.ts`, the B141 throughput script ([projects-B141](projects-B141.md)) with the instance in the script's process, because the compiled executable cannot be pointed at a stand-in for SES `GetAccount` (it only calls AWS's endpoint, D159). The same file was copied into the control tree and run there, so each side runs its own sources. A loopback SMTP sink, HTTP only. Order alternates per run (odd runs before first). Medians of 5 runs per side and mode.
- **Workload:** 2,000 async **marketing** `POST /api/tx` (the outbox's marketing loop, which asks the dispatcher for slots, so the guard is on its path; transactional starts never consult it), timed to the sink's last message; then one campaign to 5,000 subscribers.
- **Modes:**
  - `none`: no SES API keys, `messaging.max_send_rate` 0 (no cap), as the B141 series.
  - `far`: the keys saved; the stand-in answers `Max24HourSend` 1,000,000,000, `SentLast24Hours` 0 and `MaxSendRate` 20,000; the setting is 10,000, its highest. The effective rate is 10,000 on both sides (the setting is the lower), the snapshot is far from the hold line, so the after side checks `held()` on every grant and never holds.
- Raw lines: [`projects-B145b.jsonl`](projects-B145b.jsonl).

## Results

| Mode | Measure | Before (runs) | After (runs) | Before median | After median | Change |
|---|---|---|---|---|---|---|
| none | Outbox msg/s | 523.8, 521.0, 529.4, 517.4, 513.6 | 525.3, 522.7, 513.2, 545.0, 531.3 | 521.0 | 525.3 | +0.8% |
| none | Campaign msg/s | 1647.0, 1709.0, 1717.0, 1658.7, 1669.4 | 1658.1, 1658.7, 1646.9, 1699.7, 1687.7 | 1669.4 | 1658.7 | −0.6% |
| far | Outbox msg/s | 466.9, 470.1, 463.2, 463.9, 465.2 | 462.2, 469.2, 466.3, 464.1, 464.4 | 465.2 | 464.4 | −0.2% |
| far | Campaign msg/s | 837.0, 839.7, 835.3, 838.7, 839.6 | 838.3, 837.9, 833.1, 836.3, 840.1 | 838.7 | 837.9 | −0.1% |

- No difference outside the run-to-run spread in either mode. The check is a read of one boolean the SES account keeps up to date when a snapshot or a setting changes; nothing is computed per grant.
- The `far` campaign runs at about 838 msg/s on both sides: at a positive rate every start waits for its tick (`1000 / rate` ms, 0.1 ms at 10,000/s) on the timer, which is the dispatcher's pacing (B141), not the guard. The `none` mode, at rate 0, is the loops' own throughput and matches the B141 series (outbox there counted transactional rows).
