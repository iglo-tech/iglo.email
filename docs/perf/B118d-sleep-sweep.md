# B118d: `Bun.sleep` sweep (B118c item 7)

AGENTS.md: time-dependent behaviour is tested by advancing the injected clock, not by sleeping.
This sweep replaces each sleep that waits for a state with a wait on that state, and keeps the
sleeps that are the thing under test, with a reason. The count is `grep -rn "Bun.sleep" test`
(this also matches `Bun.sleepSync`, which is kept in two places below).

## Counts

| | Lines | Files |
|---|---|---|
| `main` at 5fa94ac1 | 252 | 108 |
| B118d head (as recorded in #207) | 154 | 75 |
| `main` at d5bef8d5 (measured again in B118e with `git grep`) | 156 | 77 |
| B118e head (`Bun.sleep` lines, `git grep`) | 154 | 77 |

Net: 98 fewer lines from `main` at 5fa94ac1. More calls were converted than that, because the new
`untilState` calls replaced several loops with one call each. The B118d head was recorded as 154
lines in 75 files; measured on merged `main` it is 156 in 77. That two-line, two-file difference
is not traced here: it is in the merged head, not in the B118e change.

B118e converts the two readiness polls that run in `bun run check` (`test/serve-port.ts` and
`test/bootstrap/cli.test.ts`), which were 2 of the 20 deferred state waits. The 154 remaining lines
are the kept sleeps (the table below; some rows group several lines), the 18 deferred state waits
(under "Deferred"), and a few lines the table does not name; B118e did not reconcile those few
line by line. The counts are `git grep` lines on each side.

## Helpers

- `test/wait.ts` `untilState(done, { label, progress, stallMs?, intervalMs?, describe? })`: a wait on
  real I/O. It fails by name when `progress()` has not changed for `stallMs` (default 3 s, the
  `WAIT_WALL_MS`). There is no total deadline: a slow host that keeps moving is not cut off by time
  alone, and the test's own timeout still bounds a body that never ends (B118c item 1). The wait's
  own test is `test/wait.test.ts` (four cases, two mutants shown).
- Stall windows of 10 s and 15 s (and 30 s in `import.test.ts`) would outlast a single-file run's
  5 s default before they fail by name. The files that wait that long call `setDefaultTimeout`
  (30 s; 40 s in `import.test.ts`), so the wait's label is reported first. A file-level
  `setDefaultTimeout` overrides the CLI `--timeout` (probed in `oven/bun:1.4.5`, B118e), so under
  `bun run test` those files keep their own value: 30 s, and 40 s for `import.test.ts`, not the
  gate's 30 s.
- The drains in `test/public/fixture.ts` and `test/tx/fixture.ts` are not `untilState` waits: they
  advance the injected clock at most 200 steps of 1 s, and fail by name unless exactly
  `drain(expectOpen)` sends are still open (B118e; `expectOpen` defaults to 0), so a send left open
  cannot pass a no-mail check. Before B118e they returned the count and no caller read it. The
  bound is in injected time, so it is the same window on every host.
- `waitWall` (unchanged): a wait on an injected clock or on microtasks, with `advance` for clock steps.
- Where a check's last value is the only progress signal (webhook and retention `until` helpers),
  the value's JSON is the progress. Where no signal exists (`/health` answering after a reference
  restart, a process's readiness), the stall window is the limit and the table says so.

Where a wait had a `.catch(() => undefined)`, the caller's `check`/`expect` still names the miss:
the helper only stops waiting, it no longer asserts. One wait (the MCP campaign finish) had no
caller check at all, so its `.catch` was removed and the stall now fails by name.

## Converted, by directory (one commit per directory)

| Directory | Commit | Mutation shown (reverted, not committed) |
|---|---|---|
| test/analytics | aa91c7d5 (+0a2fcd31 lint) | `until(1)` -> `until(2)`: `dashboard lists 2: condition not reached` |
| test/contract | 00877453 | `arrived(blocklisted, 4)` -> `5`: `arrival-subscriber.blocklisted-5: no progress for 10000 ms (4)` |
| test/messaging | ce55d425 | refused-test-send log count `> 0` -> `> 99`: `refused test send logged: no progress for 10000 ms (1)` |
| test/import | 09b3f83f | `100 rows imported` -> `100000`: `100 rows imported: no progress for 10000 ms (30000)` |
| test/backup | fcfaad2c | writers `>= 50` -> `5000000`: `writers reached 50: no progress for 10000 ms` |
| test/webhooks | d5f70b6d | sends-leaving-sending `=== 0` -> `-1`: `sends leaving sending: no progress for 3000 ms (0)` |
| test/tx | 1e5a6e01 | status test never true: `greeting timer ends the dispatch: no progress for 20000 ms (failed)` |
| test/subscribers | b4870584 | child count `=== before + 99`: the test fails with `Expected: true, Received: false` (this helper returns a boolean, so no label is shown) |
| test/campaigns, media, maintenance | 0bfbde70 | export-slot status `=== 999`: `export slots were not released: no progress for 5000 ms (429)` |
| test/bootstrap, retention | 89307048 | refused-target line count `> 99`: `refused private target logged: no progress for 20000 ms (1)` |
| test/admin, sends, schema | 4a8421fe | reset-mail count `<= 999`: `No mail for reset-known@example.test: no progress for 10000 ms (1)` |
| test/scheduler | 6244a653 | production never listens: `production did not listen: no progress for 20000 ms` (the crash script) |
| test/public, mcp, events | dc8fe7f1 | MCP campaign never `finished`: `campaign finished: no progress for 15000 ms (finished)` (after removing the `.catch`) |

The `test/wait.ts` helper itself (commit 2783d671): the stall timer not reset on progress
(`late change` case fails), and the stall check removed (the stalled case times out at 5 s).

## Kept sleeps (reasons)

Codes: **N** negative check (a window in which a mail, request or delivery would arrive, then an
absence is asserted); **Y** event-loop yield between steps; **S** settle with no observable state;
**K** the thing under test (a kill, a budget, a real-time deadline, a stall in a child process);
**M** measurement harness (load shape, pacing, a settle before sampling; opt-in scripts, not in
`bun run check`); **R** reference-only restart or reload pacing (the old process still answers
`/health` for a moment); **B** retry or lock backoff; **H** the poll interval inside a wait helper.

| File:line | Code | Reason |
|---|---|---|
| test/wait.ts:75 | H | poll interval of `untilState` |
| test/wait.ts:100 | H | yield inside `waitWall` (existing) |
| test/serve-port.ts:32 | K | a bounded drain: a stream end or 1 s, whichever first |
| test/serve-port.ts:96 | B | retry backoff between port-in-use attempts (50 ms × attempt) |
| test/production-build.ts:95 | B | build lock retry |
| test/contract/tx.ts:87 | N | absence window for an erroneous send (300 ms reference, 50 ms production) |
| test/contract/tx.ts:403 | N | idempotency: a duplicate would be sent within 200 ms |
| test/contract/analytics.ts:104 | R | reference restart pacing |
| test/contract/analytics.ts:671 | S | `created_at` ordering of the filler campaigns (5 ms apart) |
| test/contract/unsubscribe.ts:187 | N | no second mail after the send (200 ms) |
| test/contract/media.ts:72 | R | reference reload pacing |
| test/contract/bounces.ts:66 | R | reference reload pacing |
| test/contract/subscriber-activity.ts:54 | R | reference restart pacing |
| test/contract/public.ts:260 | R | reference reload pacing |
| test/contract/public.ts:420, 606, 741, 766, 1469 | N | absence windows (no mail sent for an opted-out or blocklisted address) |
| test/contract/maintenance.ts:67 | R | reference restart pacing |
| test/contract/maintenance.ts:222 | S | the running operation holds the one slot with no observable state; the 429 is the thing under test |
| test/contract/import.ts:564 | N | no repeat webhook for the second run (200 ms) |
| test/bootstrap/private-target-upgrade.test.ts:116 | S | `settle()`: nothing is refused, so no answer to wait for; the background check runs in 1 s |
| test/bootstrap/cli.test.ts:1032 | K | the server must still run at 4 s (B118c item 2) |
| test/bootstrap/cli.test.ts:1046 | K | the budget must end in real time before the refused start |
| test/analytics/analytics.test.ts:428 | Y | yield in the clock-step helper |
| test/analytics/analytics.test.ts:582 | K | a read still running after 50 ms (a timing negative) |
| test/analytics/analytics.test.ts:606 | K | bound on a settle race: ends on `whenSleeping`, the 2 s only if the loop is stuck |
| test/analytics/analytics.test.ts:609 | Y | lets the woken summary loop start before settling |
| test/analytics/analytics.test.ts:796 | K | a queued read must not start within its 300 ms timeout after close |
| test/analytics/analytics.test.ts:852 | S | lets the aborted request finish logging (no observable state) |
| test/analytics/analytics.test.ts:888 | K | the child's own program, which must still run when killed |
| test/analytics/hold-child.ts (`Bun.sleepSync`) | K | the held read transaction is the point |
| test/analytics/measure.ts:165, 171 | M | lag probe while work runs |
| test/analytics/measure-card.ts:12, 97, 104 | M | idle period, work pacing, probe |
| test/analytics/measure-budget.ts:45, 60, 131 | M | staggered pollers, 50 commits/s pacing, post-burst settle |
| test/tx/gate.test.ts:22, 41 | Y | yields for a queued waiter |
| test/tx/silent-marketing.test.ts:44 | Y | yield inside the clock-step wait |
| test/tx/silent-marketing.test.ts:61 | N | not retried: 300 ms after the clock moved past a retry |
| test/tx/measure-fairness.ts:48, 51, 59 | M | holders and pacing |
| test/tx/measure-memory.ts:37, 115 | M | holds the dispatch for the sampler; GC settle |
| test/tx/measure-attachments.ts:31, 73 | M | dispatch hold; settle |
| test/maintenance/budget.test.ts:42 | Y | yield in the budget's sleep hook |
| test/maintenance/measure-probe.ts:29 | M | probe pacing |
| test/maintenance/measure.ts:195, 244 | M | pacing; 5 s settle |
| test/campaigns/campaigns.test.ts:201, 494, 522 | N | no test-send mail reaches the sink (50–100 ms) |
| test/campaigns/measure.ts:63 | M | pacing |
| test/campaigns/runner/measure.ts:736, 739 | M | load shape (arrival pacing) |
| test/subscribers/query.test.ts:483 | K | the slow query must be running when the selection changes; it has no observable start |
| test/subscribers/query-limits.test.ts:14 | K | the timing check itself: a response within `ms`, else "pending" |
| test/subscribers/stage.test.ts:128 | K | the export is killed at varying points of its work |
| test/subscribers/measure-stage.ts:24, measure-query.ts:137 | M | GC and settle |
| test/subscribers/worker-terminate.ts:23, 26 | M | CPU burn window after terminate |
| test/events/events.test.ts:518 | Y | yield before `whenSleeping` |
| test/events/events.test.ts:597 | S | settle before the shed request (documented in place) |
| test/events/measure.ts:384, 402 | M | pacing |
| test/backup/backup measure.ts:141, 144, 189, 199 | M | writer pacing and measurement windows |
| test/backup/hold.test.ts:243, 284, 580 | N | `QUIET_MS`: nothing is sent during the quiet window |
| test/webhooks/webhooks.test.ts:480, 529, 573, 658, 1405, 1444 | N | no request arrives after a clock step (20 ms) |
| test/webhooks/webhooks.test.ts:1040 | N | no delivery after the webhook is deleted (100 ms) |
| test/webhooks/measure-bulk.ts:44 | M | pacing |
| test/bounces/ses.test.ts:436 | N | a failed request committed no delivery |
| test/bounces/ses.test.ts:450 | S | settle after both receipts (documented in place) |
| test/bounces/measure.ts:127 | M | pacing |
| test/import/import.test.ts:429 | S | timestamps differ (5 ms) |
| test/import/import.test.ts:515 | Y | stream yield |
| test/import/import.test.ts:626 | N | no repeat queued (200 ms) |
| test/import/measure.ts:88, 141 | M | pacing; idle probe |
| test/messaging/route-auth.test.ts:178 | N | no SMTP connection counted after a partial request (100 ms) |
| test/messaging/plain-executable.test.ts:273, 318, 356 | S | lets the send reach conversion before the `/health` comparison (the comparison is within one run) |
| test/messaging/test-send-trace.test.ts:123, 327, 359 | N | no message reaches the sink for a refused or failed test send |
| test/messaging/send-rate.test.ts:1030, 1077, 1124 | Y | yields between clock steps |
| test/schema/migration5.test.ts:146, 183 | N | nothing more arrives (200 ms); statuses unchanged (500 ms) |
| test/conditions/evaluate.test.ts:658 | K | two spin queries in flight; no observable in-flight state |
| test/db/writers.test.ts:54 | K | bounded delay: the writer must still be waiting (the thing under test) |
| test/unsubscribe/unsubscribe.test.ts:112 | H | poll interval of the stall-based `until` |
| test/unsubscribe/unsubscribe.test.ts:287 | K | a changed interval applies at once: the send after it is asserted |
| test/e2e/browser-sequences.ts:69, browser-operator.ts:137 | S | browser-pass settle (1.5 s) before reading the stored state |
| test/worked-example/run.ts:485, 510 | K | real-time waits for a due step and for 10 s waits to pass (a process down and up) |
| test/worked-example/run.ts:638 | S | one tick before the final check |
| test/media/media.test.ts:100, test/media/storage.test.ts:150 | S | lets an upload take its slot before the next request (no observable state) |
| test/media/measure.ts:90 | M | pacing |
| test/sequences/measure.ts:213 | M | arrival pacing |
| test/perf/m61/mixed.ts:490, 494, 504 | M | pacing; SIGUSR2 settle; tail for delivery latency |
| test/messaging/test-send-log.test.ts:121, 125 | — | **deferred item 2**: the "delivered test send logs nothing" settle. Left as it is (see "Deferred") |
| test/scheduler/measure.ts:27 | M | pacing |
| test/retention/measure.ts:212, measure-events.ts:84, 124 | M | due-time pacing; 5 s settle |
| test/bootstrap/cli.test.ts (readiness poll, startThroughCli) | — | converted in B118e (`untilState`, see "Deferred") |
| test/reference/smoke.ts:429 | K | the 35 s stop budget of the reference runner, in real time |
| test/serve-port.ts:220 | — | converted in B118e (`healthWhenReady`, `untilState`, see "Deferred") |

## Deferred: state waits not converted here

These still wait on a state with a sleep. The first bullet's two polls ran in `bun run check`, so no
Docker, opt-in or browser run was needed to change them: B118e converted both (`healthWhenReady` in
`test/serve-port.ts`, and the readiness wait in `startThroughCli`, `test/bootstrap/cli.test.ts`).
Readiness has no progress signal, so each uses `untilState` with a constant progress and a stall
window equal to its old budget: it fails by name with the last observation, and the bound is the
same 15 s (or the caller's timeout). The other bullets each need their own run to verify (a Docker
reference, an opt-in harness, or a browser pass), so B118e did not change them. They stay deferred.

- `test/sends/production.ts:198` (readiness poll, `sends:production`, Docker).
- `test/worked-example/harness.ts:92, 181`, `test/worked-example/run.ts:267, 278, 398` (enrollment
  and mail polls of the worked example; run with the production build).
- `test/public/browser.ts:107` (mail-link poll in a browser pass).
- `test/reference/run.ts:96`, `test/reference/smoke.ts:44`, `test/reference/smoke-client.ts:151`
  (service readiness; Docker).
- `test/perf/m61/outbox.ts:29`, `test/perf/m61/mixed.ts:180, 274` (outbox and server polls, opt-in).
- `test/maintenance/measure.ts:133` (30 s poll for a state, opt-in), `test/campaigns/runner/measure.ts:248, 353`
  (readiness and `waitFor` in the measurement harness, opt-in).
- `test/messaging/test-send-log.test.ts` "delivered test send logs nothing": the settle wait is
  deferred item 2 in the brief. No settled signal is observable through a public boundary: the test
  waits 20 ms after the message reaches the sink, and the outcome is logged from the emailer's own
  settle path. What is needed is a settled event for a test send (the `test_sends` row reaching a
  final status) that the test can wait on. The test is left as it is.

## Hardening backlog (B118e)

Kept as sleeps for this sweep, because the state each waits for is not visible through any public
boundary. Each is still a timing mechanism, so each needs the signal named here before it can be
a wait:

- `test/contract/maintenance.ts:222` (100 ms before the 429 slot check): the running operation's
  slot. Needs a public state for a running maintenance operation (a `running` flag or a status).
- `test/events/events.test.ts:597` (50 ms before the shed request): the held singles' arrival.
  Needs a server-side count of accepted in-flight event requests.
- `test/media/media.test.ts:100` and `test/media/storage.test.ts:150` (10 ms before the next
  request): an upload holding its slot. Needs a public count of open uploads.

Also noted, no change: `untilState` is a stall timer, so a progress value that flips between two
states (for example `no answer` and `status 503`) restarts the stall each time, and a stuck wait
can run on. No caller does this today: the progress strings are statuses or counts, and they
converge. Outside `bun test`, the test's own timeout does not bound a body. About a dozen callers
are not tests (the `test/contract/*.ts` modules run by `bun test/contract/cli.ts`, the crash
scripts, and the measurement scripts) and have no timeout of their own. An optional `signal` or
`maxMs` on `untilState` would close both, when a caller needs it.

## What this does not cover

- Negative checks (the N rows) are the largest kept group. A stronger form would wait on a settled
  signal for each path, which the product does not expose; that is out of scope for this sweep.
- The M rows are opt-in measurement scripts. They are not in `bun run check`, so their sleeps change
  no test outcome.

## B118e: mutation evidence (each mutant applied, run, reverted; none committed)

| Changed code | Mutation | Before the change | After the change |
|---|---|---|---|
| `test/public/fixture.ts` and `test/tx/fixture.ts` `drain()` | a `sending` row with no lease inserted before the no-mail drain in `paired-actions.test.ts` | passes (14 pass): the drain returns 1 and nobody reads it | fails by name: `drain: 1 mail or send still queued or sending after 200 steps (expected 0)` (13 pass, 1 fail) |
| `test/serve-port.ts` `healthWhenReady` | `listensOn` forced false, so no child ever counts as ready | not applicable (poll) | `test/bootstrap/private-target-upgrade.test.ts` with `--timeout=60000`: `Server ready: no progress for 30000 ms (starting); answered 200 but this process is not listening` |
| `test/bootstrap/cli.test.ts` `startThroughCli` | `listensOn` forced false | not applicable (poll) | `a server that runs past 3 s …` fails by its budget (`CLI did not exit before its budget ended`), the 9 s budget ends before the 15 s stall |

The drain mutant was the gap the B118d review named: no caller read the value `drain()` returned,
so a send left open passed every no-mail check. After the change every caller of `drain()` asserts
settlement (or states the one open row it expects, in `public.test.ts`); `test/public` is 125
pass, 0 fail, 12 files.

## B118e: counts and deferred items

- `Bun.sleep` lines: 156 in 77 files on `main` (d5bef8d5), 154 in 77 files at the B118e head. The
  two lines removed are the readiness polls in `test/serve-port.ts` and `test/bootstrap/cli.test.ts`.
- The deferred state waits that run in `bun run check` (the first bullet of "Deferred") are
  converted. The rest stay deferred: each needs a Docker, opt-in or browser run that B118e did not
  add to the acceptance (see the PR body).
- Brief item 3 (the 2FA and archive-preview branding, the B110 stack test, B114 log scoping, the
  B127 r3 items, the B101 shutdown name and runner per-message cost) is not done in this PR. Each
  is listed in the PR body with its reason, including a product question the manual-cancel item
  raised.
