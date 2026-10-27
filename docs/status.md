# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-27

## Active

Day-to-day lead: [iglo.email — Chief of staff](t3-thread://v1/mcp:cc118fea-54ef-42c0-a515-e77d835e9df7), GPT-6.1 Sol at xhigh reasoning.

M0.3's implementation, local acceptance and CI are complete; both independent council round 1 reviewers are running.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.3 | council | [PR #3](https://github.com/iglo-tech/iglo.email/pull/3), `task/M0.3-shared-contracts` | 1 | Head `644411b3aa798703953002dec1641559e0947f33`. All CI jobs passed, including focused server reference cases and the Linux lifecycle. Council: Opus medium and fresh Sol xhigh. [Brief](briefs/M0.3.md). |

Completed worker: [M0.3: Shared HTTP and application contracts — Terra max](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Abc6987b1-7251-4c79-8eeb-258df345672b); `codex`, `gpt-6.1-terra`, `reasoningEffort: max`. Reference cases were committed first at `0b732f7017f0ec46b41bf6fa0d49d63459bf4363` and passed against the pinned live upstream before implementation. Local focused server tests, compiled fixtures, full check (18 tests / 156 assertions) and existing reference smoke passed. All CI jobs are green for the exact head. The existing PR #3 watch remains active; no merged-task PR watch is active.

Scope review: `POST /health` returns the verified upstream 404 status but a plain-text body, while upstream renders its public HTML error page. The M0.3 brief explicitly defers public HTML rendering. The lead accepts this as temporary staging, already documented in the submitted architecture note and PR, rather than a permanent API difference. API 404/error bodies and `GET /health` retain the upstream contract. Track completion of the public HTML fallback with M0.6/public-page work; do not treat the temporary body as the final contract.

- Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Abc6987b1-7251-4c79-8eeb-258df345672b`.
- Child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Abc6987b1-7251-4c79-8eeb-258df345672b`.

### Council round 1

Both reviewers independently check exact head `644411b3aa798703953002dec1641559e0947f33`, including the live server reference cases, HTTP/compiled fixture tests and existing reference smoke. Completion wakes this lead; do not poll running delegates. The existing PR #3 watch remains active.

- [M0.3 council round 1 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa20f861c-2f11-4b66-a1d3-deedcca621e5); `claudeAgent`, `claude-opus-5-5`, `effort: medium`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa20f861c-2f11-4b66-a1d3-deedcca621e5`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa20f861c-2f11-4b66-a1d3-deedcca621e5`.
- [M0.3 council round 1 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A6cb2330e-15e6-4507-8e5f-8d32700185e7); `codex`, `gpt-6.1-sol`, `reasoningEffort: xhigh`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A6cb2330e-15e6-4507-8e5f-8d32700185e7`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A6cb2330e-15e6-4507-8e5f-8d32700185e7`.

## Automation

The existing 45-minute chief-of-staff schedule is enabled and independent. Task ID: `scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280`. Verified `boundThreadId: null` with `bindToCurrentThread: false`; never bind this automation to a thread. Next run reported on 2026-10-27: **2026-10-27T19:06:37.204Z** (20:06:37 Warsaw). Child completions continue their originating lead run immediately. Independent scheduled runs use the lock and durable status/PR state for recovery without depending on that thread's responsiveness.

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|
| M0.2 | [#2](https://github.com/iglo-tech/iglo.email/pull/2) | 2026-10-27, `2946b45cad2f9e1caf63311ba814fbde56c3e40f` | Upstream reference and test services. All CI jobs green; [Opus](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6452884686) and [Sol](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6451369141) approved exact head `cd556c981eac3e3cb6a2ff28dc2ca1e4816e2569` in round 2. Both passed full local checks and all eight Linux smoke stages. Native macOS binary preparation passed CI; full macOS Docker lifecycle remains unverified. Process-group cleanup was tightened after round 1. The Claude rate-limit pause expired before T3 automatically resumed the reviewer; no duplicate review was started. |
| M0.1 | [#1](https://github.com/iglo-tech/iglo.email/pull/1) | 2026-10-27, `7dffb86e0cc1169815c5a7611516c05018ee9b30` | Project skeleton. Both CI checks passed; [Opus](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450451709) and [Sol](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450467491) approved exact head `56935d1148bdce063dd4e9d5a0e752bd126c3468` in round 1. Both independently passed acceptance (8 tests, 97 assertions). Live reference comparison follows in M0.2/M0.5. |

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

The owner started the port on 2026-10-27 and set the model assignments: GPT-6.1 Sol at xhigh for the lead, GPT-6.1 Terra at max for all implementation and helpers, and Claude Opus 5.5 at medium only as a council member alongside a fresh Sol xhigh reviewer. See [work plan](design/11-work-plan.md#models).

Owner correction on 2026-10-27: recurring automation must remain unbound to every thread. The dedicated chief-of-staff thread handles day-to-day work; independent scheduled runs provide recovery through the existing lock and status state.

## Paused until

Not paused. The Claude rate-limit pause ended at 2026-10-27T20:16:21.916914+00:00. M0.2 resumed and merged after both exact-head approvals were verified.
