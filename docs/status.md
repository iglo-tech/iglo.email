# Status

Updated2026-10-29. [Work plan](design/11-work-plan.md) · [Runbook](chief-of-staff.md)

## Active

M1.8 templates, [draft PR #17](https://github.com/iglo-tech/iglo.email/pull/17), branch task/M1.8-templates; reviewed head0f6e0cda73028da6471d0377022e85b56a7e7672. Existing branch remains; no replacement worker.
Legacy round3 [A](https://github.com/iglo-tech/iglo.email/pull/17#issuecomment-6491414641) and [B](https://github.com/iglo-tech/iglo.email/pull/17#issuecomment-6492035073) are terminal/read CHANGES. No active delegate or test process. A reports comparison coercion plus numeric-string continuation; B reproduces comparison accounting. Local full checks passed; B's initial settings-reference failure and passing diagnostic rerun remain cause-unknown.
Next: Opus medium lead dispositions every finding under D56/D57, fixes agreed small defects and verifies locally/serially/foreground. Three rounds already elapsed; record lead reasoning in PR before merge. CI is not a gate. After merge immediately dispatch M2.3.
Recovery: ~/.local/state/iglo-email-cos/lock.json retains all delegate IDs, heads, historical evidence and next action; never depend on a former conversation. Detailed evidence remains in PRs/historical records.

## Owner decisions

[D56](design/09-decisions.md#d56-owner-directed-models-review-and-local-verification): Opus5.5 medium work/lead; Haiku5.5 medium mechanical bulk only; one Sol xhigh reviewer; lead+reviewer council; fix-only later rounds; serial foreground local verification; manual-only CI.
[D57](design/09-decisions.md#d57-compatible-client-results-and-safe-input-hardening): realistic-client result compatibility; safe exotic-input response differences are backlog; formats, auth/permissions, atomicity and actual security stay mandatory.

## Automation and capacity

Existing enabled45-minute schedule scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280 stays unbound. Continuous run starts2026-10-28T20:34:55.959528+00:00; no task/session cutoff.
Project default is Opus5.5 medium; this lead's next-turn selection is being updated. Scheduler API has no per-task model selector; prompt/default can be aligned, separately pinned scheduler model cannot be claimed.
Host disk/memory are constrained; no protected cache/worktree/export cleanup or VM policy changes. One role verifies at a time. Healthy redundant check-ins settle only themselves.

## Done

| Task | PR | Merge | Result |
|---|---|---|---|
| M2.2 | [#16](https://github.com/iglo-tech/iglo.email/pull/16) | 4328bf0 | Durable journal/outbox |
| M2.1 | [#15](https://github.com/iglo-tech/iglo.email/pull/15) | 542bf92 | SMTP/outcomes |
| M1.2 | [#14](https://github.com/iglo-tech/iglo.email/pull/14) | 043973d | Settings/session lifetime |
| M1.6 | [#13](https://github.com/iglo-tech/iglo.email/pull/13) | 7764c13 | Subscribers/external IDs |
| M1.5 | [#12](https://github.com/iglo-tech/iglo.email/pull/12) | da66ca0 | Lists CRUD/counts |
| M1.4 | [#11](https://github.com/iglo-tech/iglo.email/pull/11) | b60a0e8 | Roles/TOTP |
| M1.3 | [#10](https://github.com/iglo-tech/iglo.email/pull/10) | 76122c0 | Users/authentication |
| M1.1 | [#9](https://github.com/iglo-tech/iglo.email/pull/9) | 34a246f | v1 schema |
| M0.8 | [#8](https://github.com/iglo-tech/iglo.email/pull/8) | 5c048d1 | SMTP/Liquid spikes |
| M0.7 | [#7](https://github.com/iglo-tech/iglo.email/pull/7) | 8a0b3bf | SQLite load spike |
| M0.6 | [#6](https://github.com/iglo-tech/iglo.email/pull/6) | 986e3ed | JSX/page shell/assets |
| M0.5 | [#5](https://github.com/iglo-tech/iglo.email/pull/5) | 1147650 | Contract suite |
| M0.4 | [#4](https://github.com/iglo-tech/iglo.email/pull/4) | a988c62 | SQLite and loop primitives |
| M0.3 | [#3](https://github.com/iglo-tech/iglo.email/pull/3) | cb41fd6 | HTTP/app contracts |
| M0.2 | [#2](https://github.com/iglo-tech/iglo.email/pull/2) | 2946b45 | Pinned reference harness |
| M0.1 | [#1](https://github.com/iglo-tech/iglo.email/pull/1) | 7dffb86 | Skeleton |

## Hardening backlog

- Role numeric JSON IDs above JavaScript safe integer range: safe rejection remains; exact-width follow-up (D34).
- Expired session rows need bounded cleanup; denial already enforced.
- Intermittent pinned settings-reference refusal: retain diagnostic context; cause unproven.
- New safe exotic-response differences go here by PR link; actual safety/auth/data defects never become backlog merely by relabelling.
