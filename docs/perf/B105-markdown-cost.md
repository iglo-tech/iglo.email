# B105: Markdown cost model, before and after

Decision: [D112](../design/09-decisions.md#d112-markdown-cost-is-charged-in-characters-marked-scans-and-the-output-reserve-is-a-linear-upper-bound-lead-2026-11-19). Brief: [B105](../briefs/B105.md). Earlier notes: [B104](B104-markdown.md) (the link-title scan), [B103](B103-render-deadline.md) (the Liquid deadline, removed by D110).

## What this note measures, and at which head

- **Code head:** `7ee9b37` (the table charge, the reviewer's five documents and D112). This note was committed after the measurements, so the note's own commit differs from `7ee9b37` only in this file; the code is identical.
- **Container (acceptance):** `oven/bun:1.4.4` on Linux arm64, `--cpus=6`, a `git archive` export of `7ee9b37` with `bun install --frozen-lockfile` (the patch applies there). Load at the start and end of each run is recorded below.
- **Host (macOS arm64, Bun 1.4.5):** only where noted; it is not the acceptance evidence.
- **Re-measured for this head:** the 128 KiB HTTP set (every family, the marker-run matrix, the Liquid shapes, the 1000 KiB cap refusals, five concurrent previews), the reviewer's five documents and the 200-table document, the newsletters at 1, 4, 16 and 64 KiB, and the table density probe.
- **Not re-run for this head** (round 1, kept for history and labelled as such): the before-and-after table at 60 KiB against origin, the 1 MiB production path, the character sweeps and fuzz, and the e6fbe3d review measurements. The table charge (below) changes only the full table pattern, so these numbers are from before it.

## Round 2 over HTTP, every shape at exactly 128 KiB (container)

The served fixture (`markdown-serve.ts`) runs in a child process and is driven over a socket. Each body is a Liquid loop expanded to exactly 128 KiB of Markdown (127 pieces of 1 KiB and a literal pad), so it is inside the cap. The statuses are 200 when the document renders and 400 when a Markdown budget refuses it (the generic `invalid template` message).

| Group | Cases | Statuses | Slowest |
|---|---:|---|---|
| Every family (`measure-markdown.ts`'s list) | 56 | 200 or budget 400 | `block-pipe-dashes` **315 ms** (was 1,766 ms before the table charge); `block-rule-run` 176 ms |
| Marker runs (13 markers × 4 contexts × 2 trailing) | 104 | 200 or budget 400 | `star` at the end of a paragraph 61 ms |
| Liquid shapes (`markdown-liquid.test.ts`, 37) | 37 | 200 or budget 400 | `bullet then tilde` 181 ms; `numbered then code` 179 ms |
| Shapes expanded to 1000 KiB | 37 | 400, cap message | 3 ms |
| Reviewer's five documents and the 200-table document, at their own sizes | 6 | 200 | 16 ms (the table document) |
| Five concurrent 128 KiB previews, a read sent after them (3 runs) | 3 | read 200 | read 281 to 298 ms (limit 1,000) |

The slowest case is `block-pipe-dashes` at 315 ms, 15 ms above the 300 ms target. The next slowest is 181 ms. Load: 0.08 at the start and 0.30 at the end (1-minute average).

## Documents that must render

The reviewer's five documents (round 2 review), rebuilt at their stated line counts (`test/campaigns/markdown-ordinary.test.ts`): each is posted as a preview and sent by a campaign to two subscribers.

| Document | Lines | Size | Container preview | Host work units |
|---|---:|---:|---:|---:|
| Schedule of hard-break lines | 300 | 18.21 KiB | 200, 3 ms | 2.25 M |
| Address lines | 400 | 19.73 KiB | 200, 4 ms | 2.72 M |
| Events digest | 200 | 16.71 KiB | 200, 7 ms | 3.14 M |
| FAQ, heading then quote | 300 | 19.12 KiB | 200, 6 ms | 5.34 M |
| Testimonials, quote then rule | 300 | 20.11 KiB | 200, 5 ms | 4.78 M |
| 200 tables of 5 rows and 10 cells | 1,400 | 60.01 KiB | 200, 16 ms (200 `<table>`) | 20.30 M |

The table document uses 20.3 M of the 36 M limit at 60 KiB; its tables are a real shape (a header, a delimiter and five rows of ten cells each).

**Table density at 64 KiB (host, `renderMarkdown` alone).** The three densities below are the ones a table-heavy campaign could plausibly contain:

| Shape | Result | Units | Origin (`origin/main`) |
|---|---|---:|---|
| 5×10 cells with padding, as in the document above | renders, 213 tables | 21.6 M | refused, Markdown output limit |
| Prices, links and emphasis, bold headers | renders, 69 tables | 14.6 M | refused, Markdown output limit |
| Unpadded one-character cells (`|h|h|…|`), about 440 tables | **refused, work limit** | 36.0 M | refused, Markdown output limit |

The last shape is valid Markdown but is not what a campaign author writes. It is recorded as a known limit in D112, not priced lower. Origin refuses all three, so no input origin accepts is refused.

## Newsletters (container, medians of 7 renders)

From `test/templates/measure-markdown.ts --news`, one story per 1.2 KiB and every block kind an adapter sends, rendered as a Markdown body (`test/templates/markdown-newsletter.ts`):

| Size | Source bytes | Stories | Output bytes | Median render | Work units |
|---|---:|---:|---:|---:|---:|
| 1 KiB | 911 | 1 | 1,045 | 0.6 ms | 0.1 M |
| 4 KiB | 3,794 | 5 | 5,182 | 1.2 ms | 0.5 M |
| 16 KiB | 15,683 | 21 | 22,282 | 2.8 ms | 2.1 M |
| 64 KiB | 64,817 | 87 | 92,759 | 9.6 ms | 8.6 M of 36 M |

Origin refuses the same generator from 5 KiB of source (round 1 measurement), so origin/main could not send a newsletter of that length. Head renders each size above through preview, test send and a campaign send to two subscribers (`test/campaigns/markdown-newsletter.test.ts`).

## The table charge (round 2)

**Cause.** On the `|\n--\n` family at 128 KiB, marked's full table pattern (the body group, which runs only when the delimiter passes) was called 49 times and matched 5.17 M characters in total, 1,090 ms of regex time, about 210 ns per character. The charge for a table match was `scan(cap[0].length)`, one unit per character, so the 5.17 M characters cost 5.17 M units of the 36 M limit while taking about 1 s. A profile of every pattern longer than 200 characters put the rest of the time in the paragraph patterns, which measured about 70 ns per character matched and 2 ms in total.

**Change.** The table match is charged 40 units per character (`patches/marked@15.0.12.patch`, the `table` hook), roughly the measured 200 ns at the 5 ns unit. Paragraph text keeps its existing 40 units per character (20 for the block consumption and 20 for the window before the stop line), so the paragraph-stop search is covered and is not weighted separately. No other charge changed.

**Effect on the misaligned shape (host, Markdown stage alone, 128 KiB source with the renderer's 1 KiB pieces):**

| Size | Before (1 unit per table character) | After (40 units) |
|---|---|---|
| 8 KiB | ok, 10 ms | ok, 12 ms |
| 16 KiB | ok, 14 ms | ok, 13 ms |
| 32 KiB | ok, 99 ms | refused, 95 ms |
| 64 KiB | refused, 425 ms | refused, 162 ms |
| 128 KiB | refused, 1,126 ms | refused, 202 ms |

The 32 KiB row changes from accepted to refused. Origin refuses 32 KiB of this shape (work limit, 2.9 s on the host), so the change refuses no input origin accepts there. Origin accepts 8 KiB of this shape (0.8 s) and head returns identical bytes from 512 bytes to 8 KiB (checked at 512, 1,024, 2,048, 4,096 and 8,192 bytes). Origin refuses 16 KiB (output limit, 6.2 s), which head renders in 13 ms.

**Ordinary tables are not slowed.** The table document above uses about 1 ns per unit (13.9 ms for 20.3 M units on the host). No global rescale was made.

## Output identity

- The 33 B104 documents (`test/templates/markdown-compat.test.ts`) and the 4, 16 and 64 KiB newsletter pins are unchanged and pass on head.
- Round 1 (before round 2, host): 4,500 seeded random documents built from 60 fragments through origin's production path and head: origin accepts all of them and head's bytes are identical. Not re-run for `7ee9b37`; the table charge changes refusals only, not output.

## Review history (round 1 and round 2)

The round 1 review of `e6fbe3d` found the tilde-run quadratic (`~{3,}` in the paragraph and table lookaheads, now `~{3}`), a blockquote hang at about 640 KiB (now charged a window), a `reserve()` that did not bound three outputs (now reserved), and a campaign body limit that had been raised (now 64 KiB). The round 2 review found two new pre-charges that refused ordinary documents of 19 to 20 KiB (now checked before a scan and charged after it), a long thematic-break line (charged by length), and that the 1 MiB Liquid target was not met (now a 128 KiB cap on the expanded source, D112). The reviewer's five documents and the table document are tests now. The round 1 numbers (the 60 KiB before-and-after table, the 1 MiB production path, the sweeps) are not re-run and are kept only as history.

## Known differences from goldmark (not changed)

listmonk's goldmark (`models/common.go` at 6fcd95f: `WithAutoHeadingID`, `WithXHTML`, `WithUnsafe`, Table, Strikethrough, TaskList and the Typographer) and marked differ on the 4 KiB newsletter in ways that predate B105:

- goldmark gives every heading an `id`; marked does not.
- goldmark writes self-closing tags (`<img ... />`, `<br />`); marked writes `<img ...>`.
- goldmark typographs apostrophes and dashes (`&rsquo;`); marked leaves them.
- goldmark writes `&quot;` for no quote; marked writes `&quot;` in text and `"` in attributes, as above.
- marked writes a raw `&` in `href` (`?ref=digest&utm=weekly`); goldmark writes `&amp;`. The raw form is valid HTML for these URLs, but an entity-looking name such as `&copy=` would be read as `©`. This predates B105 and is a backlog item.

So the newsletter pins in `markdown-compat.test.ts` are this renderer's own output, as the B104 pins are; they are not goldmark's.

## Edge case

`[x](()" ")` is a link to `(` with text `&quot; &quot;)` on origin and on head, and goldmark renders it as text (`<p>[x](()&quot; ")</p>`). A link-destination rule, not a cost; not changed, listed as backlog.

## Limits

- Timings are single runs or medians on a shared machine. The container numbers are the acceptance numbers; the host numbers are context.
- The work units approximate time: about 5 ns each (`WORK_LIMIT`, `markdown.ts`). Table matches are weighted at 40 per character from a measured 200 ns; other sites use measured regex costs or the round 1 weights. A shape whose real cost per unit is far from these weights can exceed the target, as the round 2 `block-pipe-dashes` did before the table charge.
- The unpadded one-character table document at 64 KiB is refused by the work limit (36.0 M units). It is recorded in D112 as a known limit.
- The round 1 measurements above are not re-run for this head (listed at the top).
