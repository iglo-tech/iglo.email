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

- Time is linear: 47 KB takes 0.61 ms and 0.99 MiB takes 15.5 ms, the same per-byte rate. Every pass after the one HTMLRewriter stream is a linear scan of the collected text, and no regular expression is quadratic on its input (whitespace runs are collapsed before the line-break pass).
- Size: the output is never longer than the input in bytes. It is charged to the message budget, which every part of the message shares, and the stored text is bounded by the existing 1 MiB per-body limit in `src/messaging/payload.ts`.
- The 8 MiB payload bound is unchanged and now includes the text part (see D118, Known edges).

The send-rate tests (B37, `test/messaging/send-rate.test.ts`) are changed in their own commit: tests 1 and 7b drive the injected clock in 10 ms steps, and tests 1b and 7b wait for the campaign delivery rows as well as the sink count, because a 50 ms step quantized the receipt times they read and the sink can hold a message before its row is written; the cap itself is unchanged. Sink receipts also carry each send's own latency, so the rolling one-per-second check at the sink is sensitive to a fresh pool connection after a restart (test 7b asserts it for the receipts before the restart only).

## Reproduce

```sh
bun test/messaging/measure-plain-alternative.ts
```

On a checkout without D118 the converter line reports the converter as absent and the send line gives the HTML-only figures.
