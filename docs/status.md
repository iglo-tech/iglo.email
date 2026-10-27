# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-27

## Active

Day-to-day lead: [iglo.email — Chief of staff](t3-thread://v1/mcp:cc118fea-54ef-42c0-a515-e77d835e9df7), GPT-6.1 Sol at xhigh reasoning.

M0.2's Terra max worker is running, following the serial M0 order.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.2 | worker | `task/M0.2-upstream-reference`, no PR | 0 | [Brief](briefs/M0.2.md). Pinned upstream/native Mailpit, disposable Postgres, local webhook capture, owned-resource cleanup and Linux reference CI. |

Worker: [M0.2: Upstream reference and test services — Terra max](t3-thread://v1/thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A74fa8619-7088-4dc2-ac26-bd2acf65e42c); dispatch confirmed `codex`, `gpt-6.1-terra`, `reasoningEffort: max`. Completion wakes this lead; do not poll. The M0.1 PR watch is stopped after merge.

- Task ID: `node:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A74fa8619-7088-4dc2-ac26-bd2acf65e42c`.
- Child thread ID: `thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A74fa8619-7088-4dc2-ac26-bd2acf65e42c`.

## Automation

The existing 45-minute chief-of-staff schedule is enabled and independent. Task ID: `scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280`. Verified `boundThreadId: null` with `bindToCurrentThread: false`; never bind this automation to a thread. Next run reported on 2026-10-27: **2026-10-27T19:06:37.204Z** (20:06:37 Warsaw). Child completions continue their originating lead run immediately. Independent scheduled runs use the lock and durable status/PR state for recovery without depending on that thread's responsiveness.

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|
| M0.1 | [#1](https://github.com/iglo-tech/iglo.email/pull/1) | 2026-10-27, `7dffb86e0cc1169815c5a7611516c05018ee9b30` | Project skeleton. Both CI checks passed; [Opus](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450451709) and [Sol](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450467491) approved exact head `56935d1148bdce063dd4e9d5a0e752bd126c3468` in round 1. Both independently passed acceptance (8 tests, 97 assertions). Live reference comparison follows in M0.2/M0.5. |

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

The owner started the port on 2026-10-27 and set the model assignments: GPT-6.1 Sol at xhigh for the lead, GPT-6.1 Terra at max for all implementation and helpers, and Claude Opus 5.5 at medium only as a council member alongside a fresh Sol xhigh reviewer. See [work plan](design/11-work-plan.md#models).

Owner correction on 2026-10-27: recurring automation must remain unbound to every thread. The dedicated chief-of-staff thread handles day-to-day work; independent scheduled runs provide recovery through the existing lock and status state.

## Paused until

Not paused.
