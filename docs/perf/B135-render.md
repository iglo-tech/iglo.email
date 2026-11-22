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

## Reproduce

```sh
git archive --format=tar --output=base.tar origin/main   # then extract into base/
git archive --format=tar --output=head.tar HEAD          # then extract into head/
# in each extracted tree: bun install --frozen-lockfile
bun test/templates/measure-send-render.ts 1              # repeat, alternating trees
```
