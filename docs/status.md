# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/11-work-plan.md).

Updated: 2026-10-27

## Active

M0.1 is at worker dispatch for a GPT-6.1 Terra worker at max reasoning.

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.1 | worker | `task/M0.1-project-skeleton` | 0 | Dispatching from `origin/main`. Brief: [M0.1](briefs/M0.1.md). Lead: Sol xhigh; worker: Terra max; council: Opus medium and fresh Sol xhigh. |

## Automation

The chief-of-staff schedule is enabled every 45 minutes and bound to the Sol xhigh lead thread. Task ID: `scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280`. Child completions continue the active task immediately; scheduled runs provide recovery when no run is active.

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

The owner started the port on 2026-10-27 and set the model assignments: GPT-6.1 Sol at xhigh for the lead, GPT-6.1 Terra at max for all implementation and helpers, and Claude Opus 5.5 at medium only as a council member alongside a fresh Sol xhigh reviewer. See [work plan](design/11-work-plan.md#models).

## Paused until

Not paused.
