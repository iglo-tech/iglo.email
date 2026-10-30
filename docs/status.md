# Status

Updated 2026-10-29. [Work plan](design/11-work-plan.md) · [Runbook](chief-of-staff.md)

## Active

M6.1 performance, [PR #31](https://github.com/iglo-tech/iglo.email/pull/31), head e679343. Outbox claim 4.0→0.14 ms and cap lookup 11.3→0.02 ms fixed; target 1 met; mixed-load target 2 not met (campaign 48.9/s, events 3–4× slower). Sol xhigh round-1 review running.
Next: merge, then M6.1b to close the mixed-load gap (outbox batching, campaign pacing; FULL sync stays per D22).
Recovery: ~/.local/state/iglo-email-cos/lock.json holds the delegate ID and next action.

## Owner decisions

[D56](design/09-decisions.md#d56-owner-directed-models-review-and-local-verification): Opus5.5 medium work/lead; Haiku5.5 medium mechanical bulk only; one Sol xhigh reviewer; lead+reviewer council; fix-only later rounds; serial foreground local verification; manual-only CI.
[D57](design/09-decisions.md#d57-compatible-client-results-and-safe-input-hardening): realistic-client result compatibility; safe exotic-input response differences are backlog; formats, auth/permissions, atomicity and actual security stay mandatory.
[D58](design/09-decisions.md#d58-stage-marketing-transactional-sends-until-m24) (agents, for owner review): tx marketing sends are journaled as skipped until M2.4.

## Automation and capacity

Existing enabled45-minute schedule scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280 stays unbound. Continuous run starts2026-10-28T20:34:55.959528+00:00; no task/session cutoff.
Project default is Opus5.5 medium; Scheduler API has no per-task model selector; prompt/default can be aligned, separately pinned scheduler model cannot be claimed.
Host disk/memory are constrained; no protected cache/worktree/export cleanup or VM policy changes. One role verifies at a time. Healthy redundant check-ins settle only themselves.

## Done

| Task         | PR                                                     | Merge   | Result                                                    |
| ------------ | ------------------------------------------------------ | ------- | --------------------------------------------------------- |
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

- Role numeric JSON IDs above JavaScript safe integer range: safe rejection remains; exact-width follow-up (D34).
- Expired session rows need bounded cleanup; denial already enforced.
- Intermittent pinned settings-reference refusal: retain diagnostic context; cause unproven.
- Outbox send throughput: 50 msg/s not sustained even without events (one message at a time, two commits each); events at 100/s slow sending further ([M5.1 perf](https://github.com/iglo-tech/iglo.email/pull/20)). Owner: messaging, M3.2/M6.1 (D22). The outbox claim query sorts all queued rows per claim; delivery falls from ~370/s to ~150/s while a 10k sequence burst is queued ([M5.4 perf](https://github.com/iglo-tech/iglo.email/pull/25)). A `(status, id)` index or a split query is the likely fix.
- M5.1 perf: record source/executable hashes for each measured variant.
- M1.7: disk-backed staging for very large selections (parent holds ~3.9 MiB per 100k IDs; 2-slot pool bounds concurrency).
- Single-instance data-dir lock: D15 says one process per data dir but nothing enforces it; lease-based loops (outbox, scheduler, campaign runner) assume it. Bootstrap owner.
- Cap lookup cost grows with long per-subscriber histories (~5 ms at 10k rows); add an indexed reservation/latest-delivery lookup ([M3.2 review](https://github.com/iglo-tech/iglo.email/pull/29#issuecomment-6514899358)).
- New safe exotic-response differences go here by PR link; actual safety/auth/data defects never become backlog merely by relabelling.
