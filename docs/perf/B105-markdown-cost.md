# B105: Markdown cost model, before and after

Decision: [D112](../design/09-decisions.md#d112-markdown-cost-is-charged-in-characters-marked-scans-and-the-output-reserve-is-a-linear-upper-bound-lead-2026-11-19). Brief: [B105](../briefs/B105.md). Earlier notes: [B104](B104-markdown.md) (the link-title scan), [B103](B103-render-deadline.md) (the Liquid deadline, removed by D110).

## Method

- **Host.** The owner's macOS workstation (Apple silicon, Bun 1.4.4), used for the timing study, with the load noted per run. These are not the acceptance numbers; the Linux arm64 container runs are the acceptance evidence (see the PR). Host load stayed between 1.5 and 3 during the runs.
- **Renderer, 60 KiB, origin and head.** Each family and reviewer shape (`measure-markdown.ts`'s families, the B104 review's block shapes and the reference shape with a definition) renders as a template body (60 KiB, under the template source limit) through `createRenderer().render` with `mode: "markdown"`, the path previews and sends use. One child process per case, 15 s cap, `origin/main` in an export of its tree and head in the working tree.
- **Production path, 1 MiB.** `renderMarkdown` with the production budget (`createMarkdownBudget`): the 1 MiB output limit for every family and definition variant, one child process per case. A body is at most 64 KiB, so these inputs are what a Liquid loop expands to (see the review section).
- **Sweeps.** Every repeating unit of up to three characters over the 28-character alphabet `[]()!`*_<>"'~|:\ \n&#-.@w+=` (22,764 units; `measure-markdown.ts --enum 64 3` covers this method with its own alphabet); every unit of up to four characters over the 14 literal characters `|`-\n[]()*_> #` (41,370 units, `ENUM_ALPHABET` with `--enum 64 4`); and 3,000 random units of 1 to 8 characters over the 28-character alphabet. Each renders 64 KiB through the production budget. The random and fragment runs were scratch scripts and are not committed.
- **Newsletters.** `test/templates/markdown-newsletter.ts`, one story per 1.2 KiB and every block kind an adapter sends, rendered as Markdown bodies through the render path previews use (at most 64 KiB, D54). Medians of 7 renders, as `measure-markdown.ts --news`.

## Before and after: the pathological shapes at 60 KiB

Origin is `origin/main` through its own renderer. The times are the renderer's time to answer, including the refusal. Every case refuses on both (`Render limit` or `Work limit`, or `200` for the ones that are ordinary).

| Case (60 KiB) | origin/main | head |
|---|---:|---:|
| `\|\n-\n` (block pipe) | 2381 ms, `Render limit` | 21 ms, `Work limit` |
| `\|\n-\n` with a definition in front | 2328 ms, `Render limit` | 21 ms, `Work limit` |
| ` \|\n-\n` | 2118 ms, `Render limit` | 26 ms, `Work limit` |
| `<\n-\n` | 1462 ms, `Render limit` | 17 ms, `Work limit` |
| `_\n-\n` | 1066 ms, `Render limit` | 16 ms, `Work limit` |
| `a\n-\n` (setext run) | 1040 ms, `Render limit` | 16 ms, `Work limit` |
| `` `\n-\n `` | 1038 ms, `Render limit` | 16 ms, `Work limit` |
| `[\n-\n` | 1038 ms, `Render limit` | 17 ms, `Work limit` |
| `a\n--\n` | 863 ms, `Render limit` | 21 ms, `Work limit` |
| `--\n` | 746 ms, `Render limit` | 25 ms, `Work limit` |
| `a\n***\n` (rule run) | 982 ms, `Work limit` | 133 ms, `Work limit` |
| `>=\n` (quote run) | 13 ms, `Work limit` | 28 ms, `Work limit` |
| `[](` (empty link) | 67 ms, `Work limit` | 28 ms, `Work limit` |
| `![](` | 68 ms, `Work limit` | 28 ms, `Work limit` |
| `w ~` (strikethrough) | 79 ms, `Work limit` | 11 ms, `Work limit` |

The largest origin time is 2381 ms and the largest head time is 133 ms, over 132 cases with definitions and without. Head's slowest case is the rule run (133 ms); the next slowest is 28 ms.

## Production path at 1 MiB (head)

114 runs (57 families, each with and without a definition), each 1 MiB through `renderMarkdown` with the production budget:

- 106 refused by the work limit, 4 by the output bound, 4 rendered in 4 ms or less (backtick runs and HTML comments, whose inline output is one raw run);
- slowest refusal: `~` runs 109 ms; `a\n***\n` 87 ms; `_` and `*` emphasis runs 73 and 68 ms; `[` links 37 to 39 ms;
- origin's lexer took 38 s on `[](` at 8 KiB (B104 note), before any budget refused it;

## Sweeps and fuzz (head, 64 KiB, production budget)

| Sweep | Cases | Slowest | Over 100 ms | Refused |
|---|---:|---:|---:|---:|
| Every unit up to 3 characters, 28-character alphabet | 22,764 | 47 ms | 0 | 10,975 |
| Every unit up to 4 characters, 14 literal characters | 41,370 | 30 ms | 0 | 27,778 |
| 3,000 random units of 1 to 8 characters, 28-character alphabet | 3,000 | 33 ms | 0 | 1,677 |
| 200 random fragment documents (60 Markdown fragments) | 200 | 18 ms | 0 | 0 |
| 20 random fragment documents at 1 MiB | 20 | 23 ms | 0 | 20 |

The first sweep (3 characters, 8 KiB, unbudgeted, run before the changes on a lexer that already had the table gate, which is equivalent to origin's) found 59 units over 60 ms, the slowest `" *("` at 615 ms. 49 of them contain `*` or `_` (emphasis openers, which the changes address); the other 10 contain `~` and take 61 ms.

## Newsletters

| Size | Source bytes | Stories | Output bytes | Median render | Work units |
|---|---:|---:|---:|---:|---:|
| 1 KiB | 911 | 1 | 1,045 | 0.4 ms | 0.1 M |
| 4 KiB | 3,794 | 5 | 5,182 | 0.8 ms | 0.4 M |
| 16 KiB | 15,683 | 21 | 22,282 | 2.0 ms | 1.5 M |
| 64 KiB | 64,817 | 87 | 92,759 | 6.7 ms | 7.1 M of 36 M |

Origin refuses the same generator from 5 KiB of source (6 stories, 4,563 bytes, `Render limit`) through its renderer, so origin/main could not send a newsletter of that length. Head renders each size listed above through preview, test send and a campaign send to two subscribers (`test/campaigns/markdown-newsletter.test.ts`).

At 64 KiB the newsletter uses 16% of the work budget. A Liquid loop can expand a body to the 1 MiB output limit; the review section below measures those expansions.

## Output identity

- The 33 B104 documents (`test/templates/markdown-compat.test.ts`) are unchanged.
- 4,500 seeded random documents (three seeds, 1 to 14 fragments each, 60 fragments including tables, loose and task lists, images, references and the review's shapes) through origin's production path (its markdown, its marked patch, its 4 MiB and 10,000-step budget) and through head: origin accepts all 4,500, and head's output is byte-identical on all of them.
- Earlier, 111 cases compared with origin's production path (its reserve included): 67 accepted by both, identical; no document origin accepts is refused now. Head accepts 37 that origin refuses (for example a 12,000-cell table). Three emphasis cases that origin's raw lexer accepts at 2 KiB are refused by head, and origin's production path refuses them too.

## Review of e6fbe3d (PR #157, CHANGES)

The review found four things. Each is measured here on this host (Apple silicon, Bun 1.4.5, load 2 to 4); the container numbers are in the PR comment.

**1. The fence-like tilde run.** The `~{3,}[^\n]*\n` alternative in marked's paragraph, table and paragraph-stop lookaheads backtracked through a tilde run ending a paragraph, quadratically. It is now `~{3}[^\n]*\n`, which matches the same lines:

| Input (64 KiB) | e6fbe3d | this change |
|---|---:|---:|
| `x\n` then a tilde run | 1,536 ms | 8 ms |
| Liquid loop expanding a 1 KiB body to 64 KiB of tildes | (review: 1,570 ms) | 4 ms |
| Liquid loop expanding to 1000 KiB of tildes | (review: minutes, projected) | 14 ms, refused by the work limit |

The audit of marker runs (`markdown-runs.test.ts`: 13 markers, at the end of a paragraph, list item, blockquote and table row, with and without a newline, 64 KiB each) found one more quadratic shape: a quote run (`>=` lines) at 1 MiB. marked's blockquote pattern returns no match from about 640 KiB on, so the lexer falls through to a two-character paragraph and repeats the failed scan over the rest of the input, for ever (raw marked hangs past 120 s at 1 MiB). The blockquote attempt is now charged its window to the next blank line at 16 units per character, which bounds it: the same input is refused in 146 ms.

The Liquid audit (`markdown-liquid.test.ts` and the measurement below) runs each marker in the four contexts and each shape from the B104 review at about 1000 KiB of Markdown, through the renderer's preview path: 138 cases, every one renders or is refused, the slowest in 169 ms on this host (`_` at the end of a paragraph, refused by the work limit). That run used the emphasis weights of the first r1 commit (600 per closer exec, 8 per character); the container measurement that followed slowed the emphasis cases to 332 ms, so the weights were raised to 1500 and 12 (D112), and the container numbers are in the PR comment. The remaining time was one closer-search exec that scans the rest of the paragraph and was charged only after it returned; an opener now charges that remaining length before the search runs.

**2. `reserve()` is now an upper bound.** Three outputs were not reserved: a block text token in a loose item (written as a paragraph, 8 bytes), a task item's checkbox (written after the reserve, 47 bytes plus a space), and image alternative text (the text renderer can print escaped text twice). Each is reserved now. Measured actual against reserved, with the last charge as the reserve:

| Case | Actual / reserved (e6fbe3d) | this change |
|---|---:|---:|
| loose items, `"- a\n\n  b\n\n"` × 1500 | 8.9× at 12,000 (review) | 0.82 |
| checked loose items × 500 | not reserved | 0.82 |
| tight task items × 2000 | +1 byte per item (review) | 0.66 |
| image alt text with escapes × 500 | about 2× (review) | 0.18 |

`markdown-reserve.test.ts` asserts actual ≤ reserved over the reviewer's shapes, 30 constructs (each repeated 1, 8 and 40 times) and a seeded random corpus of 600 documents. A separate seeded check on 10,000 random documents from five seeds found no violation.

**3. Byte identity.** The pins (33 B104 documents, plus 4, 16 and 64 KiB newsletters) are unchanged. The random comparison above (4,500 documents against origin's production path) is identical.

**4. Campaign body limit.** Reverted to 64 KiB (the lead's decision). The newsletter tests now cover 4, 16 and 64 KiB; `campaigns.test.ts` again refuses a 70 KiB body.

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

- Timings are single runs or medians on a shared workstation (load 1.5 to 3).
- The work units approximate time: about 5 ns each (`WORK_LIMIT`, `markdown.ts`), and a few sites were weighted from measured regex costs (lazy heading scan 64, emphasis 8 and 600, the e-mail run 3). The measured worst case is 133 ms (`a\n***\n` at 60 KiB) against the 200 ms target.
