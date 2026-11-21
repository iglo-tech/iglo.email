# B116: skip reasons, cost of a refused start

Decision: [D131](../design/09-decisions.md#d131-a-refused-sequence-start-is-named-with-its-reason-and-campaign-skips-keep-one-lead-2026-11-21). Sending and storage change, so the cost is measured before and after on the same host with the same scripts.

## Setup

- Host: macOS arm64 workstation, Bun 1.4.5, in process, no network. Each script drives the real code path through a fixture (the scheduler fixture for events and the subscriber page, the runner fixture for the push-time check), on an injected clock with a loopback SMTP sink.
- Before: `origin/main` at `adf30b6`, archived with `git archive` and run with the same two scripts: `test/sequences/measure-skips.ts` and `test/campaigns/runner/measure-eligibility.ts`. The sends code there journals a blocked start as nothing.
- After: this branch. Two runs of each script per tree; the table gives both values, the median of five runs inside each.

## Results

| Measure | Before (`origin/main`) | After | Change |
| --- | --- | --- | --- |
| Plain event, no sequence triggered (ms per event) | 0.1984, 0.2079 | 0.2023, 0.2036 | none, within noise |
| Started event, transactional sequence replaces its enrollment (ms per event) | 0.2600, 0.2506 | 0.2609, 0.2615 | none, within noise |
| Blocked event, blocklisted subscriber, one marketing and one transactional sequence refused (ms per event) | 0.1507, 0.1509 (nothing recorded) | 0.1614, 0.1599 | +0.01 ms (about 7%): one `UPDATE` of the event's own outcome |
| Subscriber events page, 50 of 5,000 events (ms per request) | 1.3412, 1.3482 | 0.8970, 0.8986 | about 0.45 ms faster (about 33%) |
| Push-time eligibility check, once per recipient (µs) | 4.43 | 4.64 | +0.2 µs (about 5%) |

Each figure is the median of five runs of 1,000 events (events), 100 requests (page) or 20,000 checks (eligibility).

### The events page changed shape on purpose

The first version of the page query selected the outcome column in the same statement that sorted the subscriber's events. The page then measured 3.74 ms in two runs. The rows of blocked events carry the outcome JSON, and SQLite carries every selected column through the sort, so the wide column cost on every candidate row. A probe, not kept, timed the SQL alone on 5,000 events of one subscriber:

| Query shape | Plain subscriber | Blocked subscriber |
| --- | --- | --- |
| Before (no outcome column) | 1.8 ms | 1.8 ms |
| Outcome column in the sorted select | 1.9 ms | 4.1 ms |
| IDs sorted alone, rows read by ID (shipped) | 0.7 ms | 0.7 ms |

The page now sorts the IDs of the 50 rows it returns and reads those rows by ID. That is the faster shape for every subscriber, so the page is faster than before, not only than the first version.

## Storage

- Migration 25 adds one nullable column, `campaign_deliveries.reason`, and a partial index on the `skipped` rows. It does not backfill: a skip recorded before it keeps no reason.
- A refused start writes the event's outcome into the existing `events.enrollments` column. For two refused sequences the JSON is about 170 bytes, `{"started":[],"ended":[],"grants":[],"skipped":[{"sequence_id":…,"reason":"subscriber_blocklisted"},…]}`. The column holds nothing for an event with no refusal and no idempotency key, so the events of subscribers that never trip a refusal store the same as before.
- Bound: one entry per sequence the event would have started. A tenant with many sequences that all trigger on one event writes one entry for each, as the existing `started` and `ended` lists already do. Nothing is written for an event older than the 7-day trigger window.

## Sends

- `bun run sends:production` on `origin/main` (`adf30b6`, same container recipe as CI's reference job): four `PASS` lines, exit 0. The branch's result is in the pull request.
- Send rows and their statuses are unchanged. The only send-side change is that a campaign's skipped delivery now names its reason, and that record is not a send.

## Not measured

- The full campaign runner (`test/campaigns/runner/measure.ts`) drives the compiled build and writes M3.2 results. The per-recipient change is the eligibility check measured above: one scalar lookup, which is the 0.2 µs.
- The admin events tab renders one more column; no browser timing was taken.
