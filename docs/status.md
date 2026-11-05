# Status

Updated 2026-11-03. [Work plan](design/11-work-plan.md) · [Runbook](chief-of-staff.md)

## Active

All 44 plan tasks are merged and M6.3 is proven on draft prerelease `v0.1.0-rc.1`. Owner rule 2026-11-01: work continues until nothing remains that agents can do; see the [runbook](chief-of-staff.md#when-work-ends).
B11 is with its worker: [brief](briefs/B11.md), branch `task/B11-event-latency`. Test speed: [#60](https://github.com/iglo-tech/iglo.email/pull/60) merged (`bun run check` ~145 s, was 547 s); e2e speed [#61](https://github.com/iglo-tech/iglo.email/pull/61) merged (`bun run e2e` ~10 min at 2 stacks, was 17; `E2E_WORKERS` for more). Recovery: ~/.local/state/iglo-email-cos/lock.json.
Owner-only, blocking nothing else: publishing a release. The owner sends through Amazon SES, not Mailgun (2026-11-02), so the real Mailgun check is dropped and SES bounces shipped in B9; the owner lists their SNS topic in `bounce.ses_topic_arns` (see operations.md).

## Work queue

Run in order, one at a time, through the normal stages. Write each brief from the backlog lines below and remove a line when it merges.

1. B11: event latency ([brief](briefs/B11.md)).
2. B12: anything still left in the backlog that agents can do.

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

| Task         | PR                                                     | Merge   | Result                                                          |
| ------------ | ------------------------------------------------------ | ------- | --------------------------------------------------------------- |
| E2e speed    | [#61](https://github.com/iglo-tech/iglo.email/pull/61) | 8aeb257 | Parallel e2e stacks, default 2 (17→~10 min)                     |
| Test speed   | [#60](https://github.com/iglo-tech/iglo.email/pull/60) | 893c85f | Parallel `bun run test`, one build, `bun check` (547→~145 s)    |
| B10          | [#59](https://github.com/iglo-tech/iglo.email/pull/59) | edcebf7 | Backlog defects; lead decided after round 3 (held styles)       |
| B8           | [#58](https://github.com/iglo-tech/iglo.email/pull/58) | ae83f35 | Intermittent fixes, contract and lock tests, settings ref fixed |
| B7           | [#57](https://github.com/iglo-tech/iglo.email/pull/57) | fb7ea5a | Analytics egress budget, WAL gap, disk-staged selections        |
| B9           | [#56](https://github.com/iglo-tech/iglo.email/pull/56) | 6669094 | SES/SNS bounces, topic allowlist (D75)                          |
| B6           | [#55](https://github.com/iglo-tech/iglo.email/pull/55) | 33d8e65 | Tx attachment budget, finishAll tests, paced events (D74)       |
| B5           | [#54](https://github.com/iglo-tech/iglo.email/pull/54) | 92c5d90 | Reschedule, live condition validation, activity tab             |
| B4           | [#53](https://github.com/iglo-tech/iglo.email/pull/53) | 785594f | ALTCHA and hCaptcha on public forms (D72)                       |
| B3           | [#52](https://github.com/iglo-tech/iglo.email/pull/52) | 5dfea64 | Admin CSP, nosniff, editor containment (D71)                    |
| B2           | [#51](https://github.com/iglo-tech/iglo.email/pull/51) | c4a24a5 | Retention of sessions, webhook rows and send bodies (D70)       |
| B1           | [#50](https://github.com/iglo-tech/iglo.email/pull/50) | 07e3ace | One process per data directory (D69)                            |
| M6.3         | [#48](https://github.com/iglo-tech/iglo.email/pull/48) | 2013ada | Release workflow, version, verification, packaging              |
| M6.4         | [#49](https://github.com/iglo-tech/iglo.email/pull/49) | 21e5bea | OpenAPI, subscriber export and activity routes                  |
| M6.2         | [#47](https://github.com/iglo-tech/iglo.email/pull/47) | e191856 | Backup, restore hold (D67), reset-password, operations guide    |
| M5.5         | [#45](https://github.com/iglo-tech/iglo.email/pull/45) | 25bf1f4 | Sequence screens, subscriber tabs, test mode                    |
| M4.6         | [#44](https://github.com/iglo-tech/iglo.email/pull/44) | bbb6570 | Analytics, maintenance, logs; log buffer holds safe fields      |
| M4.5         | [#43](https://github.com/iglo-tech/iglo.email/pull/43) | 6481e54 | Bounces, media, import, forms screens                           |
| M4.4         | [#42](https://github.com/iglo-tech/iglo.email/pull/42) | 39e710c | Settings, users, roles, profile; usable last admin              |
| M4.3         | [#41](https://github.com/iglo-tech/iglo.email/pull/41) | e54fe8c | Templates and campaigns screens; HTML allow-list D66            |
| M4.2         | [#40](https://github.com/iglo-tech/iglo.email/pull/40) | b7ab730 | Subscribers and lists screens                                   |
| M4.1         | [#39](https://github.com/iglo-tech/iglo.email/pull/39) | 68defb0 | Admin shell, auth screens, dashboard, e2e harness; D65          |
| M1.9         | [#38](https://github.com/iglo-tech/iglo.email/pull/38) | 7a21684 | CSV import; log holds no personal data; D61 revised             |
| M3.5         | [#37](https://github.com/iglo-tech/iglo.email/pull/37) | 8b38fba | Media, attachments, data-embed; storage boundary D64            |
| M3.4         | [#36](https://github.com/iglo-tech/iglo.email/pull/36) | 6375f5c | Bounces, actions, signed Mailgun webhook; D63                   |
| M3.3         | [#35](https://github.com/iglo-tech/iglo.email/pull/35) | a69abd7 | Analytics through a killable read-only child process (D62)      |
| M2.6         | [#34](https://github.com/iglo-tech/iglo.email/pull/34) | 3b99900 | Signed outbound webhooks; wipe clears personal data             |
| M5.4         | [#25](https://github.com/iglo-tech/iglo.email/pull/25) | b934fb2 | Sequence scheduler                                              |
| Test hygiene | [#24](https://github.com/iglo-tech/iglo.email/pull/24) | a74c4c9 | Ignore host loopback port probes (lead-merged, test-only)       |
| M5.3         | [#23](https://github.com/iglo-tech/iglo.email/pull/23) | 8bd33f6 | Sequences and enrollments                                       |
| M5.2         | [#22](https://github.com/iglo-tech/iglo.email/pull/22) | 8b328c8 | Sequence conditions                                             |
| M1.7         | [#21](https://github.com/iglo-tech/iglo.email/pull/21) | 0d40045 | Subscriber query/search/export                                  |
| M5.1         | [#20](https://github.com/iglo-tech/iglo.email/pull/20) | 4232631 | Subscriber events API                                           |
| M2.4         | [#19](https://github.com/iglo-tech/iglo.email/pull/19) | 5368d30 | Unsubscribe/cap/tracking                                        |
| M2.3         | [#18](https://github.com/iglo-tech/iglo.email/pull/18) | 7a56cb7 | Transactional API                                               |
| M1.8         | [#17](https://github.com/iglo-tech/iglo.email/pull/17) | 17eaf1c | Templates/bounded Liquid                                        |
| M2.2         | [#16](https://github.com/iglo-tech/iglo.email/pull/16) | 4328bf0 | Durable journal/outbox                                          |
| M2.1         | [#15](https://github.com/iglo-tech/iglo.email/pull/15) | 542bf92 | SMTP/outcomes                                                   |
| M1.2         | [#14](https://github.com/iglo-tech/iglo.email/pull/14) | 043973d | Settings/session lifetime                                       |
| M1.6         | [#13](https://github.com/iglo-tech/iglo.email/pull/13) | 7764c13 | Subscribers/external IDs                                        |
| M1.5         | [#12](https://github.com/iglo-tech/iglo.email/pull/12) | da66ca0 | Lists CRUD/counts                                               |
| M1.4         | [#11](https://github.com/iglo-tech/iglo.email/pull/11) | b60a0e8 | Roles/TOTP                                                      |
| M1.3         | [#10](https://github.com/iglo-tech/iglo.email/pull/10) | 76122c0 | Users/authentication                                            |
| M1.1         | [#9](https://github.com/iglo-tech/iglo.email/pull/9)   | 34a246f | v1 schema                                                       |
| M0.8         | [#8](https://github.com/iglo-tech/iglo.email/pull/8)   | 5c048d1 | SMTP/Liquid spikes                                              |
| M0.7         | [#7](https://github.com/iglo-tech/iglo.email/pull/7)   | 8a0b3bf | SQLite load spike                                               |
| M0.6         | [#6](https://github.com/iglo-tech/iglo.email/pull/6)   | 986e3ed | JSX/page shell/assets                                           |
| M0.5         | [#5](https://github.com/iglo-tech/iglo.email/pull/5)   | 1147650 | Contract suite                                                  |
| M0.4         | [#4](https://github.com/iglo-tech/iglo.email/pull/4)   | a988c62 | SQLite and loop primitives                                      |
| M0.3         | [#3](https://github.com/iglo-tech/iglo.email/pull/3)   | cb41fd6 | HTTP/app contracts                                              |
| M0.2         | [#2](https://github.com/iglo-tech/iglo.email/pull/2)   | 2946b45 | Pinned reference harness                                        |
| M0.1         | [#1](https://github.com/iglo-tech/iglo.email/pull/1)   | 7dffb86 | Skeleton                                                        |

## Hardening backlog

- Intermittent: `route-auth` "held SMTP body denies disabled before a connection" failed once in M1.9 (`smtp.count()` 1). B8 could not reproduce it (22 runs of the file's four cases pass on a host at load ~12); the SMTP peer now lists each counted client (remote port, opening line) so the next failure names who connected.
- Intermittent: `users.e2e.js` "edits a user" fails now and then (B3 reviews: reload races at `:193` and `:382`). B8 fixed the toast wait; one unidentified failure in 19 runs afterwards, and no output was kept. In the B8 round-1 fix run, `:388` "the screen does not raise your own permissions" failed once (`page.goto` to `/admin/users/roles/35` interrupted by a navigation to `/admin/users/29`), clean on rerun.
- Media: supported PDF viewers unverified (needs real devices).
- Role numeric JSON IDs above JavaScript safe integer range: safe rejection remains (D34). B10 left it: IDs are allocated from 1 by AUTOINCREMENT, so a list ID above 9007199254740991 needs about 9e15 inserts and exists only when a test advances the allocator; a lossless parse of numeric JSON would touch every JSON body reader for no realistic client.
- Event latency under full mixed load is p95 51 ms (10.5 ms alone); the throughput target is met. B7 tried a longer event group-commit window (3 ms): no gain, worse tail ([evidence](perf/B7-load-memory.md)). Lowering it needs other loops' commits batched or merged (outbox, scheduler, campaigns: owners outside B7), or an owner decision on D22 durability.
- Admin CSP and editor ([#52](https://github.com/iglo-tech/iglo.email/pull/52)): there is still no caret position next to a held image (needs a design for where a click lands; B10 fixed the other items).
- Tx budget ([#55](https://github.com/iglo-tech/iglo.email/pull/55)): peak memory is about 8x the counted bytes ([B6](perf/B6-send-media-safety.md): the journal payload, the SMTP library's encoding and uncollected garbage are outside the count; lowering `PARSE_COPIES` or the budget trades refusals for memory, an owner call); paced event retention drains about 380 rows/s (the price of not holding back sends, [D74](design/09-decisions.md#d74-synchronous-attachment-sends-share-a-memory-budget-event-retention-joins-the-paced-loop)).
- B7 staging ([#57](https://github.com/iglo-tech/iglo.email/pull/57)): a read queued during a forced WAL gap can wait the full 30 s and get 429 (the gap is D62's price for restarting the WAL under continuous polling; a long read holds it open, and an earlier admission would block the checkpoint); analytics responses over 64 KiB are chunked with no Content-Length (B10 tried an explicit header: Bun ignores it on streamed bodies, and sending the bytes whole would drop the egress accounting that releases when the client has read them).
- Tests ([#58](https://github.com/iglo-tech/iglo.email/pull/58)): the real-API activity-tab e2e no longer checks that a non-HTTP click URL gets no link or the non-campaign rows; `withProduction` retry accepts any server answering `/health`; the `templates-campaigns` connection reset is unexplained; the settings fields a partial write must keep set are repeated in three contract files.
- Editor and tx ([#59](https://github.com/iglo-tech/iglo.email/pull/59)): identical repeated declarations in a held block style are merged (`color:red;color:blue;color:red` saves blue); a live shorthand rewritten to longhands after a style edit can move past a held declaration; the style splitter ignores CSS comments; a steady stream of small tx sends can keep a waiting upload out until its 429; the tx tests wait with `Bun.sleep` loops.
- Test speed ([#60](https://github.com/iglo-tech/iglo.email/pull/60)): the `test/production-build.ts` build lock retries forever on any `mkdir` error, clears a lock older than 120 s even if its build still runs, and sits at one system temp path shared by every checkout; `README.md` still shows plain `bun test`; the regex example in `docs/perf/test-speed.md` shows raw characters instead of escapes.
- E2e speed ([#61](https://github.com/iglo-tech/iglo.email/pull/61)): the dashboard "Nothing here" empty state is checked only when no earlier spec on that stack recorded a view, so never at `E2E_WORKERS=1`; enable oxlint `no-undef` (it would have caught a missing `login` import that git merged silently).
- New safe exotic-response differences go here by PR link; actual safety/auth/data defects never become backlog merely by relabelling.
