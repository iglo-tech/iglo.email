# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-28

## Active

Day-to-day lead: [iglo.email — Chief of staff](t3-thread://v1/mcp:cc118fea-54ef-42c0-a515-e77d835e9df7), GPT-6.1 Sol at xhigh reasoning.

M0.6 is in council round 2 on [PR #6](https://github.com/iglo-tech/iglo.email/pull/6), exact head `cbd877d9488063a46f2e8d9d2be348cde27570d5`. All eight CI jobs passed on that current head (the wake named an older head, which was checked before proceeding). Both fresh independent reviewers are running with all prior findings, the lead D21 decision and regression-first evidence. Their completions wake this lead. The existing PR watch remains active; do not poll or start duplicate reviewers.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.6 | council | task/M0.6-jsx-assets; [#6](https://github.com/iglo-tech/iglo.email/pull/6) | 2 | [Brief](briefs/M0.6.md). Head `cbd877d9488063a46f2e8d9d2be348cde27570d5`; all eight CI jobs passed. Lead validation: 91 tests / 621 assertions, 21 production cases, 23 fixture + 2 probes (prior method correction), 43 upstream cases, ui:verify and focused regressions passed. Four failures preceded `82f0784`/`eef7472`; ten more preceded `f108f7e`/`cbd877d`. Both round-1 reviews are terminal with CHANGES; fresh round-2 Opus/Sol verdicts are pending on the corrected head. |


Completed worker: [M0.6: JSX runtime, page shell and asset build — Terra max](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ad81d45af-5150-461a-a3bf-c4ec2f759c0b); codex / gpt-6.1-terra, reasoningEffort: max.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ad81d45af-5150-461a-a3bf-c4ec2f759c0b
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ad81d45af-5150-461a-a3bf-c4ec2f759c0b
- Terminal worker checkout: `/home/t3-code/.t3/worktrees/iglo.email/t3-4276c4dd`; preserve it for small lead fixes.
- PR #6 is linked and watched in this lead thread. Both round-1 reviews are terminal with CHANGES; no replacement or round-2 reviewer started.

Lead correction: OPTIONS/405 now advertise implemented methods; D21 enables metadata-only HEAD for embedded assets. The shared corpus checks declared headers and includes a D18 static escape against actual compiled production; ui:verify executes it as well, and the public API policy names it. The admin-specific error page is recorded as pending M4.1. The expanded reference corpus passed before the application change.

Additional Sol corrections: decode asset names once and POSIX-clean them inside the original embedded namespace/manifest. The three equivalent stylesheet spellings now run in the shared corpus; escaped font MIME/WOFF2 is verified by source-first reference observations and compiled HTTP tests. The HTML CLI uses browser URL parsing to catch control-character executable schemes and rejects hidden/styled elements and unexpected stylesheets. All ten added regressions failed first and now pass.

Handoff notes for council: the existing D18 dot-segment normalization also changes the refusal body for encoded traversal targets that leave the static prefix (upstream plain-text 404 versus normal HTML 404); both refuse the asset. Inspect the exact coverage and metadata against the policy. Production admin/auth remains absent, with the shell verified only by a compiled fixture. The lead documentation-only commit `b8797e2` updates the current coverage table while retaining the historical reference-first baseline.

### Council round 1

[M0.6 council round 1 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa6133c7c-ea6b-4cd0-a3c9-9ee1c1eace6e); claude-opus-5-5. [CHANGES](https://github.com/iglo-tech/iglo.email/pull/6#issuecomment-6456667733): static OPTIONS/Allow and missing D18 static-path marker. All eleven acceptance commands and browser verification passed. Lead also addresses HEAD policy and records admin error-page staging.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa6133c7c-ea6b-4cd0-a3c9-9ee1c1eace6e
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa6133c7c-ea6b-4cd0-a3c9-9ee1c1eace6e

[M0.6 council round 1 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ae6b34983-56ae-4a69-b11c-10cb255493de); gpt-6.1-sol. [CHANGES](https://github.com/iglo-tech/iglo.email/pull/6#issuecomment-6456715918): escaped/canonical asset spellings, copied HEAD rejection, and HTML false passes for executable URLs and hidden headings. All required acceptance and browser checks passed; tracked files unchanged.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ae6b34983-56ae-4a69-b11c-10cb255493de
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ae6b34983-56ae-4a69-b11c-10cb255493de

### Council round 2

[M0.6 council round 2 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Af8540c88-b7c8-458d-8657-d7146788715f); claude-opus-5-5. Verdict pending on `cbd877d9488063a46f2e8d9d2be348cde27570d5`.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Af8540c88-b7c8-458d-8657-d7146788715f
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Af8540c88-b7c8-458d-8657-d7146788715f

[M0.6 council round 2 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ac9907848-05e4-40e2-8d11-df5dc2b1f5c0); gpt-6.1-sol. Verdict pending on `cbd877d9488063a46f2e8d9d2be348cde27570d5`.

- Task ID: node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ac9907848-05e4-40e2-8d11-df5dc2b1f5c0
- Child thread ID: thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ac9907848-05e4-40e2-8d11-df5dc2b1f5c0

## Automation

The existing 45-minute chief-of-staff schedule is enabled and independent. Task ID: `scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280`. Verified `boundThreadId: null` with `bindToCurrentThread: false`; never bind this automation to a thread. Next run reported on 2026-10-27: **2026-10-27T19:06:37.204Z** (20:06:37 Warsaw). Child completions continue their originating lead run immediately. Independent scheduled runs use the lock and durable status/PR state for recovery without depending on that thread's responsiveness.

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|
| M0.5 | [#5](https://github.com/iglo-tech/iglo.email/pull/5) | 2026-10-27, `11476506671e4f326d1f7100710de051a487a42a` | Shared contract corpus, scoped normalization and D17/D18; explicit production versus fixture staging (D20). [Opus](https://github.com/iglo-tech/iglo.email/pull/5#issuecomment-6456090407) and [Sol](https://github.com/iglo-tech/iglo.email/pull/5#issuecomment-6456132407) approved exact head `095f8c0421abf70ac11808a236029f1213218864` in round 2; all eight CI jobs passed. 72 tests, 8 production cases, 23 fixture + 2 probe cases, 31 upstream cases. [Review record](reviews/M0.5.md). |
| M0.4 | [#4](https://github.com/iglo-tech/iglo.email/pull/4) | 2026-10-27, `a988c62d8bbf854a98ad2e750773b76cce3f323f` | SQLite primitives, migrations/snapshots, named SQL and cooperative loop lifecycle. [Opus](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6455376123) and [Sol](https://github.com/iglo-tech/iglo.email/pull/4#issuecomment-6455414436) approved exact head `47d3149e9af51ff2615fe836375090b3e7614f1d` in round 2; all eight CI jobs passed. Acceptance: 49 tests / 381 assertions, 28 upstream cases, eight smoke stages and corrected ext4 measurements. Production stays at version 0. [Review record](reviews/M0.4.md), [measurements](perf/M0.4-database.md). |
| M0.3 | [#3](https://github.com/iglo-tech/iglo.email/pull/3) | 2026-10-27, `cb41fd6f29a07415541fcb95101ba84e64231ad6` | Shared HTTP/app/clock/i18n contracts. Both final CI runs passed all four job types. Three council rounds ended with matching URI findings; the lead fixed both and merged under the [three-round resolution](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454296622), supplemented by the [reference readiness repair](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454452814). No final-head council approval is claimed. Final local checks: 27 tests / 237 assertions, 28 upstream cases and eight smoke stages. [Review record](reviews/M0.3.md). |
| M0.2 | [#2](https://github.com/iglo-tech/iglo.email/pull/2) | 2026-10-27, `2946b45cad2f9e1caf63311ba814fbde56c3e40f` | Upstream reference and test services. All CI jobs green; [Opus](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6452884686) and [Sol](https://github.com/iglo-tech/iglo.email/pull/2#issuecomment-6451369141) approved exact head `cd556c981eac3e3cb6a2ff28dc2ca1e4816e2569` in round 2. Both passed full local checks and all eight Linux smoke stages. Native macOS binary preparation passed CI; full macOS Docker lifecycle remains unverified. Process-group cleanup was tightened after round 1. The Claude rate-limit pause expired before T3 automatically resumed the reviewer; no duplicate review was started. |
| M0.1 | [#1](https://github.com/iglo-tech/iglo.email/pull/1) | 2026-10-27, `7dffb86e0cc1169815c5a7611516c05018ee9b30` | Project skeleton. Both CI checks passed; [Opus](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450451709) and [Sol](https://github.com/iglo-tech/iglo.email/pull/1#issuecomment-6450467491) approved exact head `56935d1148bdce063dd4e9d5a0e752bd126c3468` in round 1. Both independently passed acceptance (8 tests, 97 assertions). Live reference comparison follows in M0.2/M0.5. |

## Follow-ups

- M0.6/public-page work must finish the explicitly deferred public HTML 404 fallback (including `POST /health`). Update the two route-backed D18 contract fixture expectations when that fallback changes; retain the exact-target discrimination and upstream assertions. It remains a temporary staging gap; API error bodies are complete for the current scope.
- M1.3 must promote the D20 protected-read cases to actual production authentication; M1.5/domain owners promote helper cases. M0.5 now carries D17/D18. Native macOS binary preparation passes CI; full native macOS Docker lifecycle remains unverified.

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

M0.6 plan clarification (2026-10-27): finish the public HTML 404 deferred by M0.3/M0.5 in the JSX/page-shell task. Verify the admin shell in a compiled fixture until M1/M4 provide protected screens. Copy only v1 browser assets/build dependencies; CAPTCHA and the visual builder stay later-only. The task row and [brief](briefs/M0.6.md) now make those boundaries and the contract/browser acceptance explicit.

D21 (2026-10-28, implemented and awaiting review in PR #6): support HEAD for embedded assets so callers can inspect metadata without downloading resources; advertise HEAD together with GET/OPTIONS. Keep upstream 405 for unsupported methods with a matching Allow header. The decision/API-policy row and precise reference/normal contract markers are included in `eef7472`.

Host-rule incident (2026-10-27): the Opus round 2 reviewer self-reported one whole-filesystem `find` to locate Echo source, contrary to `/home/t3-code/AGENTS.md`. It reported the scan finished quickly without a visible effect and was not repeated. The lead recorded the incident without repeating the scan. Worker and council instructions in the runbook now explicitly require named checkout/cache paths or pinned GitHub source inside the worktree, never a broader filesystem search when a dependency is absent.

## Paused until

Not paused. The Claude rate-limit pause ended at 2026-10-27T20:16:21.916914+00:00. M0.2 resumed and merged after both exact-head approvals were verified.
