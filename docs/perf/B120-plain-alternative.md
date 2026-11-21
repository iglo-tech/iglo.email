# B120: generated text part, cost per message

Decision: [D118](../design/09-decisions.md#d118-mail-without-an-alt-body-gets-a-generated-text-part-lead-2026-11-20). Sending changes, so the cost is measured before and after on the same host and the same script: `test/messaging/measure-plain-alternative.ts`.

## Setup

- Host: macOS arm64 workstation, Bun 1.4.5, in-process transactional fixture with a loopback SMTP sink (no network, no real server).
- Message: a realistic newsletter of 47,280 bytes of HTML (hidden preheader with 90 padding runs, a header, a hero, 56 story blocks with two links and an image each, a footer with the manage link). It is close to the 64 KiB template cap.
- Before: `origin/main` at the start of B120 (`ab46744`), archived with `git archive` and run with the same script. The converter is absent there.
- After: this branch. Each figure is the median of the runs shown; the send figure is 150 sends per run.

## Results

| Measure | Before (HTML only) | After (multipart/alternative) | Change |
| --- | --- | --- | --- |
| Tx send, request to SMTP sink (median, 2 runs each) | 4.02 ms, 4.33 ms; 4.24 ms | 5.93 ms, 5.66 ms, 5.65 ms | about +1.5 ms per message |
| Wire message, last send | 51,580 bytes | 74,231 bytes | +22,651 bytes |
| Converter, 47 KB newsletter (median of 300) | not run | 0.61 ms | |
| Generated text | none | 21,077 bytes (44.6% of the HTML) | |
| Converter, about 0.99 MiB HTML (once) | not run | 15.5 ms; text 463,736 bytes | |

The send cost is the converter (0.6 ms) plus the larger outbox payload (the text part is stored with the send, so the journal row is bigger) and the second MIME part that nodemailer encodes. The wire growth is the text part itself, quoted-printable encoded.

## Bounds

- Time is linear for flat markup: 47 KB takes 0.61 ms and 0.99 MiB takes 15.5 ms, the same per-byte rate. Every pass after the one HTMLRewriter stream is a linear scan of the collected text, and no regular expression is quadratic on its input.
- One cap bounds nesting and omitted end tags alike. Bun's rewriter keeps an end-tag handler for every element until its end tag fires, and it charges each end tag for the handlers still pending, so the cost of a stack of N elements grows with N squared. The converter counts the handlers it holds (registered minus fired: every open element, and every element whose end tag was implied and never fired) and stops at 1024 (`HELD_CAP`, D118). Past the cap the conversion stops, and the message sends without a text part. Before the cap, the r2 review measured 150k nested `<b>` (1 MiB) at 5.7 s in the converter.

  Measured in the container (`bun test/messaging/measure-plain-nesting.ts`, median of 5 runs per size). The ratio is the 1 MiB time over the 256 KiB time, floored at 5 ms. Two runs of the script agree within 4 ms on every row; the tables show the second run.

  | Kind | 256 KiB | 1 MiB | Ratio | 1 MiB result |
  | --- | --- | --- | --- | --- |
  | `b` | 0.5 ms | 0.5 ms | 0.10 | no text part |
  | `div` | 0.7 ms | 0.6 ms | 0.12 | no text part |
  | `a` | 1.4 ms | 0.8 ms | 0.17 | no text part |
  | `li` | 1.0 ms | 0.7 ms | 0.14 | no text part |
  | `td` | 0.8 ms | 0.8 ms | 0.17 | no text part |

  The nested shapes pass the cap within the first few kilobytes, so both sizes take about a millisecond. A valid message nested deeper than 1024 elements now sends without a text part, which is the cost of the bound.

- Omitted end tags leave Bun's end-tag handlers pending, and the stack does not show them: `<p>x<b>y</b>` repeated leaves one held handler per `<p>` until an ancestor ends. The r3 review measured a ratio of about 12 for these shapes before the held count existed. A stray end tag such as `</q>` does not close an open `span`, so `<span>x</q>` repeated also holds one handler per span. Each shape below takes milliseconds at either size and sends no text part at 1 MiB.

  | Shape | 256 KiB | 1 MiB | Ratio |
  | --- | --- | --- | --- |
  | unclosed `p` | 2.8 ms | 2.3 ms | 0.46 |
  | unclosed `li` | 2.6 ms | 3.6 ms | 0.71 |
  | unclosed `td` | 2.6 ms | 2.3 ms | 0.47 |
  | unclosed tr cell | 1.4 ms | 1.4 ms | 0.29 |
  | unclosed `dd` | 2.2 ms | 2.2 ms | 0.43 |
  | unclosed `option` | 2.4 ms | 2.6 ms | 0.51 |
  | open `span`, stray `</q>` | 1.8 ms | 1.7 ms | 0.33 |
  | 256 `div`, then stray `</q>` | 1.8 ms | 2.0 ms | 0.41 |

  The tests check each held shape at 4x the input within 5x the time (`test/messaging/plain-review.test.ts`), a 12 KB unclosed-`<p>` template through HTTP leaves `/health` answering within 200 ms, and an 11 KB template of unclosed spans with stray end tags does the same (`test/messaging/plain-executable.test.ts`).

- The worst shape the cap allows is 1023 open elements, the largest count under 1024, followed by stray end tags to 1 MiB. Each stray end tag pays for all 1023 held handlers. It took 370 ms and 368 ms in two runs, against 131 ms and 135 ms for flat `<b>t</b>` markup of the same size (about 2.8 times the flat cost), and its text part is kept (209,715 characters):

  | Shape | 256 KiB | 1 MiB | Ratio | 1 MiB result |
  | --- | --- | --- | --- | --- |
  | 1023 open, stray `</q>` | 92.7 ms | 369.9 ms | 3.99 | text 209,715 chars |
  | flat `<b>t</b>` (baseline) | 32.9 ms | 130.9 ms | 3.98 | text 149,796 chars |

  The test bounds it under 1 s (`test/messaging/plain-review.test.ts`, the worst linear case), and a 1 MiB nested-markup test checks that every nested shape at 1 MiB is under 1 s with no text part past the cap. The timing script prints the worst shape beside the flat baseline.
- Size: the output is never longer than the input in bytes. It is charged to the message budget, which every part of the message shares, and the stored text is bounded by the existing 1 MiB per-body limit in `src/messaging/payload.ts`.
- The 8 MiB payload bound is unchanged and now includes the text part (see D118, Known edges).

The send-rate tests (B37, `test/messaging/send-rate.test.ts`) are changed in their own commit: tests 1 and 7b drive the injected clock in 10 ms steps, and tests 1b and 7b wait for the campaign delivery rows as well as the sink count, because a 50 ms step quantized the receipt times they read and the sink can hold a message before its row is written; the cap itself is unchanged. Sink receipts also carry each send's own latency, so the rolling one-per-second check at the sink is sensitive to a fresh pool connection after a restart (test 7b asserts it for the receipts before the restart only).

## Reproduce

```sh
bun test/messaging/measure-plain-alternative.ts
```

On a checkout without D118 the converter line reports the converter as absent and the send line gives the HTML-only figures.
