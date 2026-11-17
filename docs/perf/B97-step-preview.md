# B97: step preview and test send

Measured with `bun test/sequences/measure-preview.ts` ([D105](../design/09-decisions.md#d105-a-sequence-step-previews-and-test-sends-with-sample-data-lead-2026-11-17)) on the owner's macOS workstation (Apple silicon, Bun 1.4.4), in the in-process production owners of `test/scheduler/fixture.ts`: the same router, stores, renderer, emailer and loopback SMTP sink that `src/main.ts` wires, with a fake clock. It is not the compiled executable: the production harness cannot confirm a listening port on macOS (see [Host limits](#host-limits)). Not a CI threshold.

## Results

| Measure | n | Median | Notes |
|---|---|---|---|
| Step preview (`POST …/preview`, real subscriber, one aggregate, one event lookup) | 100 per run, 5 runs | 0.16 ms (runs 0.15 to 0.17) | request to response, in-process; includes the permission check after the body is read |
| Test send (`POST …/test`, one address) | 20 per run, 5 runs | 0.31 ms (runs 0.30 to 0.39) | request to acceptance; delivery is not awaited and each send settles before the next, as the four-send cap would otherwise answer 429 |
| Scheduler send path, baseline (`main`, aea108e) | 3 rounds of 100, 5 alternating runs | 1.25 ms per send (runs 1.23 to 1.69) | 300 messages delivered in each run |
| Scheduler send path, this branch | 3 rounds of 100, 5 alternating runs | 1.27 ms per send (runs 1.24 to 1.67) | 300 messages delivered in each run |

The scheduler rows are the step render path before and after the extraction ([D105](../design/09-decisions.md#d105-a-sequence-step-previews-and-test-sends-with-sample-data-lead-2026-11-17)): the same due enrollments, the same template with one aggregate, the same outbox and sink. The baseline is an archive of `main` (no preview route, so its preview section is skipped) measured by the same script in alternation with the branch. The two medians differ by about 1% and the run-to-run spread on this host is wider than that, so the runs show no slowdown from the shared builder.

Before the permission check after the body was added (the branch at 23d3204, same script, two runs), the step preview was 0.13 to 0.14 ms and the test send 0.26 to 0.32 ms. The added authorization is one more read of the caller's user and roles per request, which accounts for the difference.

## What the numbers do not cover

- Test sends are timed to acceptance by the emailer's queue, not to SMTP delivery.
- The compiled executable was not timed; its readiness check cannot run here (below).

## Host limits

- `test/serve-port.ts` `listensOn` reads Linux `/proc/net/tcp`, so every test that starts the production server reports `The server did not start` or `Compiled production process readiness timed out` on macOS. Affected here: `test/mcp/*` (including `test/mcp/step-preview.test.ts`), `test/contract/owned` production lifecycle, `contract:normal`, `contract:roles`, and `test/messaging/notify-wiring.test.ts`. The MCP and contract suites were verified with an uncommitted local shim that answers the same question with `lsof`; it was reverted before committing.
- `test/messaging/send-rate.test.ts` (B37 pacing) is timing-sensitive on this host: the same tests fail on a clean `main` checkout, and the set of failing tests changes between runs.
- `test/templates/render.test.ts` (three exact 1 MiB output-bound tests) fails with `ECONNRESET` on a clean `main` checkout too.

## Open observation (resolved: a fake-clock artifact)

An earlier combined run recorded a scheduled message `unknown` after twenty test sends. Test sends cannot cause it by themselves: a test send journals no send row, and it reaches a scheduled send only through the emailer's shared pool. The `unknown` comes from the emailer's 60-second cut-off, which runs on the injected clock. This script advances that clock one second per event-loop turn, so a loopback SMTP exchange that takes milliseconds can pass 60 turns; the cut-off then cancels the pool and journals the in-flight send `unknown`/`uncertain`. With a temporary log in the cut-off (reverted), a run of 150 scheduled sends with no test send at all fired it nine times and left 19 sends `unknown`. A test send's own cut-off would cancel every operation on the same pool in the same way (`cancelPool`; the forced cancellation of [04-sending.md](../design/04-sending.md)), so a slow test send is no different from a slow scheduled one; this measurement did not exercise that case. The script now waits until every send has settled and reports the statuses; its earlier check looked only at the newest 100 rows.

