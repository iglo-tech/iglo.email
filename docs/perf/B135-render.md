# B135: send render before and after (D110)

B135 changes the Liquid renderer on the sending path: the new filters (`size`, `json`, the string
filters, `split`/`join`/`slice`/`truncate`/`truncatewords`/`strip_html`), the `date` format and
calendar checks, and the object-loop tests. This note measures whether a send renders any slower.

## Method

- Benchmark: `test/templates/measure-send-render.ts`. Each run is one process: it compiles three
  templates (a transactional HTML message with a loop, a campaign layout, a plain-text message), and
  renders each of 200 recipients with a fresh message budget. The first 20 renders are a warm-up.
  Each round's number is the mean time per `renderSync` call over the 200, in microseconds. It only
  uses renderer APIs both trees have, so one file runs on both.
- Trees: `origin/main` (`a15c44f`) and the branch head with the benchmark (`e32eda3`), each exported
  with `git archive` and installed with `bun install --frozen-lockfile`.
- One container, `oven/bun:1.4.5` on linux/arm64 (the CI image's platform and the Bun version of
  `package.json`), on the development host. Base and head run alternately, one process each, 20 rounds
  per tree, so both see the same host load. Disposable container, removed afterwards.
- Command, from each tree: `bun test/templates/measure-send-render.ts 1` (one round per process).

## Results

Median over 20 rounds per tree, microseconds per render. The range is the fastest and slowest round.

| Case | Base median (range) | Head median (range) | Change of the median |
|---|---|---|---|
| Transactional HTML (subject, `upcase`, `number`, `date`, `default`, a 20-item loop) | 217.3 (163.9 to 304.6) | 220.0 (159.2 to 338.5) | +1.2 % |
| Campaign layout (`track_link`, `track_view`, `raw` content) | 29.3 (22.2 to 47.5) | 27.5 (22.2 to 46.2) | -6 % |
| Plain text (a loop with `upcase`) | 61.2 (49.7 to 95.2) | 60.2 (47.2 to 106.4) | -1.6 % |

The medians differ by less than the spread of each tree (a round varies by up to about 2x on this
shared host). There is no consistent slowdown in any case, so no regression is shown.

## Why no change is expected, and what does change

- The filters are registered once, when the renderer's Liquid engine is built. A send compiles its
  template and renders it; neither compile nor render adds work for a filter the template does not
  use.
- The `date` filter now also compares the ISO form of a date with its input (item 6): one
  `toISOString` per call. A transactional message calls `date` once per recipient, so that is about a
  microsecond per recipient, inside the noise above.
- The save-time render (item 4) runs at save, not at send, and is not part of this measurement.
- A template that uses a new filter does its own work, bounded by the D54 budgets; the budget tests in
  `test/templates/filters.test.ts` cover that.

## Re-measured at the review fixes (head `fdec764`)

The review's fixes changed the renderer and the converter after the table above, so both were measured
again with the same method: `origin/main` (`72dddbb`) and the head (`fdec764`), each exported with
`git archive` and installed with `bun install --frozen-lockfile`, in one `oven/bun:1.4.5` container
(linux/arm64), 20 rounds per tree, base and head alternating, one process per round.

Render (`test/templates/measure-send-render.ts 1`), median over 20 rounds, microseconds per render. The
range is the fastest and slowest round:

| Case | Base median (range) | Head median (range) | Change of the median |
|---|---|---|---|
| Transactional HTML (a 20-item loop, `date`, `number`, `default`, `upcase`) | 188.3 (151.4 to 295.9) | 182.4 (146.6 to 262.2) | -3 % |
| Campaign layout (`track_link`, `track_view`, `raw` content) | 26.4 (20.5 to 45.9) | 25.3 (21.5 to 44.4) | -4 % |
| Plain text (a loop with `upcase`) | 63.9 (45.3 to 92.8) | 54.8 (48.6 to 72.0) | -14 % |

The medians differ by less than the spread of each tree, so no slowdown is shown. An earlier head,
measured before `date` computed one directive at a time, was about 9 % slower on the transactional HTML
median (206.8 against 189.2 µs, with the same ranges overlapping); that cost is gone.

Converter (`test/messaging/measure-plain-depth.ts`), the review's shape: 1,000 open lists, then 100,000
`<li>x</li>` items (1.0 MB of HTML). Median of five conversions per process, 20 rounds per tree:

| Tree | Median time (range) | Output | Resident memory after (median, range) |
|---|---|---|---|
| `origin/main` | 168.3 ms (158.9 to 188.8) | 400 KB text part | 78 MiB (76 to 85) |
| Head | 98.0 ms (93.9 to 111.1) | no text part | 89 MiB (82 to 98) |

The head is faster because it stops once its output would be longer than the HTML (the check that runs as
the output grows), and so it writes no text part for this shape. On `main` the same items have no indent
and fit the HTML; with the list depth indented, each item is longer than its `<li>` markup, so the message
goes without a text part, as an over-long conversion always does (D118). A list nested nine or more levels
deep indents at the eight-level cap. Shapes that fit keep their text part: the ratio tests in
`test/messaging/plain-nesting.test.ts` cover the cap and the linear time.

## Reproduce

```sh
git archive --format=tar --output=base.tar origin/main   # then extract into base/
git archive --format=tar --output=head.tar HEAD          # then extract into head/
# in each extracted tree: bun install --frozen-lockfile
bun test/templates/measure-send-render.ts 1              # repeat, alternating trees
```
