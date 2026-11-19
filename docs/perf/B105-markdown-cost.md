# B105: Markdown cost model, before and after

Decision: [D112](../design/09-decisions.md#d112-markdown-cost-is-charged-in-characters-marked-scans-the-output-reserve-is-linear-and-campaign-bodies-may-be-256-kib-lead-2026-11-19). Brief: [B105](../briefs/B105.md). Earlier notes: [B104](B104-markdown.md) (the link-title scan), [B103](B103-render-deadline.md) (the Liquid deadline, removed by D110).

## Method

- **Host.** The owner's macOS workstation (Apple silicon, Bun 1.4.4), used for the timing study, with the load noted per run. These are not the acceptance numbers; the Linux arm64 container runs are the acceptance evidence (see the PR). Host load stayed between 1.5 and 3 during the runs.
- **Renderer, 60 KiB, origin and head.** Each family and reviewer shape (`measure-markdown.ts`'s families, the B104 review's block shapes and the reference shape with a definition) renders as a template body (60 KiB, under the template source limit) through `createRenderer().render` with `mode: "markdown"`, the path previews and sends use. One child process per case, 15 s cap, `origin/main` in an export of its tree and head in the working tree.
- **Production path, 1 MiB.** `renderMarkdown` with the production budget (`createMarkdownBudget`): the 1 MiB campaign limit for every family and definition variant, one child process per case.
- **Sweeps.** Every repeating unit of up to three characters over the 28-character alphabet `[]()!`*_<>"'~|:\ \n&#-.@w+=` (22,764 units; `measure-markdown.ts --enum 64 3` covers this method with its own alphabet); every unit of up to four characters over the 14 literal characters `|`-\n[]()*_> #` (41,370 units, `ENUM_ALPHABET` with `--enum 64 4`); and 3,000 random units of 1 to 8 characters over the 28-character alphabet. Each renders 64 KiB through the production budget. The random and fragment runs were scratch scripts and are not committed.
- **Newsletters.** `test/templates/markdown-newsletter.ts`, one story per 1.2 KiB and every block kind an adapter sends, rendered as campaign bodies (`compile({ campaign: true })`, the path campaigns use). Medians of 7 renders, as `measure-markdown.ts --news`.

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

| Size | Source bytes | Stories | Output bytes | Median render (campaign path) | Work units |
|---|---:|---:|---:|---:|---:|
| 1 KiB | 911 | 1 | 1,045 | 0.4 ms | 0.1 M |
| 4 KiB | 3,794 | 5 | 5,182 | 0.8 ms | 0.4 M |
| 16 KiB | 15,683 | 21 | 22,282 | 2.0 ms | 1.5 M |
| 64 KiB | 64,817 | 87 | 92,759 | 6.7 ms | 6.2 M |
| 256 KiB | 261,749 | 347 | 374,608 | 23.3 ms | 24.6 M of 40 M |

Origin refuses the same generator from 5 KiB of source (6 stories, 4,563 bytes, `Render limit`) through its renderer, so origin/main could not send a newsletter of that length. Head renders each size listed above through preview, test send and a campaign send to two subscribers (`test/campaigns/markdown-newsletter.test.ts`).

The work limit leaves 256 KiB at 61% of its budget and refuses at about 512 KiB of this shape, where the output would still be about 750 KB, under the 1 MiB output bound. That is a deliberate margin: the limit is about 200 ms of work, and the newsletter at 256 KiB takes 23 ms.

## Output identity

- The 33 B104 documents (`test/templates/markdown-compat.test.ts`) are unchanged.
- 3,000 random documents built from 60 Markdown fragments, and 39 family and newsletter cases at 1 to 4 KiB, compared with origin's marked without its reserve: identical wherever both render. Three emphasis cases that origin's raw lexer accepts at 2 KiB (emphasis pairs, underscore pairs, strong openers) are refused by head, and origin's production path refuses them too.
- 111 cases compared with origin's production path (its reserve included): 67 accepted by both, identical; no document origin accepts is refused now. Head accepts 37 that origin refuses (for example a 12,000-cell table).

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
