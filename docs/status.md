# Status

Updated 2026-11-03. [Work plan](design/11-work-plan.md) · [Runbook](chief-of-staff.md)

## Active

All 44 plan tasks are merged and M6.3 is proven on draft prerelease `v0.1.0-rc.1`. Owner rule 2026-11-01: work continues until nothing remains that agents can do; see the [runbook](chief-of-staff.md#when-work-ends).
B8 is with its worker: [brief](briefs/B8.md), branch `task/B8-test-debt`. Recovery: ~/.local/state/iglo-email-cos/lock.json.
Owner-only, blocking nothing else: publishing a release. The owner sends through Amazon SES, not Mailgun (2026-11-02), so the real Mailgun check is dropped and SES bounces shipped in B9; the owner lists their SNS topic in `bounce.ses_topic_arns` (see operations.md).

## Work queue

Run in order, one at a time, through the normal stages. Write each brief from the backlog lines below and remove a line when it merges.

1. B8: test debt and intermittent failures ([brief](briefs/B8.md)).
2. B10: product defects left in the backlog: Retention, Admin CSP and editor, Sequences, Tx budget, SES, B7 staging, D34 exact-width IDs.
3. B11: event latency: batch or merge commits across loops (outbox, scheduler, campaigns) without weakening D22.
4. B12: anything still left in the backlog that agents can do.

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

| Task         | PR                                                     | Merge   | Result                                                       |
| ------------ | ------------------------------------------------------ | ------- | ------------------------------------------------------------ |
| B7           | [#57](https://github.com/iglo-tech/iglo.email/pull/57) | fb7ea5a | Analytics egress budget, WAL gap, disk-staged selections     |
| B9           | [#56](https://github.com/iglo-tech/iglo.email/pull/56) | 6669094 | SES/SNS bounces, topic allowlist (D75)                       |
| B6           | [#55](https://github.com/iglo-tech/iglo.email/pull/55) | 33d8e65 | Tx attachment budget, finishAll tests, paced events (D74)    |
| B5           | [#54](https://github.com/iglo-tech/iglo.email/pull/54) | 92c5d90 | Reschedule, live condition validation, activity tab          |
| B4           | [#53](https://github.com/iglo-tech/iglo.email/pull/53) | 785594f | ALTCHA and hCaptcha on public forms (D72)                    |
| B3           | [#52](https://github.com/iglo-tech/iglo.email/pull/52) | 5dfea64 | Admin CSP, nosniff, editor containment (D71)                 |
| B2           | [#51](https://github.com/iglo-tech/iglo.email/pull/51) | c4a24a5 | Retention of sessions, webhook rows and send bodies (D70)    |
| B1           | [#50](https://github.com/iglo-tech/iglo.email/pull/50) | 07e3ace | One process per data directory (D69)                         |
| M6.3         | [#48](https://github.com/iglo-tech/iglo.email/pull/48) | 2013ada | Release workflow, version, verification, packaging           |
| M6.4         | [#49](https://github.com/iglo-tech/iglo.email/pull/49) | 21e5bea | OpenAPI, subscriber export and activity routes               |
| M6.2         | [#47](https://github.com/iglo-tech/iglo.email/pull/47) | e191856 | Backup, restore hold (D67), reset-password, operations guide |
| M5.5         | [#45](https://github.com/iglo-tech/iglo.email/pull/45) | 25bf1f4 | Sequence screens, subscriber tabs, test mode                 |
| M4.6         | [#44](https://github.com/iglo-tech/iglo.email/pull/44) | bbb6570 | Analytics, maintenance, logs; log buffer holds safe fields   |
| M4.5         | [#43](https://github.com/iglo-tech/iglo.email/pull/43) | 6481e54 | Bounces, media, import, forms screens                        |
| M4.4         | [#42](https://github.com/iglo-tech/iglo.email/pull/42) | 39e710c | Settings, users, roles, profile; usable last admin           |
| M4.3         | [#41](https://github.com/iglo-tech/iglo.email/pull/41) | e54fe8c | Templates and campaigns screens; HTML allow-list D66         |
| M4.2         | [#40](https://github.com/iglo-tech/iglo.email/pull/40) | b7ab730 | Subscribers and lists screens                                |
| M4.1         | [#39](https://github.com/iglo-tech/iglo.email/pull/39) | 68defb0 | Admin shell, auth screens, dashboard, e2e harness; D65       |
| M1.9         | [#38](https://github.com/iglo-tech/iglo.email/pull/38) | 7a21684 | CSV import; log holds no personal data; D61 revised          |
| M3.5         | [#37](https://github.com/iglo-tech/iglo.email/pull/37) | 8b38fba | Media, attachments, data-embed; storage boundary D64         |
| M3.4         | [#36](https://github.com/iglo-tech/iglo.email/pull/36) | 6375f5c | Bounces, actions, signed Mailgun webhook; D63                |
| M3.3         | [#35](https://github.com/iglo-tech/iglo.email/pull/35) | a69abd7 | Analytics through a killable read-only child process (D62)   |
| M2.6         | [#34](https://github.com/iglo-tech/iglo.email/pull/34) | 3b99900 | Signed outbound webhooks; wipe clears personal data          |
| M5.4         | [#25](https://github.com/iglo-tech/iglo.email/pull/25) | b934fb2 | Sequence scheduler                                           |
| Test hygiene | [#24](https://github.com/iglo-tech/iglo.email/pull/24) | a74c4c9 | Ignore host loopback port probes (lead-merged, test-only)    |
| M5.3         | [#23](https://github.com/iglo-tech/iglo.email/pull/23) | 8bd33f6 | Sequences and enrollments                                    |
| M5.2         | [#22](https://github.com/iglo-tech/iglo.email/pull/22) | 8b328c8 | Sequence conditions                                          |
| M1.7         | [#21](https://github.com/iglo-tech/iglo.email/pull/21) | 0d40045 | Subscriber query/search/export                               |
| M5.1         | [#20](https://github.com/iglo-tech/iglo.email/pull/20) | 4232631 | Subscriber events API                                        |
| M2.4         | [#19](https://github.com/iglo-tech/iglo.email/pull/19) | 5368d30 | Unsubscribe/cap/tracking                                     |
| M2.3         | [#18](https://github.com/iglo-tech/iglo.email/pull/18) | 7a56cb7 | Transactional API                                            |
| M1.8         | [#17](https://github.com/iglo-tech/iglo.email/pull/17) | 17eaf1c | Templates/bounded Liquid                                     |
| M2.2         | [#16](https://github.com/iglo-tech/iglo.email/pull/16) | 4328bf0 | Durable journal/outbox                                       |
| M2.1         | [#15](https://github.com/iglo-tech/iglo.email/pull/15) | 542bf92 | SMTP/outcomes                                                |
| M1.2         | [#14](https://github.com/iglo-tech/iglo.email/pull/14) | 043973d | Settings/session lifetime                                    |
| M1.6         | [#13](https://github.com/iglo-tech/iglo.email/pull/13) | 7764c13 | Subscribers/external IDs                                     |
| M1.5         | [#12](https://github.com/iglo-tech/iglo.email/pull/12) | da66ca0 | Lists CRUD/counts                                            |
| M1.4         | [#11](https://github.com/iglo-tech/iglo.email/pull/11) | b60a0e8 | Roles/TOTP                                                   |
| M1.3         | [#10](https://github.com/iglo-tech/iglo.email/pull/10) | 76122c0 | Users/authentication                                         |
| M1.1         | [#9](https://github.com/iglo-tech/iglo.email/pull/9)   | 34a246f | v1 schema                                                    |
| M0.8         | [#8](https://github.com/iglo-tech/iglo.email/pull/8)   | 5c048d1 | SMTP/Liquid spikes                                           |
| M0.7         | [#7](https://github.com/iglo-tech/iglo.email/pull/7)   | 8a0b3bf | SQLite load spike                                            |
| M0.6         | [#6](https://github.com/iglo-tech/iglo.email/pull/6)   | 986e3ed | JSX/page shell/assets                                        |
| M0.5         | [#5](https://github.com/iglo-tech/iglo.email/pull/5)   | 1147650 | Contract suite                                               |
| M0.4         | [#4](https://github.com/iglo-tech/iglo.email/pull/4)   | a988c62 | SQLite and loop primitives                                   |
| M0.3         | [#3](https://github.com/iglo-tech/iglo.email/pull/3)   | cb41fd6 | HTTP/app contracts                                           |
| M0.2         | [#2](https://github.com/iglo-tech/iglo.email/pull/2)   | 2946b45 | Pinned reference harness                                     |
| M0.1         | [#1](https://github.com/iglo-tech/iglo.email/pull/1)   | 7dffb86 | Skeleton                                                     |

## Hardening backlog

- Intermittent: `route-auth` "held SMTP body denies disabled before a connection" failed once in M1.9 (`smtp.count()` 1). B8 could not reproduce it (22 runs of the file's four cases pass on a host at load ~12); the SMTP peer now lists each counted client (remote port, opening line) so the next failure names who connected.
- Media: supported PDF viewers unverified (needs real devices).
- Role numeric JSON IDs above JavaScript safe integer range: safe rejection remains; exact-width follow-up (D34).
- Intermittent pinned settings-reference refusal: cause unproven. B8 keeps the diagnostic (attempts, wait, error code in the failure) and raised the restart wait from 5 s to 20 s; a recurrence now says whether the wait ran out.
- Event latency under full mixed load is p95 51 ms (10.5 ms alone); the throughput target is met. B7 tried a longer event group-commit window (3 ms): no gain, worse tail ([evidence](perf/B7-load-memory.md)). Lowering it needs other loops' commits batched or merged (outbox, scheduler, campaigns: owners outside B7), or an owner decision on D22 durability.
- Instance lock: two forged lock file headers stop the start with a clean error ([#50](https://github.com/iglo-tech/iglo.email/pull/50)).
- Retention ([#51](https://github.com/iglo-tech/iglo.email/pull/51)): session rows with no `expires_at` go up to 999 ms early; D70's session index and the rate in `docs/operations.md` are slightly off.
- Admin CSP and editor ([#52](https://github.com/iglo-tech/iglo.email/pull/52)): `url()` in a kept `style` logs a violation and gets no notice; `?remote_images=1` can come from a crafted link; an archive slug typed during a save counts as saved; no caret on a held image; with `_` in the root URL host, root-URL images are blocked but not held.
- Sequences ([#54](https://github.com/iglo-tech/iglo.email/pull/54)): reschedule returns 404 after partial batches when the step is deleted mid-run; the reschedule query names its index, so a missing index gives a 500 and the perf doc's no-index "before" run cannot be repeated; the Campaigns count on the activity tab includes the non-campaign row.
- Tx budget ([#55](https://github.com/iglo-tech/iglo.email/pull/55)): while any upload waits, a JSON send with template images gets 429 at once even when it would fit; under load a multipart request over 5 MiB can get 429 before its 413; peak memory is about 8x the counted bytes; paced event retention drains about 380 rows/s.
- SES ([#56](https://github.com/iglo-tech/iglo.email/pull/56)): SES shares the 300/min per-client webhook limit with Mailgun, so a large bounce burst may be refused (unverified); upstream's certificate URL pattern may also match an S3 bucket named `sns` (unverified); the OpenAPI SES difference is not attached to `POST /webhooks/service/{service}`.
- B7 staging ([#57](https://github.com/iglo-tech/iglo.email/pull/57)): a staged file can stay until restart if the query time limit fires at one moment (and a similar multi-statement race); a read queued during a forced gap can wait the full 30 s and get 429; `runner.stage()` decodes batches it discards; analytics responses over 64 KiB are chunked with no Content-Length.
- New safe exotic-response differences go here by PR link; actual safety/auth/data defects never become backlog merely by relabelling.
