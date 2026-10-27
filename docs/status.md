# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-27

## Active

Day-to-day lead: [iglo.email — Chief of staff](t3-thread://v1/mcp:cc118fea-54ef-42c0-a515-e77d835e9df7), GPT-6.1 Sol at xhigh reasoning.

M0.3 readiness repair is pushed at `8ad3303195382b25322cf4adfef67f36ebbe1f95`. Full local checks (27 tests / 237 assertions), all eight lifecycle smoke stages and 28 upstream cases passed. The [lead resolution](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454452814) retains the three-round decision and requires fresh exact-head green CI before merge.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.3 | ci | [PR #3](https://github.com/iglo-tech/iglo.email/pull/3), `task/M0.3-shared-contracts` | 3 completed; lead resolution | Head `8ad3303195382b25322cf4adfef67f36ebbe1f95` adds explicit TCP `pg_isready` before the published-port probe, fixing the reproduced reference startup race. Full local check, eight smoke stages and 28 upstream cases passed without retry. Merge only after exact-head CI passes under the recorded three-round resolution. [Brief](briefs/M0.3.md). |

Completed worker: [M0.3: Shared HTTP and application contracts — Terra max](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Abc6987b1-7251-4c79-8eeb-258df345672b); `codex`, `gpt-6.1-terra`, `reasoningEffort: max`. Reference cases were committed first at `0b732f7017f0ec46b41bf6fa0d49d63459bf4363` and passed against the pinned live upstream before implementation. Initial acceptance and CI passed (18 tests / 156 assertions). Validation for the council fixes is recorded below. The existing PR #3 watch remains active; no merged-task PR watch is active.

Scope review: `POST /health` returns the verified upstream 404 status but a plain-text body, while upstream renders its public HTML error page. The M0.3 brief explicitly defers public HTML rendering. The lead accepts this as temporary staging, already documented in the submitted architecture note and PR, rather than a permanent API difference. API 404/error bodies and `GET /health` retain the upstream contract. Track completion of the public HTML fallback with M0.6/public-page work; do not treat the temporary body as the final contract.

- Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Abc6987b1-7251-4c79-8eeb-258df345672b`.
- Child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Abc6987b1-7251-4c79-8eeb-258df345672b`.

### Council round 1

Both reviewers completed with CHANGES for exact head `644411b3aa798703953002dec1641559e0947f33`: [Opus findings](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6453342721), [Sol finding](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6453344337). The lead added reference cases and failing HTTP regressions before the fixes (`a0be523`), then fixed all three bugs at `ef9b324181e69b4dd816d6145d94599bc9fed925`. Route coverage checks all six registration orders at two path depths in isolated HTTP fixtures; empty bodies reach validation; dollar replacement sequences remain literal. The ID-overflow reference 500 and normal fixture 400 are marked D17, with policy and decision records in the same PR. Final local validation passed: `bun run check` (22 tests / 207 assertions), all 15 live upstream cases, all eight reference-smoke stages and formatting/diff checks. The existing PR #3 watch remains active. The new head needs both fresh council verdicts after CI.

- [M0.3 council round 1 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa20f861c-2f11-4b66-a1d3-deedcca621e5); `claudeAgent`, `claude-opus-5-5`, `effort: medium`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa20f861c-2f11-4b66-a1d3-deedcca621e5`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Aa20f861c-2f11-4b66-a1d3-deedcca621e5`.
- [M0.3 council round 1 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A6cb2330e-15e6-4507-8e5f-8d32700185e7); `codex`, `gpt-6.1-sol`, `reasoningEffort: xhigh`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A6cb2330e-15e6-4507-8e5f-8d32700185e7`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A6cb2330e-15e6-4507-8e5f-8d32700185e7`.

### Council round 2

Opus [approved](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6453600736) and Sol [requested changes](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6453654277) for exact head `ef9b324181e69b4dd816d6145d94599bc9fed925`. Both found the round 1 issues resolved and passed acceptance. Sol additionally reproduced encoded digits/plus signs accepted by the fixture ID handler while upstream returns 400 `invalid ID`. The lead preserved the default Go/Echo decoded-versus-escaped path choice without an extra parameter unescape, based on pinned Echo v5.4.0 and Go 1.27.2 source. New upstream cases and failing HTTP regressions were committed first at `49ad88358a4c2ca5e795084f08afc1c436bbfe27`; the fix is `1669923c66d4cfdf9a46c078483dc518ac28f1a2`. Raw-request checks also found that Bun normalizes encoded dot segments before handlers see the URL. D18 records this transport difference in the policy and decision log, and both reference and normal HTTP tests mark it. Final acceptance passed: frozen install, full check (25 tests / 228 assertions, including 17 server tests), 22 live upstream cases and all eight reference-smoke phases. The test-only exact-target client uses separate connections after a connection-reuse failure was corrected. CI and fresh council round 3 are next. The existing PR #3 watch remains active.

- [M0.3 council round 2 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ae17fb49f-0b01-425f-b19d-0ac0020a5b5e); `claudeAgent`, `claude-opus-5-5`, `effort: medium`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ae17fb49f-0b01-425f-b19d-0ac0020a5b5e`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3Ae17fb49f-0b01-425f-b19d-0ac0020a5b5e`.
- [M0.3 council round 2 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A53c1ed19-941f-4785-9a35-be2ee4787a9f); `codex`, `gpt-6.1-sol`, `reasoningEffort: xhigh`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A53c1ed19-941f-4785-9a35-be2ee4787a9f`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A53c1ed19-941f-4785-9a35-be2ee4787a9f`.

### Council round 3

Both reviewers requested changes on exact head `1669923c66d4cfdf9a46c078483dc518ac28f1a2`: [Opus](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454185419) and [Sol](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454240035). Both found all earlier issues resolved and reported the same two remaining gaps: malformed percent syntax reached handlers, and D18 omitted literal backslash normalization. The lead reproduced both with exact-target HTTP against the pinned source/reference, committed the failing regression and reference cases first at `dd0b45cc764387ac9e489ad39c12195d71776b0e`, and fixed/documented them at `adc4f284d866f0f22dd165a99241bc401c361fa0`. The existing branch/worktree remains `/home/t3-code/.t3/worktrees/iglo.email/t3-c9aa2134`.

Final local validation passed: `bun run check` (27 tests / 237 assertions, including 19 server tests and the compiled build), all 28 live upstream cases and diff/format checks. Malformed visible percent syntax now returns the upstream transport’s plain-text 400 before route dispatch; valid `%FF` and independently decoded query values retain their behavior. D18 and both modes now cover literal backslash normalization. Both commits are pushed.

The [lead resolution](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454296622) applies the documented three-round rule: the bounded changes satisfy both concrete findings; no approval is claimed for the final head, and no fourth council round is planned. **The merge gate failed on `adc4f284d866f0f22dd165a99241bc401c361fa0`; require green CI on the readiness repair head below.** The existing PR #3 watch remains active.

Reference-harness observation: Sol’s first smoke attempt hit Postgres `57P03` during install (“database system is starting up”); its complete rerun passed all smoke stages. The harness is unchanged by M0.3. It subsequently repeated in final-head CI and is addressed by the bounded readiness repair below, without an install or CI retry. Full macOS Docker lifecycle remains unverified.

- [M0.3 council round 3 — Opus medium](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A9c478460-98f0-449c-ab7d-db505871132e); `claudeAgent`, `claude-opus-5-5`, `effort: medium`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A9c478460-98f0-449c-ab7d-db505871132e`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A9c478460-98f0-449c-ab7d-db505871132e`.
- [M0.3 council round 3 — Sol xhigh](t3-thread://v1/thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A81aed40f-d8c2-4639-abe0-136693496704); `codex`, `gpt-6.1-sol`, `reasoningEffort: xhigh, serviceTier: default`. Task ID: `node:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A81aed40f-d8c2-4639-abe0-136693496704`; child thread ID: `thread:delegated-task:command%3Amcp%3Aeff75b40-7854-49a4-9910-63ce004c3467%3Adelegate-task%3A81aed40f-d8c2-4639-abe0-136693496704`.

### CI readiness repair

The [failed reference-linux job](https://github.com/iglo-tech/iglo.email/actions/runs/40588851288/job/122487469226) reached `server:reference`, then listmonk installation failed with Postgres `57P03` before contract requests ran. The other Linux CI run passed on the same head. This repeats the round 3 observation. The harness’s published-port probe only sent an SSL negotiation packet, which can succeed while Postgres is still rejecting startup/database connections.

The lead expanded only the acceptance-infrastructure scope of M0.3 to repair `test/reference/run.ts` and its README: use the existing container’s `pg_isready` with explicit TCP host `127.0.0.1`, then retain the published-port handshake. Explicit TCP excludes the image’s temporary Unix-socket initialization server. The existing bounded readiness loop waits; installation still executes once. No application storage, extra service, dependency or host policy changes. The fix is published at `8ad3303195382b25322cf4adfef67f36ebbe1f95`. Final validation passed without retry: `bun run check` (27 tests / 237 assertions and compiled build), all eight lifecycle smoke stages, all 28 live upstream cases and diff/format checks. The [CI readiness resolution](https://github.com/iglo-tech/iglo.email/pull/3#issuecomment-6454452814) supplements the three-round lead resolution; no fourth review is planned. **Require green CI on exact head `8ad3303195382b25322cf4adfef67f36ebbe1f95` before merge.** The existing PR #3 watch remains active.

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

[D17](https://github.com/iglo-tech/iglo.email/blob/ef9b324181e69b4dd816d6145d94599bc9fed925/docs/design/09-decisions.md#d17-reject-positive-route-id-overflow-before-storage) (2026-10-27, recorded in PR #3 for merge): reject positive route IDs above the signed 64-bit maximum with 400 `invalid ID` before storage. Upstream ignores the conversion overflow and leaks a database error as 500. This gives callers an accurate client error without exposing storage details; the focused reference and normal HTTP cases mark the deliberate difference.

[D18](https://github.com/iglo-tech/iglo.email/blob/adc4f284d866f0f22dd165a99241bc401c361fa0/docs/design/09-decisions.md#d18-use-buns-normalized-request-path) (2026-10-27, recorded in PR #3 for merge): use the canonical request URL exposed by `Bun.serve`, including dot-segment removal and literal backslash-to-slash rewriting. Exact-target `%2E` / `%2E%2E` list-ID requests return upstream 400 but reach the current fixture API fallback after Bun normalization. This keeps routing and future permission middleware on one URL interpretation without introducing another HTTP transport/parser for request spelling the runtime does not expose. Both modes mark dot-segment and backslash differences for M0.5; visible malformed percent syntax is rejected with upstream’s transport response.

Host-rule incident (2026-10-27): the Opus round 2 reviewer self-reported one whole-filesystem `find` to locate Echo source, contrary to `/home/t3-code/AGENTS.md`. It reported the scan finished quickly without a visible effect and was not repeated. The lead recorded the incident without repeating the scan. Worker and council instructions in the runbook now explicitly require named checkout/cache paths or pinned GitHub source inside the worktree, never a broader filesystem search when a dependency is absent.

## Paused until

Not paused. The Claude rate-limit pause ended at 2026-10-27T20:16:21.916914+00:00. M0.2 resumed and merged after both exact-head approvals were verified.
