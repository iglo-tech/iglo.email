# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-27

## Active

Day-to-day lead: [iglo.email — Chief of staff](t3-thread://v1/mcp:cc118fea-54ef-42c0-a515-e77d835e9df7), GPT-6.1 Sol at xhigh reasoning.

Both M0.2 council members approved round 1. The lead is addressing Opus's additional process-group lifetime note before a fresh review of the changed head.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.2 | fix | [PR #2](https://github.com/iglo-tech/iglo.email/pull/2), `task/M0.2-upstream-reference` | 1 | Both approved `4bde681665a2cef103067a48aa32fd1755e4f7b7`; CI green. Lead is fixing delayed signals to exited process groups, with public descendant-cleanup coverage. [Brief](briefs/M0.2.md). |

Completed worker: [M0.2: Upstream reference and test services — Terra max](t3-thread://v1/thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A74fa8619-7088-4dc2-ac26-bd2acf65e42c); `codex`, `gpt-6.1-terra`, `reasoningEffort: max`. Full local checks and Linux rootless-Docker smoke passed, including command/startup failures, timeout/signal cleanup, isolation, sentinel survival and corrupt-cache rejection. CI is green for the exact head, including native macOS preparation/version checks; full macOS Docker lifecycle remains unverified. The existing PR #2 watch remains active. Do not poll delegates. The M0.1 PR watch is stopped after merge.

- Task ID: `node:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A74fa8619-7088-4dc2-ac26-bd2acf65e42c`.
- Child thread ID: `thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A74fa8619-7088-4dc2-ac26-bd2acf65e42c`.

### Council round 1

Both reviewers approved head `4bde681665a2cef103067a48aa32fd1755e4f7b7` and passed acceptance: [Sol](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6451136993), [Opus](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6451137761). Opus also noted that cleanup could signal a saved process-group ID long after its leader exited. The lead is making group ownership end at child exit and immediately cleaning descendants, so later cleanup/timers cannot signal that saved ID. The new head will receive fresh independent council review; existing approvals apply only to the old head. The existing PR #2 watch remains active.

- [M0.2 council round 1 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A5f8adad9-2768-438d-8e8f-90cb9f8720fe); `claudeAgent`, `claude-opus-5-5`, `effort: medium`. Task ID: `node:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A5f8adad9-2768-438d-8e8f-90cb9f8720fe`; child thread ID: `thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A5f8adad9-2768-438d-8e8f-90cb9f8720fe`.
- [M0.2 council round 1 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A78ee67f9-222e-4d17-853c-4d38ce1c9d53); `codex`, `gpt-6.1-sol`, `reasoningEffort: xhigh`. Task ID: `node:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A78ee67f9-222e-4d17-853c-4d38ce1c9d53`; child thread ID: `thread:delegated-task:command%3Amcp%3A8f6bd9af-c15c-4c0b-9632-ba701ebdf4b6%3Adelegate-task%3A78ee67f9-222e-4d17-853c-4d38ce1c9d53`.

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
