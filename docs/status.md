# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-27

## Active

Day-to-day lead: [iglo.email — Chief of staff](t3-thread://v1/mcp:cc118fea-54ef-42c0-a515-e77d835e9df7), GPT-6.1 Sol at xhigh reasoning.

M0.4 round 1 corrections are published at `47d3149e9af51ff2615fe836375090b3e7614f1d`: disk-backed measurements, SQLite-parsed migration boundaries and cooperative busy-loop scheduling. Full local acceptance and all eight exact-head CI jobs passed. Round 2 Opus [approved](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6455376123) the exact head; Sol remains pending. Merge requires Sol’s same-head approval as well. The existing PR #4 watch remains active.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.4 | council | [PR #4](https://github.com/iglo-tech/iglo.email/pull/4), `task/M0.4-database-loops` | 2 | Head `47d3149e9af51ff2615fe836375090b3e7614f1d` addresses both reviewers’ three findings. Local check: 49 tests / 381 assertions; focused db/loops: 20 tests / 134 assertions; ext4 benchmark, 28 upstream cases and eight smoke stages passed. All four CI job types passed in both runs. Round 2 Opus APPROVE; Sol pending. Round 1 verdicts apply only to the earlier head. [Brief](briefs/M0.4.md). |


Completed worker: [M0.4: Database layer and loop helper — Terra max](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A079011c5-d0e3-4e13-900f-ccbf0e6593d9); codex / gpt-6.1-terra, reasoningEffort: max.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A079011c5-d0e3-4e13-900f-ccbf0e6593d9
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A079011c5-d0e3-4e13-900f-ccbf0e6593d9

### Council round 1

The worker worktree is `/home/t3-code/.t3/worktrees/iglo.email/t3-4331ffeb`, branch `task/M0.4-database-loops`. Test/baseline evidence precedes implementation in `89b81c3`. The [measurement report](https://github.com/iglo-tech/iglo.email/blob/b15b8f87c05a9055cebb911d301bfd29a136d79c/docs/perf/M0.4-database.md) identifies the native-primitives baseline and bounded 10,000-row repetitions; it does not claim product throughput. The PR reports VACUUM snapshot limits, including implicit rowids, single-process startup and directory-entry power-loss durability. No permanent API difference is introduced. Both reviewers received the full brief, D19, upstream mapping, limitations and required acceptance commands without a lead verdict. [Opus requested changes](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6454937538): the initial report measured on `/tmp` (tmpfs), omitting durable-storage commit cost. It found no database/loop code problems and passed acceptance. [Sol requested changes](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6454982269): keyword identifiers can fool the trigger scanner into permitting COMMIT or rejecting valid triggers, and nonempty synchronous processing never yields to HTTP/shutdown. Both reviews are terminal. The lead added failing HTTP regressions before the two source fixes; all three findings are addressed in the published correction below.

- [M0.4 council round 1 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aefdcf68a-3709-4ec5-84e1-408108f7ca9b); claudeAgent / claude-opus-5-5. Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aefdcf68a-3709-4ec5-84e1-408108f7ca9b; child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aefdcf68a-3709-4ec5-84e1-408108f7ca9b.
- [M0.4 council round 1 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A4e70b7a7-5a30-4bb9-9f67-7dcff7c5c802); codex / gpt-6.1-sol. Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A4e70b7a7-5a30-4bb9-9f67-7dcff7c5c802; child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A4e70b7a7-5a30-4bb9-9f67-7dcff7c5c802.

### Measurement correction prepared by the lead

Local commit `6c25f9ba5f52c09f26c21ba16af3f4f851a158b4` in `/home/t3-code/.t3/worktrees/iglo.email/t3-4331ffeb` changes only the measurement program and report. `df -T` confirmed the selected worktree path is ext4 on `/dev/sda1`, while `/tmp` is tmpfs. The exact pre-implementation native program from `89b81c35934137743f80f44c821ba23d4c652d1d` was rerun on ext4, followed by the current native/helper workload. The report labels these as new runs of the original code, records filesystem/platform and all results, and disqualifies the prior tmpfs timings as durability evidence. It makes no stable overhead or throughput claim from three repetitions.

The program now defaults to the ignored worktree `upstream/measurements` directory, accepts `IGLO_EMAIL_PERF_DIR`, prints the selected directory/filesystem type, and rejects known tmpfs/ramfs targets before the workload. The disk-backed benchmark, explicit memory-target rejection, formatting, lint, type checking and diff checks passed. That measurement-only checkpoint changed no application source. It is now pushed with the source fixes below; the report’s final native/helper table was refreshed on ext4 after those source changes.

### Migration and loop corrections

Failing regressions were committed at `7c147f4` (migration identifier/transaction leakage, valid keyword identifiers and busy-loop HTTP stop), then `3b92fb7` (EXPLAIN/PRAGMA preparation side effects). The initial four regressions failed against the original source, and the EXPLAIN guard case failed before its guard. Final implementation `47d3149e9af51ff2615fe836375090b3e7614f1d` replaces trigger-token inference with SQLite-parsed complete statements inside the file transaction. Top-level transaction/connection control, PRAGMA and EXPLAIN are rejected before preparation; static SQL must have no parameters and its parsed text must match the remaining source prefix. Valid trigger identifiers now work, and failures leave no leaked schema or changed connection setting.

The loop now waits on an abortable injected-clock zero delay after each nonempty bounded batch; idle polling retains its configured interval. HTTP and stop delivery can run between busy batches. The public fixture observed 5,000 items processed before stop on the old code and one item on the new code in both fake-clock and real-clock cases; fake-clock zero advancement then permits the second item and stop prevents further starts. These before/after observations and the final ext4 storage results are in [the report](https://github.com/iglo-tech/iglo.email/blob/47d3149e9af51ff2615fe836375090b3e7614f1d/docs/perf/M0.4-database.md). No permanent HTTP API change or new runtime dependency.

Final validation passed: frozen install, focused db/loop tests (20 / 134 assertions), full check (49 / 381 assertions and compiled build), disk-backed benchmark, all 28 live upstream cases, all eight reference-smoke phases and formatting/diff checks. The PR body maps the final source and evidence. Fresh CI passed in both runs, and both fresh council members are now running round 2 with all prior findings and the measurement/SQL/loop changes. Never treat the old verdicts as approvals for this head.

### Council round 2

Exact head `47d3149e9af51ff2615fe836375090b3e7614f1d` is green across check, Linux reference and both macOS prepare jobs in both push/PR runs. Both fresh reviewers were dispatched together with the full current PR, all round 1 findings/objections and the disk-backed measurement, SQLite-parsed migration and cooperative-clock changes. Opus [approved](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6455376123) exact head `47d3149e9af51ff2615fe836375090b3e7614f1d`, independently passed all acceptance commands and ext4 measurements, and verified the four regressions fail against the old source. Sol remains pending. Completion wakes this lead; do not poll, reuse or duplicate the pending reviewer. The existing PR #4 watch remains active.

- [M0.4 council round 2 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa77cad97-b170-49a6-8036-66000a618fdb); claudeAgent / claude-opus-5-5. Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa77cad97-b170-49a6-8036-66000a618fdb; child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa77cad97-b170-49a6-8036-66000a618fdb.
- [M0.4 council round 2 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A48aa611a-8c58-4f38-8a4d-d177f376d72a); codex / gpt-6.1-sol. Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A48aa611a-8c58-4f38-8a4d-d177f376d72a; child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A48aa611a-8c58-4f38-8a4d-d177f376d72a.

## Automation

The existing 45-minute chief-of-staff schedule is enabled and independent. Task ID: `scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280`. Verified `boundThreadId: null` with `bindToCurrentThread: false`; never bind this automation to a thread. Next run reported on 2026-10-27: **2026-10-27T19:06:37.204Z** (20:06:37 Warsaw). Child completions continue their originating lead run immediately. Independent scheduled runs use the lock and durable status/PR state for recovery without depending on that thread's responsiveness.

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|
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

Host-rule incident (2026-10-27): the Opus round 2 reviewer self-reported one whole-filesystem `find` to locate Echo source, contrary to `/home/t3-code/AGENTS.md`. It reported the scan finished quickly without a visible effect and was not repeated. The lead recorded the incident without repeating the scan. Worker and council instructions in the runbook now explicitly require named checkout/cache paths or pinned GitHub source inside the worktree, never a broader filesystem search when a dependency is absent.

## Paused until

Not paused. The Claude rate-limit pause ended at 2026-10-27T20:16:21.916914+00:00. M0.2 resumed and merged after both exact-head approvals were verified.
