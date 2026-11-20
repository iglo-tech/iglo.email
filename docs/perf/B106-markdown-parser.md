# B106: Markdown parser choice (phase 1)

Brief [B106](../briefs/B106.md), decision [D113](../design/09-decisions.md#d113-markdown-uses-a-linear-time-commonmark-parser-lead-2026-11-19). This note is the phase-1 comparison: no code changed. It is the evidence for the parser choice the lead must accept before the replacement starts.

**Recommendation: `Bun.markdown` (native to the Bun runtime, no new dependency).** It passes all 652 CommonMark 0.31.2 examples, runs in at most 11.7 ms on every 128 KiB family, and scales linearly. micromark is quadratic on families that time out at 128 KiB, so it is rejected. markdown-it is the fallback, but it is not linear by design and adds a dependency.

## Setup

- Host: macOS, Apple silicon. Timings and output comparisons ran in `oven/bun:1.4.5` (linux/arm64, `aarch64`), the image pinned by `packageManager`. The probe ran as root (no test suite), one case per child process, with a 10 s timeout. Fast cases (under 300 ms) are the median of up to three runs; slow ones run once.
- Reference: goldmark v1.8.6 (Go 1.26.5, macOS), with listmonk's options at 6fcd95f (`models/common.go`): `WithAutoHeadingID`, `WithXHTML`, `WithUnsafe`, Table, Strikethrough, TaskList, and the Typographer with curly double quotes replaced by `"`. Goldmark has no linkify, so listmonk does not turn bare URLs into links.
- Today: marked 15.0.12 with the pinned patch (`patches/marked@15.0.12.patch`), `gfm: true`, as `renderMarkdown` runs it. "Served" is the production path with the budget, and "raw" is the same parser without the budget.
- Candidates: micromark 4.0.3 with `micromark-extension-gfm-table` 2.1.2, `-strikethrough` 2.1.0 and `-task-list-item` 2.1.0, `allowDangerousHtml` and `allowDangerousProtocol`; markdown-it 15.0.3 (`html: true`, `linkify: false`, typographer off); `Bun.markdown.html(src)` with its defaults.
- The probe lives in the worker's scratch directory and is not committed. Phase 2 will commit a measurement helper under `test/templates/`, as the brief's ownership list allows.

## Candidates

| | Licence | Added to the server | Size of the render path | Runs from Bun without a build step |
|---|---|---|---|---|
| `Bun.markdown` (Bun 1.4.5) | MIT (Bun; its bundled JavaScriptCore is already in the runtime) | nothing: built into the runtime, checked in a `bun build --compile` executable | 0 | yes |
| micromark 4.0.3 + three GFM extensions | MIT | 4 npm packages | 92 KB minified, 25.7 KB gzip | yes |
| markdown-it 15.0.3 | MIT | 1 npm package | 101 KB minified, 41.8 KB gzip | yes |
| marked 15.0.12 (today, patched) | MIT | 1 npm package and the patch | not measured | yes |
| goldmark v1.8.6 (reference only) | MIT | none (Go) | not applicable | no |

## CommonMark 0.31.2 pass rate

652 examples from the 0.31.2 spec. Each engine's HTML and the expected HTML go through the same approximate normaliser (entity and typographic folding, attribute sorting, self-closing slashes, whitespace between tags). It is applied the same way to every engine, so the numbers compare the engines with each other, not with the official runner.

| Engine (CommonMark flavour) | Passing |
|---|---|
| goldmark v1.8.6 (reference) | 652 |
| `Bun.markdown` (tables, strikethrough, task lists off) | 652 |
| markdown-it 15.0.3 (`commonmark` preset) | 652 |
| micromark 4.0.3 (`allowDangerousProtocol: true`) | 652 |
| micromark 4.0.3 without `allowDangerousProtocol` | 648 (examples 500, 598, 599, 601: URLs with unusual schemes are blanked) |
| marked 15.0.12 (`gfm: false`) | 599 |

micromark needs `allowDangerousProtocol: true` to pass. listmonk renders raw HTML with `WithUnsafe`, so the option matches listmonk.

## Timings at 128 KiB

Each family is the B104/B105 pathological list (`test/templates/measure-markdown.ts`, 56 families) plus eight reviewer shapes from B105 r2/r3: a paragraph followed by whitespace-only lines (`x\n` then tab-indented, two-space or one-space lines), `~` runs after a paragraph, a quote, a table header and a list item, and the `* *` rule run. 64 cases per engine.

| Engine | Families over 100 ms | Timeouts (over 10 s) | Slowest that finished | Notes |
|---|---|---|---|---|
| marked, today, as served | 3 | 0 | 2,451 ms (`ws-tail-tab`) | 45 refused by the budget; the slowest refusal took 160 ms |
| marked, today, raw (no budget) | 23 | 7 | 9,626 ms (`link-open`) | the super-linear link, reflink and whitespace shapes |
| micromark 4.0.3 + GFM | 31 | 17 | 765 ms | quadratic (below); the 15 `block-*` families of pipe, dash, backtick, bracket and similar lines, plus `emphasis-run` and `hr-run`, time out |
| markdown-it 15.0.3 | 4 | 0 | 153 ms (`reflink-open`) | no guarantee by design; the shapes measured are fast |
| `Bun.markdown` 1.4.5 | 0 | 0 | 11.7 ms | linear (below) |

micromark is quadratic, with or without GFM. The `block-pipe` family (`|\n-\n` repeated) takes 480 ms at 16 KiB, 1,691 ms at 32 KiB and 6,348 ms at 64 KiB (about 3.7× per doubling). `hr-run` (`* *` repeated) behaves the same way. Plain CommonMark micromark (no extensions) times out on `block-pipe`, `hr-run` and `emphasis-run` at 128 KiB too, so the cost is not in the GFM extensions. This contradicts "linear by design" for micromark 4.0.3.

`Bun.markdown` is linear on the families that stress every other engine:

| Family | 16 KiB | 32 KiB | 64 KiB | 128 KiB |
|---|---|---|---|---|
| `block-pipe` | 0.4 ms | 0.7 ms | 1.4 ms | 2.8 ms |
| `hr-run` | 0.7 ms | 1.3 ms | 2.7 ms | 5.4 ms |
| `emphasis-run` | 0.3 ms | 0.5 ms | 1.0 ms | 2.3 ms |
| `link-open` | 1.2 ms | 2.5 ms | 5.0 ms | 10 ms |

The reviewer's 128 KiB whitespace-tail shape takes under 20 ms, against 2,451 ms served on today's marked. Every 7–20 KiB ordinary line list from the r3 review renders on all four candidates: none is refused, while today's marked refuses 11 of the 18 list documents. A compiled executable renders `ws-tail-tab` in 0.3 ms and `hr-run` in 5.5 ms.

Bun's `hr-run` at 128 KiB produces 1,048,587 bytes, just over the 1 MiB output limit. The output of these shapes runs to about 8× the source, so a bound on output must be checked as the output is built, not after it. See the output-bound section below.

## Output differences

Corpus: 33 B104 pins, the B105 newsletters at 4, 16 and 64 KiB, 18 reconstructed 7–20 KiB line lists, all 64 families at 1 KiB, and 2000 seeded random documents, each joining 3 to 40 fragments from a fixed list of Markdown constructs. "Canonical" folds entity and typographic variants, drops heading ids, sorts attributes, and normalises checkbox markup and `<s>`/`<strike>` to `<del>`. Byte-level differences are reported too, but nearly every random document differs byte-wise, so they are not useful evidence.

Differences against **today** (canonical, documents where the output changed; "agrees" means goldmark gives the same output as the candidate):

| Candidate | Pins (33) | Newsletters (3) | Line lists (18) | Families at 1 KiB (64) | Random (2000) | Total changed | Of which goldmark agrees | Of which neither agrees |
|---|---|---|---|---|---|---|---|---|
| `Bun.markdown` | 5 | 3 | 7 | 12 | 1668 | 1695 | 1137 | 558 |
| micromark | 5 | 3 | 7 | 12 | 1675 | 1702 | 1186 | 516 |
| markdown-it | 5 | 3 | 7 | 12 | 1697 | 1724 | 979 | 745 |

Differences against **goldmark** (canonical, documents where the output differs), and today's count for comparison:

| Engine | Pins | Newsletters | Line lists | Families at 1 KiB | Random (2000) | Total of 2118 |
|---|---|---|---|---|---|---|
| today (marked, raw) | 5 | 3 | 7 | 12 | 1693 | 1720 |
| `Bun.markdown` | 0 | 0 | 0 | 0 | 583 | 583 |
| micromark | 0 | 0 | 0 | 0 | 540 | 540 |
| markdown-it | 0 | 0 | 0 | 0 | 769 | 769 |

On the pins, newsletters, line lists and 1 KiB families, today's marked differs from goldmark in 27 documents and no candidate does. The random differences are the open part. A sample of `Bun.markdown` differences showed two kinds: a task-list checkbox placed outside the paragraph in a loose list item (`<li>[x]<p>done</p>` against goldmark's `<li><p>[x]done</p>`), and a table whose header and delimiter row differ in cell count, which goldmark still builds as a table. Each random document carries about 20 constructs, so per-document attribution does not isolate causes. Phase 2 will minimise these into single-construct cases before the pins change.

### One construct per document (60 constructs, each rendered alone)

| Engine | Differs from goldmark on | Differs from today on |
|---|---|---|
| today (marked, raw) | 9: `[x](<u>"t")` (D111), `https://bare.test`, `www.bare.test`, `- ` (an empty item), a table with mismatched header cells, `&amp; &copy; &#35;`, `a  \nb`, `a\\\nb`, `x  \n` | not applicable |
| `Bun.markdown` | 2: `[x](<u>"t")` (D111, kept), a table with mismatched header cells (goldmark builds it, GFM does not) | 7: `https://bare.test`, `www.bare.test`, `- ` (empty item), `&amp; &copy; &#35;`, `a  \nb`, `a\\\nb`, `x  \n` |
| micromark | 2: as Bun.markdown | 7: as Bun.markdown |
| markdown-it | 4: as Bun.markdown, plus `~tilde~` (single-tilde strikethrough) and ```` ```\n~~~ ```` | 9 |

Every change from today on a single construct is either CommonMark or GFM correct, or matches listmonk's goldmark output. The two differences that remain from goldmark are D111's glued-title rule, which stays deliberate, and goldmark's table quirk, which the GFM rule does not allow.

## GFM features our options need

Today's `gfm: true` gives tables, strikethrough, task-list items and bare-URL autolinks. Against listmonk's goldmark options:

- **Tables:** needed. All three candidates match goldmark on the pins and newsletters.
- **Strikethrough, `~~x~~` and `~x~`:** needed. Today and goldmark both strike single tildes. `Bun.markdown` and micromark do too; markdown-it strikes only `~~`.
- **Task-list items:** needed. `Bun.markdown` and micromark produce them. markdown-it has no task-list rule here. The checkbox sits inside a loose item's paragraph differently from goldmark, which is cosmetic.
- **Bare-URL autolinks:** not needed for parity. Goldmark does not linkify, and `Bun.markdown` (default off) and the other candidates do not either. Today links `https://bare.test`. Dropping autolinks is a visible change for senders who rely on bare URLs in campaigns, so the lead should accept it explicitly. It matches listmonk.
- **Heading ids (`WithAutoHeadingID`):** not in today's output and not in the candidates' defaults. `Bun.markdown` has a `headingIds` option. Parity would need it; today has none, so it is a lead decision, not a parity fix.
- **Typographer:** goldmark's apostrophe and dash substitutions are not in today's output or the candidates. Not needed.

## Output bound and the reserve

`Bun.markdown.html(src)` returns one string, so a bound checked before the output exists is not available from it. `Bun.markdown.render(src, callbacks)` calls back per element (`text`, `heading`, `paragraph`, `emphasis`, `link`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, and others), so the output can be charged as each element is produced, which is how D112's budget charges today's tokens. Phase 2 has to confirm that the callbacks reproduce `html()`'s output (not checked here) and that every element has a callback. The output limit then holds before the string is built. Without callbacks, the bound is the post-render check and a measured ratio, which is weaker than D112's true `reserve()`.

## Things I did not check

- I read `Bun.markdown`'s option names from the runtime binary and tested them by behaviour. I did not read Bun's documentation or changelog, so I cannot say whether the API is stable or marked experimental. Phase 2 must check this before the pin.
- Linearity is measured, not documented. The timing shows no quadratic growth on any family I tried, but it is not a guarantee in Bun's sources, and the implementation is not confirmed.
- The CommonMark normaliser is approximate. The figures compare the engines with each other.
- The random corpus is not minimised; its differences are sampled, not attributed.
- The reviewer's exact line-list shapes were rebuilt from the review text, not copied from the PR.

## Lead decisions needed before phase 2

1. Accept `Bun.markdown` as the parser, with no dependency. That removes `marked` and its patch, and changes D113's candidate list, since no runtime dependency is added.
2. Accept that micromark is not used, because it is quadratic on families measured here (the measurements are in this note).
3. Decide bare-URL autolinks: off matches listmonk and goldmark (recommended); on keeps today's visible behaviour.
4. Decide heading ids: off keeps today's output; on matches listmonk's `WithAutoHeadingID`.
5. Accept the output-bound approach: charge through `render` callbacks if they reproduce `html()`, otherwise a measured ratio with the post-render check.

Commands and checks: the probe (adapters, timing, comparison, goldmark reference, one-construct catalogue) ran inside `oven/bun:1.4.5`; goldmark ran on the host. No test suite ran, because this change adds no code.
