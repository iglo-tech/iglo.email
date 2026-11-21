// B120 (D118): what the generated text part costs per message, measured on a realistic newsletter.
// Run from a checkout: `bun test/messaging/measure-plain-alternative.ts`. It sends through the
// in-process transactional fixture and a loopback SMTP sink (no network). The same script runs on a
// checkout without D118, where the converter is absent and the wire message is HTML only.
import { createMessageBudget } from "@/templates/renderer";
import { txFixture } from "@/test/tx/fixture";

const SENDS = 150;
const CONVERSIONS = 300;

const PADDING = "&#847;&zwnj;&nbsp;".repeat(90);
const PREHEADER = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">This week's release notes, and one pack you may want.${PADDING}</div>`;
const SENTENCE =
  "Our team shipped the export tool this week, with faster packs and clearer totals for every account. ";
/** A newsletter of about 54 KB: a header, a hero, 56 story blocks and a footer, near the template cap. */
function newsletter(): string {
  const stories = Array.from(
    { length: 56 },
    (_, n) =>
      `<table role="presentation" width="100%" style="margin:0 0 24px 0;"><tr><td style="padding:16px;font-family:Arial,sans-serif;font-size:15px;line-height:22px;color:#222222;"><h2 style="font-size:20px;margin:0 0 8px 0;">Story ${n}: a release note</h2><p style="margin:0 0 12px 0;">${SENTENCE}${SENTENCE}<a href="https://example.test/news/${n}?utm_source=mail&amp;utm_medium=email" style="color:#0b5cad;">Read the release notes</a> or <a href="https://example.test/pricing/${n}">compare the plans</a>.</p><img src="https://example.test/img/${n}.png" width="560" height="200" alt="Story ${n}" style="display:block;border:0;"></td></tr></table>`,
  ).join("");
  return `${PREHEADER}<table role="presentation" width="100%"><tr><td align="center"><img src="https://example.test/logo.png" width="180" alt="Logo" style="display:block;"></td></tr><tr><td><h1 style="font-size:28px;">Hello {{ subscriber.first_name }}</h1></td></tr></table>${stories}<p style="font-size:12px;color:#777777;">You receive this because you subscribed. <a href="{{ manage_url }}">Manage preferences</a> or <a href="https://example.test/archive">read it online</a>.</p>`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const html = newsletter();
console.log(`newsletter: ${Buffer.byteLength(html)} bytes of HTML`);

// The converter alone, on the same newsletter (only where D118 exists).
const converter = await import("@/messaging/plain").then(
  (module) => module,
  () => undefined,
);
if (converter) {
  for (let i = 0; i < 20; i++) await converter.plainText(html, createMessageBudget());
  const times: number[] = [];
  let text = "";
  for (let i = 0; i < CONVERSIONS; i++) {
    const started = performance.now();
    text = await converter.plainText(html, createMessageBudget());
    times.push(performance.now() - started);
  }
  console.log(
    `converter: median ${median(times).toFixed(3)} ms over ${CONVERSIONS} runs; text ${Buffer.byteLength(text)} bytes (${((Buffer.byteLength(text) / Buffer.byteLength(html)) * 100).toFixed(1)}% of the HTML)`,
  );
  // Linear in the input: twenty-two newsletters at once, about 1 MiB of HTML (the output bound).
  const large = html.repeat(22);
  const started = performance.now();
  const largeText = await converter.plainText(large, createMessageBudget());
  console.log(
    `converter at ${(Buffer.byteLength(large) / 1048576).toFixed(2)} MiB: ${(performance.now() - started).toFixed(1)} ms once; text ${Buffer.byteLength(largeText)} bytes`,
  );
} else {
  console.log("converter: absent (no generated text part before D118)");
}

// The send path: one transactional send per iteration, measured from the request to the sink's copy.
const f = await txFixture();
try {
  const template = await f.template(html, "Release notes");
  const id = await f.subscriber("ada@example.test", "Ada Lovelace");
  const times: number[] = [];
  let wire = 0;
  for (let i = 0; i < SENDS; i++) {
    const started = performance.now();
    const response = await f.tx({ subscriber_id: id, template_id: template });
    times.push(performance.now() - started);
    if (response.status !== 200) throw new Error(`tx ${response.status}`);
    wire = f.sink.messages.at(-1)!.data.length;
  }
  console.log(
    `send: median ${median(times).toFixed(2)} ms per tx send over ${SENDS} sends (request to SMTP sink); last wire message ${wire} bytes`,
  );
  console.log(`sends delivered to the sink: ${f.sink.messages.length}`);
} finally {
  await f.close();
}
