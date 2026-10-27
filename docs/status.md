# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-27

## Active

Day-to-day lead: [iglo.email — Chief of staff](t3-thread://v1/mcp:cc118fea-54ef-42c0-a515-e77d835e9df7), GPT-6.1 Sol at xhigh reasoning.

M0.5 is in council round 1 on [PR #5](https://github.com/iglo-tech/iglo.email/pull/5), exact head `09a87223d741c4360b3def4e19de817e2cc89436`. All eight CI jobs passed (four job types in each run). Opus returned CHANGES; the lead is correcting two ineffective fixture paths and the minor readiness edge. Sol is still reviewing the original exact head; its completion wakes this lead. The existing PR watch remains active. Do not poll or start duplicate reviews. D20 keeps production coverage separate from fixture-only authenticated/helper evidence.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.5 | fix | task/M0.5-contract-harness; [#5](https://github.com/iglo-tech/iglo.email/pull/5) | 1 | [Brief](briefs/M0.5.md). Head `09a87223d741c4360b3def4e19de817e2cc89436`; reference-first commit `98e15fb`. Worker reports 69 tests, 8 production cases, 23 fixture cases + 2 probes, 31 upstream cases and reference smoke passing. All eight CI jobs passed. Opus CHANGES: D18 dot helpers and API method mismatch did not reach registered routes. Lead fixes in progress with three regression-first tests; Sol original-head verdict pending. No replacement reviewer started. |


Completed worker: [M0.5: Contract suite harness — Terra max](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa2d2b4e7-373a-4ee9-9b79-dd5f032723cc); codex / gpt-6.1-terra, reasoningEffort: max.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa2d2b4e7-373a-4ee9-9b79-dd5f032723cc
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa2d2b4e7-373a-4ee9-9b79-dd5f032723cc
- Preserved worker checkout: `/home/t3-code/.t3/worktrees/iglo.email/t3-73790d45` (terminal worker; use for small lead fixes).
- PR #5 is linked and watched in the dedicated lead thread. Sol council round 1 is still running; Opus completed. Collect both verdicts before a fresh council round; do not reuse previous-task approvals.

### Council round 1

[M0.5 council round 1 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A36517d41-ddf0-47e0-93c4-302d1527742f); claude-opus-5-5. [CHANGES](https://github.com/iglo-tech/iglo.email/pull/5#issuecomment-6455973842): two fixture coverage gaps plus minor readiness edge. All acceptance passed using disk-backed TMPDIR after /tmp exhaustion.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A36517d41-ddf0-47e0-93c4-302d1527742f
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A36517d41-ddf0-47e0-93c4-302d1527742f

[M0.5 council round 1 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A69b1b0db-e9c8-46b1-94bd-393303feef1b); gpt-6.1-sol. Verdict pending.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A69b1b0db-e9c8-46b1-94bd-393303feef1b
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A69b1b0db-e9c8-46b1-94bd-393303feef1b

Validation environment: `/tmp` is nearly full (26 MB free at the lead check), independently confirmed by `df`; the reviewer attributed it to another project. No unrelated files were removed. Lead checks use ignored disk-backed `upstream/lead-tmp` in the worker checkout.

## Automation

The existing 45-minute chief-of-staff schedule is enabled and independent. Task ID: `scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280`. Verified `boundThreadId: null` with `bindToCurrentThread: false`; never bind this automation to a thread. Next run reported on 2026-10-27: **2026-10-27T19:06:37.204Z** (20:06:37 Warsaw). Child completions continue their originating lead run immediately. Independent scheduled runs use the lock and durable status/PR state for recovery without depending on that thread's responsiveness.

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|
| M0.4 | [#4](https://github.com/iglo-tech/iglo.email/pull/4) | 2026-10-27, `a988c62d8bbf854a98ad2e750773b76cce3f323f` | SQLite primitives, migrations/snapshots, named SQL and cooperative loop lifecycle. [Opus](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6455376123) and [Sol](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6455414436) approved exact head `47d3149e9af51ff2615fe836375090b3e7614f1d` in round 2; all eight CI jobs passed. Acceptance: 49 tests / 381 assertions, 28 upstream cases, eight smoke stages and corrected ext4 measurements. Production stays at version 0. [Review record](reviews/M0.4.md), [measurements](perf/M0.4-database.md). |
| M0.3 | [#3](https://github.com/iglo-tech/iglo.email/pull/3) | 2026-10-27, `cb41fd6f29a07415541fcb95101ba84e64231ad6` | Shared HTTP/app/clock/i18n contracts. Both final CI runs passed all four job types. Three council rounds ended with matching URI findings; the lead fixed both and merged under the [three-round resolution](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454296622), supplemented by the [reference readiness repair](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454452814). No final-head council approval is claimed. Final local checks: 27 tests / 237 assertions, 28 upstream cases and eight smoke stages. [Review record](reviews/M0.3.md). |
| M0.2 | [#2](https://github.com/iglo-tech/iglo.email/pull/2) | 2026-10-27, `2946b45cad2f9e1caf63311ba814fbde56c3e40f` | Upstream reference and test services. All CI jobs green; [Opus](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6452884686) and [Sol](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6451369141) approved exact head `cd556c981eac3e3cb6a2ff28dc2ca1e4816e2569` in round 2. Both passed full local checks and all eight Linux smoke stages. Native macOS binary preparation passed CI; full macOS Docker lifecycle remains unverified. Process-group cleanup was tightened after round 1. The Claude rate-limit pause expired before T3 automatically resumed the reviewer; no duplicate review was started. |
| M0.1 | [#1](https://github.com/iglo-tech/iglo.email/pull/1) | 2026-10-27, `7dffb86e0cc1169815c5a7611516c05018ee9b30` | Project skeleton. Both CI checks passed; [Opus](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450451709) and [Sol](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450467491) approved exact head `56935d1148bdce063dd4e9d5a0e752bd126c3468` in round 1. Both independently passed acceptance (8 tests, 97 assertions). Live reference comparison follows in M0.2/M0.5. |

## Follow-ups

- M0.6/public-page work must finish the explicitly deferred public HTML 404 fallback (including `POST /health`). It remains a temporary staging gap; API error bodies are complete for the current scope.
- M0.5 must carry D17/D18 markers into the general contract suite. Native macOS binary preparation passes CI; full native macOS Docker lifecycle remains unverified.

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

The owner started the port on 2026-10-27 and set the model assignments: GPT-6.1 Sol at xhigh for the lead, GPT-6.1 Terra at max for all implementation and helpers, and Claude Opus 5.5 at medium only as a council member alongside a fresh Sol xhigh reviewer. See [work plan](design/11-work-plan.md#models).

Owner correction on 2026-10-27: recurring automation must remain unbound to every thread. The dedicated chief-of-staff thread handles day-to-day work; independent scheduled runs provide recovery through the existing lock and status state.

[D17](https://github.com/iglo-tech/iglo.email/blob/cb41fd6f29a07415541fcb95101ba84e64231ad6/docs/design/09-decisions.md#d17-reject-positive-route-id-overflow-before-storage) (2026-10-27, merged in PR #3): reject positive route IDs above the signed 64-bit maximum with 400 `invalid ID` before storage. Upstream ignores the conversion overflow and leaks a database error as 500. This gives callers an accurate client error without exposing storage details; the focused reference and normal HTTP cases mark the deliberate difference.

[D18](https://github.com/iglo-tech/iglo.email/blob/cb41fd6f29a07415541fcb95101ba84e64231ad6/docs/design/09-decisions.md#d18-use-buns-normalized-request-path) (2026-10-27, merged in PR #3): use the canonical request URL exposed by `Bun.serve`, including dot-segment removal and literal backslash-to-slash rewriting. Exact-target `%2E` / `%2E%2E` list-ID requests return upstream 400 but reach the current fixture API fallback after Bun normalization. This keeps routing and future permission middleware on one URL interpretation without introducing another HTTP transport/parser for request spelling the runtime does not expose. Both modes mark dot-segment and backslash differences for M0.5; visible malformed percent syntax is rejected with upstream’s transport response.

[D19](design/09-decisions.md#d19-durable-database-primitives-and-module-owned-lease-policy) (2026-10-27): explicit durable SQLite defaults, synchronous non-replayed writes, pre-migration snapshots and a loop helper that delegates lease/status/recovery policy to each owning module. M0.4 implements the infrastructure; M1.1 still owns the first full production schema.

[D20](design/09-decisions.md#d20-separate-production-and-fixture-contract-coverage-until-auth-is-ported) (2026-10-27): M0.5 separates compiled production coverage from authenticated-read/helper fixture evidence. M1.3 promotes the protected read to production auth; work-plan acceptance and testing notes now name that temporary staging explicitly.

Host-rule incident (2026-10-27): the Opus round 2 reviewer self-reported one whole-filesystem `find` to locate Echo source, contrary to `/home/t3-code/AGENTS.md`. It reported the scan finished quickly without a visible effect and was not repeated. The lead recorded the incident without repeating the scan. Worker and council instructions in the runbook now explicitly require named checkout/cache paths or pinned GitHub source inside the worktree, never a broader filesystem search when a dependency is absent.

## Paused until

Not paused. The Claude rate-limit pause ended at 2026-10-27T20:16:21.916914+00:00. M0.2 resumed and merged after both exact-head approvals were verified.
