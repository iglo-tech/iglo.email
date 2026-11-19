# B104: Markdown link scanning, before and after

Decision: [D111](../design/09-decisions.md#d111-link-titles-must-follow-whitespace-so-the-inline-link-title-scan-is-linear-per-link-attempt-lead-2026-11-19). Brief: [B104](../briefs/B104.md).

## Method

Host: the owner's macOS workstation (Apple silicon, Bun 1.4.4), not the Linux container; this is a timing study, and the container runs are the acceptance evidence. Load average was 1.1–2.4 during the runs.

- Family table: `bun test/templates/measure-markdown.ts`. Each family repeats its unit to the size, renders it through the production renderer (`renderer.render`, mode `markdown`: the path preview and send use), and times each size in its own child process with an 8 s cap. A series stops at its first cap. `error …` is the refusal the budget gives, not a crash.
- Enumeration: `bun test/templates/measure-markdown.ts --enum <KiB> <length>` renders every repeating unit of up to `<length>` characters over the punctuation alphabet (14,424 units for length 3, 11,110 for length 4 over a 10-character alphabet) and prints each unit over 100 ms. It flags the origin defect (on origin, `[](`, `]([` and `([]` take about 640 ms at 2 KiB); it is the search used to find the families, since a random search did not reproduce the defect.
- Ordinary render: `bun test/templates/measure-markdown.ts --normal <KiB> <runs>`, the median of 200 renders of a newsletter-shaped body.

## Results

### Pathological families (time through the renderer)

Origin/main is `marked@15.0.12` with the pinned budget patch as it was; "after" is this branch. The family series stops at its first time over 8 s.

| Family | Before 4 KiB | Before 8 KiB | Before 64 KiB | After 4 KiB | After 8 KiB | After 64 KiB |
|---|---:|---:|---:|---:|---:|---:|
| `link-empty` | 5441 ms refused | > 8 s (stopped) | - | 19 ms refused | 39 ms refused | 68 ms refused |
| `link-open` | 3026 ms refused | > 8 s (stopped) | - | 16 ms refused | 22 ms refused | 47 ms refused |
| `link-href` | 1954 ms refused | > 8 s (stopped) | - | 15 ms refused | 23 ms refused | 47 ms refused |
| `link-title` | 8 ms refused | 9 ms refused | 26 ms refused | 8 ms refused | 9 ms refused | 27 ms refused |
| `link-title-single` | 8 ms refused | 9 ms refused | 26 ms refused | 8 ms refused | 9 ms refused | 27 ms refused |
| `link-angle` | 2056 ms refused | > 8 s (stopped) | - | 14 ms refused | 17 ms refused | 40 ms refused |
| `link-spaced` | 16 ms refused | 26 ms refused | 1001 ms refused | 10 ms refused | 8 ms refused | 27 ms refused |
| `link-glued-quote` | 1378 ms refused | > 8 s (stopped) | - | 14 ms refused | 23 ms refused | 46 ms refused |
| `link-glued-paren` | 2729 ms refused | > 8 s (stopped) | - | 14 ms refused | 24 ms refused | 47 ms refused |
| `image-empty` | 6010 ms refused | > 8 s (stopped) | - | 25 ms refused | 38 ms refused | 67 ms refused |
| `bracket-open` | 8 ms refused | 7 ms refused | 25 ms refused | 9 ms refused | 7 ms refused | 26 ms refused |
| `bracket-nested` | 8 ms refused | 9 ms refused | 25 ms refused | 9 ms refused | 9 ms refused | 26 ms refused |
| `bracket-close` | 5 ms | 6 ms | 25 ms | 5 ms | 6 ms | 26 ms |
| `reflink-open` | 8 ms refused | 7 ms refused | 25 ms refused | 9 ms refused | 7 ms refused | 27 ms refused |
| `reflink-empty` | 9 ms refused | 7 ms refused | 25 ms refused | 8 ms refused | 7 ms refused | 26 ms refused |
| `reflink-defined` | 8 ms refused | 7 ms refused | 25 ms refused | 9 ms refused | 7 ms refused | 26 ms refused |
| `reflink-def` | 5 ms | 6 ms refused | 6 ms refused | 5 ms | 6 ms refused | 6 ms refused |
| `emphasis-star` | 3 ms | 4 ms | 5 ms | 4 ms | 4 ms | 5 ms |
| `emphasis-under` | 3 ms | 4 ms | 5 ms | 4 ms | 4 ms | 5 ms |
| `emphasis-pairs` | 6 ms refused | 6 ms refused | 27 ms refused | 6 ms refused | 6 ms refused | 28 ms refused |
| `emphasis-under-pairs` | 6 ms refused | 7 ms refused | 26 ms refused | 6 ms refused | 7 ms refused | 27 ms refused |
| `strong-open` | 7 ms refused | 6 ms refused | 25 ms refused | 6 ms refused | 6 ms refused | 27 ms refused |
| `backtick` | 3 ms | 4 ms | 5 ms | 3 ms | 4 ms | 5 ms |
| `backtick-run` | 9 ms refused | 7 ms refused | 26 ms refused | 9 ms refused | 8 ms refused | 27 ms refused |
| `autolink-open` | 8 ms refused | 7 ms refused | 25 ms refused | 9 ms refused | 7 ms refused | 27 ms refused |
| `autolink-tag` | 8 ms refused | 9 ms refused | 25 ms refused | 9 ms refused | 9 ms refused | 27 ms refused |
| `autolink-url` | 7 ms refused | 7 ms refused | 25 ms refused | 7 ms refused | 7 ms refused | 27 ms refused |
| `autolink-mail` | 8 ms refused | 8 ms refused | 25 ms refused | 9 ms refused | 9 ms refused | 27 ms refused |
| `html-comment` | 4 ms | 4 ms | 6 ms | 4 ms | 4 ms | 6 ms |
| `html-tag` | 8 ms | 9 ms refused | 25 ms refused | 9 ms | 9 ms refused | 27 ms refused |
| `escape` | 7 ms refused | 7 ms refused | 26 ms refused | 8 ms refused | 7 ms refused | 26 ms refused |
| `paren-open` | 5 ms | 6 ms | 25 ms | 5 ms | 6 ms | 26 ms |
| `link-valid` | 9 ms refused | 7 ms refused | 26 ms refused | 10 ms refused | 8 ms refused | 29 ms refused |
| `table-row` | 6 ms | 6 ms | 42 ms | 6 ms | 6 ms | 44 ms |
| `blockquote` | 8 ms refused | 9 ms refused | 25 ms refused | 9 ms refused | 9 ms refused | 27 ms refused |
| `list-link` | 8 ms refused | 8 ms refused | 25 ms refused | 8 ms refused | 9 ms refused | 28 ms refused |

Every family at 64 KiB is at most 68 ms after the fix (`link-empty`, `image-empty`), and every 8 KiB `[](` request is refused in 39 ms (origin: 37.5 s in the HTTP test, 38.6 s in the B103 review).

### Enumeration

| Run | Units | Slowest after | Slowest before |
|---|---:|---:|---:|
| 3 characters, 2 KiB | 14,424 | 8.9 ms | 642 ms (`[](`, `]([`, `([]`) |
| 3 characters, 16 KiB | 14,424 | 64.6 ms | not run (origin takes minutes per unit) |
| 4 characters, 10-symbol alphabet, 8 KiB | 11,110 | 36.5 ms | not run |
| 3 characters, 64 KiB | 14,424 | 682 ms (`--\n`, `-\n-`, `\n--`) | not run |

The 64 KiB row is the block-level finding below: those units are not inline links, and they are bounded by the budget but not linear.

### Ordinary campaign render (no regression)

| Body | Before (origin) | After |
|---|---:|---:|
| newsletter, 1 KiB, median of 200 | 0.20 ms | 0.19 ms |
| newsletter, 2 KiB, median of 200 | 0.29 ms | 0.30 ms |
| newsletter, 4 KiB | refused (`Render limit`) | refused (`Render limit`) |

Ordinary output is pinned by `test/templates/markdown-compat.test.ts`: 33 documents, SHA-256 and byte length of the HTML recorded on origin/main, all unchanged.

### Content conversion (`convertContent`, 10× work budget)

`content.ts` allows 100,000 work steps, so its worst case is about ten times the renderer's. Measured on this host for direct `convertContent` calls:

| Input | 16 KiB | 64 KiB | 256 KiB | 1 MiB |
|---|---:|---:|---:|---:|
| `[](` | 79 ms, `Markdown limit` | 326 ms, `Markdown limit` | 462 ms, `Work limit` | 468 ms, `Work limit` |
| `--\n` | 82 ms, `Markdown limit` | 735 ms, `Markdown limit` | 708 ms, `Markdown limit` | 252 ms, `Markdown limit` |
| `a\n-` | 10 ms, ok | 46 ms, ok | 1,933 ms, `Markdown limit` | 385 ms, `Markdown limit` |

Every case refuses or succeeds within the budget, and none is clock-dependent. The worst (about 2 s) is a 256 KiB body of setext headings (`a\n-`), which the conversion path accepts because it has no 64 KiB source limit. That is the existing budget, not changed here.

## Scope and what is not fixed

B104 bounds the inline link-title scan only (D111). The numbers above show that scan linear per attempt, and the enumeration rows show it bounded for every unit tried. Three costs predate this branch and are not changed here; they are tracked in B105/D112:

- **Block-level repetitions** (`--` lines, setext underlines and rules) rescan the remaining input per block token inside marked's paragraph rule. Unbudgeted, `--\n` at 64 KiB takes 56 s; the budget then stopped it at about 0.7 s per 64 KiB request on this host. In the Linux arm64 container the block shapes took 1.2 to 4.1 s per request on origin/main (`|\n-\n` at 16 KiB: 4.05 s, PR #156 review), so the figure above is the macOS number, not the worst case. B105 removes the quadratic cost (see [B105](B105-markdown-cost.md)). marked 17.0.6 and 18.2.1 take 31–35 s on `--\n` at 64 KiB.
- **The reflink scan** (`reflinkSearch`) runs once per inline text, outside the per-token charge.
- **Ordinary bodies of about 4 KiB are refused** by the D54 reservation (`reserve()` in `src/templates/markdown.ts`), a documented conservative estimate that this branch does not change.

Nothing here shows that Markdown is bounded overall.
