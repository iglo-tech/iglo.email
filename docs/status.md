# Status

Updated 2026-11-01. [Work plan](design/11-work-plan.md) · [Runbook](chief-of-staff.md)

## Active

All 44 plan tasks are merged. M6.3 is proven: test tag `v0.1.0-rc.1` at `2013ada` built a draft prerelease whose download passes its checksums and prints `0.1.0-rc.1`. The draft stays unpublished.
Next: owner items only. One real Mailgun event and a retry (D63); D58-D68 for review; decide CAPTCHA for public forms; the before-1.0 backlog; publish the draft or replace it with a real release.
The hourly schedule is paused because no plan work remains. Enable it again to run backlog work.

## Owner decisions

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

Paused schedule scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280 stays unbound and is resumed by the owner. Continuous run starts2026-10-28T20:34:55.959528+00:00; no task/session cutoff.
Project default is Opus5.5 medium; Scheduler API has no per-task model selector; prompt/default can be aligned, separately pinned scheduler model cannot be claimed.
Host disk/memory are constrained; no protected cache/worktree/export cleanup or VM policy changes. One role verifies at a time. Healthy redundant check-ins settle only themselves.

## Done

| Task         | PR                                                     | Merge   | Result                                                    |
| ------------ | ------------------------------------------------------ | ------- | --------------------------------------------------------- |
| M6.3         | [#48](https://github.com/iglo-tech/iglo.email/pull/48) | 2013ada | Release workflow, version, verification, packaging         |
| M6.4         | [#49](https://github.com/iglo-tech/iglo.email/pull/49) | 21e5bea | OpenAPI, subscriber export and activity routes             |
| M6.2         | [#47](https://github.com/iglo-tech/iglo.email/pull/47) | e191856 | Backup, restore hold (D67), reset-password, operations guide |
| M5.5         | [#45](https://github.com/iglo-tech/iglo.email/pull/45) | 25bf1f4 | Sequence screens, subscriber tabs, test mode               |
| M4.6         | [#44](https://github.com/iglo-tech/iglo.email/pull/44) | bbb6570 | Analytics, maintenance, logs; log buffer holds safe fields |
| M4.5         | [#43](https://github.com/iglo-tech/iglo.email/pull/43) | 6481e54 | Bounces, media, import, forms screens                      |
| M4.4         | [#42](https://github.com/iglo-tech/iglo.email/pull/42) | 39e710c | Settings, users, roles, profile; usable last admin         |
| M4.3         | [#41](https://github.com/iglo-tech/iglo.email/pull/41) | e54fe8c | Templates and campaigns screens; HTML allow-list D66       |
| M4.2         | [#40](https://github.com/iglo-tech/iglo.email/pull/40) | b7ab730 | Subscribers and lists screens                              |
| M4.1         | [#39](https://github.com/iglo-tech/iglo.email/pull/39) | 68defb0 | Admin shell, auth screens, dashboard, e2e harness; D65     |
| M1.9         | [#38](https://github.com/iglo-tech/iglo.email/pull/38) | 7a21684 | CSV import; log holds no personal data; D61 revised        |
| M3.5         | [#37](https://github.com/iglo-tech/iglo.email/pull/37) | 8b38fba | Media, attachments, data-embed; storage boundary D64       |
| M3.4         | [#36](https://github.com/iglo-tech/iglo.email/pull/36) | 6375f5c | Bounces, actions, signed Mailgun webhook; D63              |
| M3.3         | [#35](https://github.com/iglo-tech/iglo.email/pull/35) | a69abd7 | Analytics through a killable read-only child process (D62) |
| M2.6         | [#34](https://github.com/iglo-tech/iglo.email/pull/34) | 3b99900 | Signed outbound webhooks; wipe clears personal data        |
| M5.4         | [#25](https://github.com/iglo-tech/iglo.email/pull/25) | b934fb2 | Sequence scheduler                                        |
| Test hygiene | [#24](https://github.com/iglo-tech/iglo.email/pull/24) | a74c4c9 | Ignore host loopback port probes (lead-merged, test-only) |
| M5.3         | [#23](https://github.com/iglo-tech/iglo.email/pull/23) | 8bd33f6 | Sequences and enrollments                                 |
| M5.2         | [#22](https://github.com/iglo-tech/iglo.email/pull/22) | 8b328c8 | Sequence conditions                                       |
| M1.7         | [#21](https://github.com/iglo-tech/iglo.email/pull/21) | 0d40045 | Subscriber query/search/export                            |
| M5.1         | [#20](https://github.com/iglo-tech/iglo.email/pull/20) | 4232631 | Subscriber events API                                     |
| M2.4         | [#19](https://github.com/iglo-tech/iglo.email/pull/19) | 5368d30 | Unsubscribe/cap/tracking                                  |
| M2.3         | [#18](https://github.com/iglo-tech/iglo.email/pull/18) | 7a56cb7 | Transactional API                                         |
| M1.8         | [#17](https://github.com/iglo-tech/iglo.email/pull/17) | 17eaf1c | Templates/bounded Liquid                                  |
| M2.2         | [#16](https://github.com/iglo-tech/iglo.email/pull/16) | 4328bf0 | Durable journal/outbox                                    |
| M2.1         | [#15](https://github.com/iglo-tech/iglo.email/pull/15) | 542bf92 | SMTP/outcomes                                             |
| M1.2         | [#14](https://github.com/iglo-tech/iglo.email/pull/14) | 043973d | Settings/session lifetime                                 |
| M1.6         | [#13](https://github.com/iglo-tech/iglo.email/pull/13) | 7764c13 | Subscribers/external IDs                                  |
| M1.5         | [#12](https://github.com/iglo-tech/iglo.email/pull/12) | da66ca0 | Lists CRUD/counts                                         |
| M1.4         | [#11](https://github.com/iglo-tech/iglo.email/pull/11) | b60a0e8 | Roles/TOTP                                                |
| M1.3         | [#10](https://github.com/iglo-tech/iglo.email/pull/10) | 76122c0 | Users/authentication                                      |
| M1.1         | [#9](https://github.com/iglo-tech/iglo.email/pull/9)   | 34a246f | v1 schema                                                 |
| M0.8         | [#8](https://github.com/iglo-tech/iglo.email/pull/8)   | 5c048d1 | SMTP/Liquid spikes                                        |
| M0.7         | [#7](https://github.com/iglo-tech/iglo.email/pull/7)   | 8a0b3bf | SQLite load spike                                         |
| M0.6         | [#6](https://github.com/iglo-tech/iglo.email/pull/6)   | 986e3ed | JSX/page shell/assets                                     |
| M0.5         | [#5](https://github.com/iglo-tech/iglo.email/pull/5)   | 1147650 | Contract suite                                            |
| M0.4         | [#4](https://github.com/iglo-tech/iglo.email/pull/4)   | a988c62 | SQLite and loop primitives                                |
| M0.3         | [#3](https://github.com/iglo-tech/iglo.email/pull/3)   | cb41fd6 | HTTP/app contracts                                        |
| M0.2         | [#2](https://github.com/iglo-tech/iglo.email/pull/2)   | 2946b45 | Pinned reference harness                                  |
| M0.1         | [#1](https://github.com/iglo-tech/iglo.email/pull/1)   | 7dffb86 | Skeleton                                                  |

## Hardening backlog

- Analytics: global egress budget for many slow near-cap downloads; WAL growth under no-gap report polling (D62).
- Intermittent: `route-auth` "held SMTP body denies disabled before a connection" failed once in M1.9 (`smtp.count()` 1); may be the same as the unnamed M3.4 failure.
- Media: `runner:crash` has no media campaign; no compiled `data-embed` contract; synchronous `POST /api/tx` with caller attachments has no concurrency limit; supported PDF viewers unverified.
- Tests: contract coverage of multi-list actions and exports (M4.2 dropped two API-only cases); `availablePort()` free-port race in the contract harness.
- Before public release: admin pages set no CSP; add one and contain the editor surface (M4.3). The sanitizer has had a design review and browser probes, no dedicated hostile test; consider DOMPurify.
- Editor: head content missing from the removal warning; keep a foreign-content and undo regression corpus; inline message for refused URLs.
- Tests: no contract case for a nonempty messenger lifecycle (M4.4).
- Before 1.0: automatic bounded retention of delivered webhook rows and expired sessions; send analytics need a history-retention decision first.
- Sequences: "reschedule active enrollments" and live condition validation deferred (M5.5); both need a write or validate endpoint.
- Intermittent under load: `CLI cancellation interrupts an in-flight request` and `subscribers.e2e.js:272` navigation race (both M6.2, once each, clean on rerun).
- Role numeric JSON IDs above JavaScript safe integer range: safe rejection remains; exact-width follow-up (D34).
- Expired session rows need bounded cleanup; denial already enforced.
- Intermittent pinned settings-reference refusal: retain diagnostic context; cause unproven.
- M5.1 perf: record source/executable hashes for each measured variant.
- M1.7: disk-backed staging for very large selections (parent holds ~3.9 MiB per 100k IDs; 2-slot pool bounds concurrency).
- Single-instance data-dir lock: D15 says one process per data dir but nothing enforces it; lease-based loops (outbox, scheduler, campaign runner) assume it. Bootstrap owner.
- Event latency under full mixed load is p95 51 ms (10.5 ms alone); the throughput target is met. Lowering it needs shared write batching across loops, or an owner decision on D22 durability.
- `finishAll`: add permanent regressions for mixed retry outcomes, same-subscriber batch caps and COMMIT rollback ([#32 review](https://github.com/iglo-tech/iglo.email/pull/32#issuecomment-6517645045)).
- Webhook delivery rows are never purged; add retention ([#34](https://github.com/iglo-tech/iglo.email/pull/34)).
- Subscriber activity tab with its clear buttons: upstream's page over `GET` and `DELETE /api/subscribers/:id/activity`, which M6.4 ported without a screen.
- New safe exotic-response differences go here by PR link; actual safety/auth/data defects never become backlog merely by relabelling.
