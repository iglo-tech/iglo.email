# B103: render time with the deterministic budgets alone (D110)

Brief B103 section 3. The wall-clock `renderLimit: 1000` of `src/templates/renderer.ts` (a deadline
on `performance.now()`) is removed. This note shows that the D54 budgets alone keep the worst
renders far below one second, so removing the deadline changes no output a template can produce
within the budgets.

## Method

- Host: this development workstation (macOS, Apple silicon), the real clock, no container. The
  numbers are for the renderer's `compile(…).renderSync(data)` path, the campaign path.
- Each case renders 20 times. The table gives the median and the maximum of the 20 wall-clock
  times, in milliseconds, and the outcome of the render (its error, or its output size).
- "Before" is the renderer with `renderLimit: 1000`; "after" is the renderer with the option and
  its explicit clock checks removed. Both measured the same templates in one session.
- The script (not committed) is `measure-deadline.ts`: each template below is compiled once and
  rendered 20 times with its data.

The cases are chosen to reach each budget, not to be exhaustive. Budgets (D54, `renderer.ts`):
work 10,000 steps per message; emission 4 MiB cumulative per message; 1 MiB per output; nesting 32;
ranges 1,024 iterations; parse 64 KiB of source.

## Worst case per budget

| Case | Budget it reaches | Before: outcome, median / max (ms) | After: outcome, median / max (ms) |
| --- | --- | --- | --- |
| nested loops 1000 × 1000 | work (10,000 steps) | Work limit, 0.58 / 2.99 | Work limit, 0.48 / 2.61 |
| filter chain (6 filters) × 1000 | work | Work limit, 1.81 / 4.02 | Work limit, 1.78 / 3.70 |
| 8 KiB captured × 500 (just under 4 MiB) | emission | ok, 0.74 / 1.97 | ok, 0.68 / 1.95 |
| 8 KiB output × 127 (just under 1 MiB) | output | ok, 0.16 / 0.60 | ok, 0.15 / 0.89 |
| 8 KiB `strip` × 500 | output (1 MiB) | Output limit, 0.22 / 0.84 | Output limit, 0.21 / 0.84 |
| 40 nested `if` | nesting (32) | Nesting limit, 0.10 / 0.34 | Nesting limit, 0.10 / 0.34 |
| 31 nested `if` (just under) | nesting | ok, 0.02 / 0.05 | ok, 0.02 / 0.03 |
| 2,000-iteration loop | ranges (1,024) | range limit, 0.01 / 0.02 | range limit, 0.00 / 0.02 |

## Reading

- The largest render measured, before or after, took 4.02 ms (the work budget). The 1 s deadline
  was never reached by a template inside the budgets. A render that does exceed one second on a
  quiet host has to be one the budgets do not bound, which D54 forbids.
- Under CPU contention a render takes longer than it does here, by the factor of the contention.
  That factor is what turned a 4 ms render into the B103 failure (a subscriber recorded `failed`
  when its render took more than 1 s under load). Removing the deadline removes that dependence on
  host load; the budgets still bound the work.
- The before and after medians agree within noise on every case. The change alters no output and
  no error within the budgets. It changes only renders that would otherwise have failed by time.

## Evidence files

- `before.txt` and `after.txt` in the B103 scratch directory hold the raw script output (not
  committed).
- The failing-before test is `test/templates/render-deadline.test.ts`: with the deadline it throws
  `template render limit exceeded`; without it, it returns `123`.
