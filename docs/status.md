# Status

Updated 2026-11-07. [Work plan](design/11-work-plan.md) · [Runbook](chief-of-staff.md)

## Active

All 44 plan tasks are merged and M6.3 is proven on draft prerelease `v0.1.0-rc.1`. Owner rule 2026-11-01: work continues until nothing remains that agents can do; see the [runbook](chief-of-staff.md#when-work-ends).
State-machine audit (B17–B22) merged. B23 (#75), B24 (#76) and B25 (#77, D86) merged. B26 is with its worker: [brief](briefs/B26.md), branch `task/B26-tx-memory`. Recovery: ~/.local/state/iglo-email-cos/lock.json.
Owner-only, blocking nothing else: publishing a release and PDF viewers on real devices. The owner sends through Amazon SES, not Mailgun (2026-11-02), so the real Mailgun check is dropped and SES bounces shipped in B9; the owner lists their SNS topic in `bounce.ses_topic_arns` (see operations.md).

## Work queue

Run in order, one at a time, through the normal stages. Write each brief from the backlog lines below and remove a line when it merges. Decisions are never owner items (runbook): agents decide, log and continue.

1. B26: tx memory budget ([brief](briefs/B26.md)).
2. B27: remaining intermittent watch lines: re-run each named case once on a quiet host; close lines with no failure since their last fix, keep diagnostics.

## Owner decisions

[D73](design/09-decisions.md#d73-sonnet-workers-opus-lead-and-an-opus-high-reviewer): Sonnet 5.5 medium workers and project default, Opus 5.5 medium lead, Opus 5.5 high reviewer.
[D68](design/09-decisions.md#d68-anthropic-models-only-opus-reviewer): Anthropic models only, no Fable; the reviewer is a fresh Opus5.5 xhigh delegate.
[D56](design/09-decisions.md#d56-owner-directed-models-review-and-local-verification): Opus5.5 medium work/lead; Haiku5.5 medium mechanical bulk only; one reviewer (Opus xhigh since D68); lead+reviewer council; fix-only later rounds; serial foreground local verification; manual-only CI.
[D57](design/09-decisions.md#d57-compatible-client-results-and-safe-input-hardening): realistic-client result compatibility; safe exotic-input response differences are backlog; formats, auth/permissions, atomicity and actual security stay mandatory.
[D67](design/09-decisions.md) (agents, for owner review): every backup carries a restore hold that stops all sending until released.
[D66](design/09-decisions.md) (agents, for owner review): authored HTML passes an allow-list before the admin editor; `style` is kept.
[D65](design/09-decisions.md) (agents, for owner review): `@playwright/test` as a dev dependency for adapted specs.
[D64](design/09-decisions.md) (agents, for owner review): the upload root must be inside the data directory; a bad root refuses media only.
[D63](design/09-decisions.md) (agents, for owner review): durable Mailgun receipts; rows no wipe reaches keep codes only.
[D62](design/09-decisions.md) (agents, for owner review): analytics reads run in a read-only helper process.
[D61](design/09-decisions.md#d61-outbound-webhook-delivery-and-privacy) (agents, for owner review): webhooks clear personal data on deletion; a public wipe keeps only numeric ID and UUID; bulk actions capped at 50,000 deliveries.
[D60](design/09-decisions.md#d60-explicit-trusted-proxies-for-client-addresses) (agents, for owner review): `security.trusted_proxies` for client addresses behind a reverse proxy, default empty.
[D59](design/09-decisions.md#d59-campaign-pacing-sleeps-only-the-rest-of-the-second) (agents, for owner review): campaign workers pace with a rolling one-second window per worker.
[D58](design/09-decisions.md#d58-stage-marketing-transactional-sends-until-m24) (agents, for owner review): tx marketing sends are journaled as skipped until M2.4.

## Automation and capacity

Schedule scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280 stays enabled and unbound. Continuous run starts2026-10-28T20:34:55.959528+00:00; no task/session cutoff.
Project default is Sonnet 5.5 medium (D73); Scheduler API has no per-task model selector; prompt/default can be aligned, separately pinned scheduler model cannot be claimed.
Host disk/memory are constrained; no protected cache/worktree/export cleanup or VM policy changes. One role verifies at a time. Healthy redundant check-ins settle only themselves.

## Done

| Task         | PR                                                     | Merge   | Result                                                            |
| ------------ | ------------------------------------------------------ | ------- | ----------------------------------------------------------------- |
| B25          | [#77](https://github.com/iglo-tech/iglo.email/pull/77) | 645b901 | D86: keep `synchronous = FULL` (second-send and lost-ack risk)    |
| B24          | [#76](https://github.com/iglo-tech/iglo.email/pull/76) | 66e7003 | OpenAPI path types; migration 18 (bounce `count: 0`, stale TOTP)  |
| B23          | [#75](https://github.com/iglo-tech/iglo.email/pull/75) | f559d00 | Unsent push not `unknown`; live pushes keep their lease (D80)     |
| B16          | [#67](https://github.com/iglo-tech/iglo.email/pull/67) | 2511c76 | Click on a linked banner keeps visible spaces (D79)               |
| B15          | [#66](https://github.com/iglo-tech/iglo.email/pull/66) | cfd6798 | Banner Backspace, `<br>` cleanup narrowed to banners (D79)        |
| B14          | [#65](https://github.com/iglo-tech/iglo.email/pull/65) | 1d7a72f | Linked held-image caret rule (D79), Backspace and click tests     |
| B13          | [#64](https://github.com/iglo-tech/iglo.email/pull/64) | c0536b9 | Held-image caret (D79); flaky tests diagnosed, not reproduced     |
| B12          | [#63](https://github.com/iglo-tech/iglo.email/pull/63) | 9b10ec6 | Build lock, no-undef, editor fixes, bounded tx overtaking (D78)   |
| B11          | [#62](https://github.com/iglo-tech/iglo.email/pull/62) | 8d28d54 | Event latency measured; D22 and process model left to owner (D77) |
| E2e speed    | [#61](https://github.com/iglo-tech/iglo.email/pull/61) | 8aeb257 | Parallel e2e stacks, default 2 (17→~10 min)                       |
| Test speed   | [#60](https://github.com/iglo-tech/iglo.email/pull/60) | 893c85f | Parallel `bun run test`, one build, `bun check` (547→~145 s)      |
| B10          | [#59](https://github.com/iglo-tech/iglo.email/pull/59) | edcebf7 | Backlog defects; lead decided after round 3 (held styles)         |
| B8           | [#58](https://github.com/iglo-tech/iglo.email/pull/58) | ae83f35 | Intermittent fixes, contract and lock tests, settings ref fixed   |
| B7           | [#57](https://github.com/iglo-tech/iglo.email/pull/57) | fb7ea5a | Analytics egress budget, WAL gap, disk-staged selections          |
| B9           | [#56](https://github.com/iglo-tech/iglo.email/pull/56) | 6669094 | SES/SNS bounces, topic allowlist (D75)                            |
| B6           | [#55](https://github.com/iglo-tech/iglo.email/pull/55) | 33d8e65 | Tx attachment budget, finishAll tests, paced events (D74)         |
| B5           | [#54](https://github.com/iglo-tech/iglo.email/pull/54) | 92c5d90 | Reschedule, live condition validation, activity tab               |
| B4           | [#53](https://github.com/iglo-tech/iglo.email/pull/53) | 785594f | ALTCHA and hCaptcha on public forms (D72)                         |
| B3           | [#52](https://github.com/iglo-tech/iglo.email/pull/52) | 5dfea64 | Admin CSP, nosniff, editor containment (D71)                      |
| B2           | [#51](https://github.com/iglo-tech/iglo.email/pull/51) | c4a24a5 | Retention of sessions, webhook rows and send bodies (D70)         |
| B1           | [#50](https://github.com/iglo-tech/iglo.email/pull/50) | 07e3ace | One process per data directory (D69)                              |
| M6.3         | [#48](https://github.com/iglo-tech/iglo.email/pull/48) | 2013ada | Release workflow, version, verification, packaging                |
| M6.4         | [#49](https://github.com/iglo-tech/iglo.email/pull/49) | 21e5bea | OpenAPI, subscriber export and activity routes                    |
| M6.2         | [#47](https://github.com/iglo-tech/iglo.email/pull/47) | e191856 | Backup, restore hold (D67), reset-password, operations guide      |
| M5.5         | [#45](https://github.com/iglo-tech/iglo.email/pull/45) | 25bf1f4 | Sequence screens, subscriber tabs, test mode                      |
| M4.6         | [#44](https://github.com/iglo-tech/iglo.email/pull/44) | bbb6570 | Analytics, maintenance, logs; log buffer holds safe fields        |
| M4.5         | [#43](https://github.com/iglo-tech/iglo.email/pull/43) | 6481e54 | Bounces, media, import, forms screens                             |
| M4.4         | [#42](https://github.com/iglo-tech/iglo.email/pull/42) | 39e710c | Settings, users, roles, profile; usable last admin                |
| M4.3         | [#41](https://github.com/iglo-tech/iglo.email/pull/41) | e54fe8c | Templates and campaigns screens; HTML allow-list D66              |
| M4.2         | [#40](https://github.com/iglo-tech/iglo.email/pull/40) | b7ab730 | Subscribers and lists screens                                     |
| M4.1         | [#39](https://github.com/iglo-tech/iglo.email/pull/39) | 68defb0 | Admin shell, auth screens, dashboard, e2e harness; D65            |
| M1.9         | [#38](https://github.com/iglo-tech/iglo.email/pull/38) | 7a21684 | CSV import; log holds no personal data; D61 revised               |
| M3.5         | [#37](https://github.com/iglo-tech/iglo.email/pull/37) | 8b38fba | Media, attachments, data-embed; storage boundary D64              |
| M3.4         | [#36](https://github.com/iglo-tech/iglo.email/pull/36) | 6375f5c | Bounces, actions, signed Mailgun webhook; D63                     |
| M3.3         | [#35](https://github.com/iglo-tech/iglo.email/pull/35) | a69abd7 | Analytics through a killable read-only child process (D62)        |
| M2.6         | [#34](https://github.com/iglo-tech/iglo.email/pull/34) | 3b99900 | Signed outbound webhooks; wipe clears personal data               |
| M5.4         | [#25](https://github.com/iglo-tech/iglo.email/pull/25) | b934fb2 | Sequence scheduler                                                |
| Test hygiene | [#24](https://github.com/iglo-tech/iglo.email/pull/24) | a74c4c9 | Ignore host loopback port probes (lead-merged, test-only)         |
| M5.3         | [#23](https://github.com/iglo-tech/iglo.email/pull/23) | 8bd33f6 | Sequences and enrollments                                         |
| M5.2         | [#22](https://github.com/iglo-tech/iglo.email/pull/22) | 8b328c8 | Sequence conditions                                               |
| M1.7         | [#21](https://github.com/iglo-tech/iglo.email/pull/21) | 0d40045 | Subscriber query/search/export                                    |
| M5.1         | [#20](https://github.com/iglo-tech/iglo.email/pull/20) | 4232631 | Subscriber events API                                             |
| M2.4         | [#19](https://github.com/iglo-tech/iglo.email/pull/19) | 5368d30 | Unsubscribe/cap/tracking                                          |
| M2.3         | [#18](https://github.com/iglo-tech/iglo.email/pull/18) | 7a56cb7 | Transactional API                                                 |
| M1.8         | [#17](https://github.com/iglo-tech/iglo.email/pull/17) | 17eaf1c | Templates/bounded Liquid                                          |
| M2.2         | [#16](https://github.com/iglo-tech/iglo.email/pull/16) | 4328bf0 | Durable journal/outbox                                            |
| M2.1         | [#15](https://github.com/iglo-tech/iglo.email/pull/15) | 542bf92 | SMTP/outcomes                                                     |
| M1.2         | [#14](https://github.com/iglo-tech/iglo.email/pull/14) | 043973d | Settings/session lifetime                                         |
| M1.6         | [#13](https://github.com/iglo-tech/iglo.email/pull/13) | 7764c13 | Subscribers/external IDs                                          |
| M1.5         | [#12](https://github.com/iglo-tech/iglo.email/pull/12) | da66ca0 | Lists CRUD/counts                                                 |
| M1.4         | [#11](https://github.com/iglo-tech/iglo.email/pull/11) | b60a0e8 | Roles/TOTP                                                        |
| M1.3         | [#10](https://github.com/iglo-tech/iglo.email/pull/10) | 76122c0 | Users/authentication                                              |
| M1.1         | [#9](https://github.com/iglo-tech/iglo.email/pull/9)   | 34a246f | v1 schema                                                         |
| M0.8         | [#8](https://github.com/iglo-tech/iglo.email/pull/8)   | 5c048d1 | SMTP/Liquid spikes                                                |
| M0.7         | [#7](https://github.com/iglo-tech/iglo.email/pull/7)   | 8a0b3bf | SQLite load spike                                                 |
| M0.6         | [#6](https://github.com/iglo-tech/iglo.email/pull/6)   | 986e3ed | JSX/page shell/assets                                             |
| M0.5         | [#5](https://github.com/iglo-tech/iglo.email/pull/5)   | 1147650 | Contract suite                                                    |
| M0.4         | [#4](https://github.com/iglo-tech/iglo.email/pull/4)   | a988c62 | SQLite and loop primitives                                        |
| M0.3         | [#3](https://github.com/iglo-tech/iglo.email/pull/3)   | cb41fd6 | HTTP/app contracts                                                |
| M0.2         | [#2](https://github.com/iglo-tech/iglo.email/pull/2)   | 2946b45 | Pinned reference harness                                          |
| M0.1         | [#1](https://github.com/iglo-tech/iglo.email/pull/1)   | 7dffb86 | Skeleton                                                          |

## Hardening backlog

- Intermittent: `route-auth` "held SMTP body denies disabled before a connection" failed once in M1.9 (`smtp.count()` 1). B8 could not reproduce it (22 runs of the file's four cases pass on a host at load ~12); the SMTP peer now lists each counted client (remote port, opening line) so the next failure names who connected. B13: 20 more runs of the file under 12 CPU burners on 6 CPUs, no failure; no cause found.
- Intermittent: `users.e2e.js` "edits a user" and "the screen does not raise your own permissions" failed now and then (`page.goto` interrupted by the page's own reload). Likely cause, not reproduced: the toast wait did not prove that the reload had happened. B13 makes the four save-then-reload sites wait for the page's `load` event first; 76 test runs (4 repeats of the file, 6 CPU burners) and 69 clean runs before pass. Keep open until a failure is seen with the new wait.
- Media: supported PDF viewers unverified (needs real devices).
- Role numeric JSON IDs above JavaScript safe integer range: safe rejection remains (D34). B10 left it: IDs are allocated from 1 by AUTOINCREMENT, so a list ID above 9007199254740991 needs about 9e15 inserts and exists only when a test advances the allocator; a lossless parse of numeric JSON would touch every JSON body reader for no realistic client.
- Event latency under full mixed load: B11 measured it ([evidence](perf/B11-event-latency.md), [D77](design/09-decisions.md)); B25 decided durability: [D86](design/09-decisions.md) keeps `synchronous = FULL` everywhere ([evidence](perf/B25-durability.md); its FULL/NORMAL series was disturbed and is not re-run, since no result could change D86). Remaining: a process-model change, with no measured expected gain (main-thread CPU is inferred by elimination).
- Intermittent: `test/import/import.test.ts` "SIGTERM stops an import…" (SIGTERM-interrupted import, then a restart) failed once under load in the B11 review (`status()` returned no `data` envelope after the restart). B13 could not reproduce it (27 runs of the lifecycle cases, 15 of them under 12 CPU burners, and 5 of the whole file under load; the server only listens after startup, so it is not an early start). `status()` now throws with the HTTP status and body of a reply without `data`, so the next failure names the cause.
- Paced event retention drains about 380 rows/s (the price of not holding back sends, [D74](design/09-decisions.md#d74-synchronous-attachment-sends-share-a-memory-budget-event-retention-joins-the-paced-loop)).
- B7 staging ([#57](https://github.com/iglo-tech/iglo.email/pull/57)): a read queued during a forced WAL gap can wait the full 30 s and get 429 (the gap is D62's price for restarting the WAL under continuous polling; a long read holds it open, and an earlier admission would block the checkpoint); analytics responses over 64 KiB are chunked with no Content-Length (B10 tried an explicit header: Bun ignores it on streamed bodies, and sending the bytes whole would drop the egress accounting that releases when the client has read them).
- Tests (B12): the `templates-campaigns` connection reset has no reproduction. The file takes 4.2-4.5 s on an idle host (6 clean runs), against the 5 s default timeout it had when the reset was seen at load ~12; a test that times out has its fixture closed under the request still in flight, which reads as a reset. B8 raised the file's timeout to 60 s and the parallel runner uses 30 s. Kept open only until a reset is seen with the longer timeout. B13: 12 more runs of the file under 12 CPU burners, all clean at the 30 s timeout; no change.
- Host load: in the B15 round-2 review, other projects' suites pushed load to 25-43 and `bun run check` hit timeouts in two backup test files (both pass alone, 9/9).
- E2e under host stall: in the B13 review, `maintenance.e2e.js:207` and `campaign-safety.e2e.js:281` failed together after about 2.5 min against a 30 s timeout at load 12-14 (other projects' suites), then passed 23/23 on rerun. Watch for a repeat on a quiet host.
- Wiped sends ([#74](https://github.com/iglo-tech/iglo.email/pull/74)): D85 also silences `send.failed` for admin deletes without a wipe (for owner review).
- Outbox ([#75](https://github.com/iglo-tech/iglo.email/pull/75)): any synchronous `push` throw is treated as never pooled (no realistic trigger found); the `claimOne` guard test does not reach the `UPDATE` guard.
- B24 ([#76](https://github.com/iglo-tech/iglo.email/pull/76)): no test sends a bounce after the `count: 0` rewrite or logs in as a migrated account; a hand-edited non-object bounce rule stops migration 18 (transactional, snapshot first); the path-type check throws instead of reporting if a path entry is not an operation.
- New safe exotic-response differences go here by PR link; actual safety/auth/data defects never become backlog merely by relabelling.
