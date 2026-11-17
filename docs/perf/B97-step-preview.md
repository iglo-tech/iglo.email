# B97: step preview and test send

Measured with `bun test/sequences/measure-preview.ts` ([D105](../design/09-decisions.md#d105-a-sequence-step-previews-and-test-sends-with-sample-data-lead-2026-11-17)) on the owner's macOS workstation (Apple silicon, Bun 1.4.4), in the in-process production owners of `test/scheduler/fixture.ts`: the same router, stores, renderer, emailer and loopback SMTP sink that `src/main.ts` wires, with a fake clock. It is not the compiled executable: the production harness cannot confirm a listening port on macOS (see [Host limits](#host-limits)). Not a CI threshold.

## Results

| Measure | n | Median | Notes |
|---|---|---|---|
| Step preview (`POST …/preview`, real subscriber, one aggregate, one event lookup) | 100 | 0.13 to 0.14 ms | request to response, in-process |
| Test send (`POST …/test`, one address) | 20 | 0.26 to 0.32 ms | request to acceptance; delivery is not awaited and each send settles before the next, as the four-send cap would otherwise answer 429 |
| Scheduler send path, baseline (`main`, aea108e) | 3 rounds of 100 | 1.59 and 1.86 ms per send | 300 messages delivered in each run |
| Scheduler send path, this branch | 3 rounds of 100 | 1.35 and 1.53 ms per send | 300 messages delivered in each run |

The scheduler rows are the step render path before and after the extraction ([D105](../design/09-decisions.md#d105-a-sequence-step-previews-and-test-sends-with-sample-data-lead-2026-11-17)): the same due enrollments, the same template with one aggregate, the same outbox and sink. The baseline runs were made from a clean tree with the same script (its preview section is skipped there, as the route does not exist). Run-to-run spread on this host is wide (about ±15%). The branch's two runs are below the baseline's two, so these runs show no slowdown from the shared builder; they are too few to claim a speed-up.

## What the numbers do not cover

- Test sends are timed to acceptance by the emailer's queue, not to SMTP delivery.
- The compiled executable was not timed; its readiness check cannot run here (below).

## Host limits

- `test/serve-port.ts` `listensOn` reads Linux `/proc/net/tcp`, so every test that starts the production server reports `The server did not start` or `Compiled production process readiness timed out` on macOS. Affected here: `test/mcp/*` (including `test/mcp/step-preview.test.ts`), `test/contract/owned` production lifecycle, `contract:normal`, `contract:roles`, and `test/messaging/notify-wiring.test.ts`. The MCP and contract suites were verified with an uncommitted local shim that answers the same question with `lsof`; it was reverted before committing.
- `test/messaging/send-rate.test.ts` (B37 pacing) is timing-sensitive on this host: the same tests fail on a clean `main` checkout, and the set of failing tests changes between runs.
- `test/templates/render.test.ts` (three exact 1 MiB output-bound tests) fails with `ECONNRESET` on a clean `main` checkout too.

## Open observation

With the fake clock, a plain run of 100 asynchronous transactional sends after 20 synchronous ones delivered 72 of 120 messages within a minute of clock-driven waiting, and no sequence or test-send code was involved (control run, `test/tx` fixture). In one combined run of this script, a scheduled message was recorded `unknown` at the sink after twenty test sends. The measurement therefore runs the scheduler section before any test send. This is a property of the in-process delivery under a fake clock, not of the step path; it is not investigated here.
