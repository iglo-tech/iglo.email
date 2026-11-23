// Opt-in, serial timing of the sending path's render (D110, B135): `compile` once per message and
// `renderSync` per recipient, as tx and campaign sends call them. It uses only the renderer API that
// every checkout has, so the same file runs in `origin/main` and in a branch (`bun
// test/templates/measure-send-render.ts [rounds]`, from each checkout). Not a CI threshold: run base
// and head interleaved, in one container, and read the medians (docs/perf/B135-render.md).
import { createMessageBudget, createRenderer } from "@/templates/renderer";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";

const rounds = Number(process.argv[2] ?? 20);
const renderer = createRenderer(createRealClock(), createTranslation());
const items = Array.from({ length: 20 }, (_, i) => ({ name: `Item ${i} & Co`, price: i * 3 }));
const recipient = (i: number) =>
  JSON.stringify({
    subscriber: {
      name: `Person ${i}`,
      first_name: "Person",
      email: `p${i}@example.test`,
      attribs: { city: `City ${i % 50}` },
    },
    data: { order_id: `ORD-${i}`, total: 1234.5 + i, shipping_date: "2026-01-02", items },
    manage_url: "https://example.test/manage",
    unsubscribe_url: "",
  });
const cases = [
  {
    name: "tx-html",
    compile: {
      body:
        "<h1>Hi {{ subscriber.first_name | upcase }}</h1><p>{{ data.order_id }} · " +
        "{{ data.total | number }} · {{ data.shipping_date | date: '%d.%m.%Y' }}</p><ul>" +
        "{% for item in data.items %}<li>{{ item.name }}: {{ item.price | default: 0 }}</li>" +
        "{% endfor %}</ul>",
      subject: "Order {{ data.order_id }}",
      mode: "html" as const,
      transactional: true,
    },
  },
  {
    name: "campaign-layout",
    compile: {
      body: "<p>Hello {{ subscriber.attribs.city }}.</p><p>Visit {{ 'https://example.test/x' | track_link }}</p>",
      layout:
        "<!doctype html><html><body><header>{{ campaign.name }}</header><main>{{ content | raw }}" +
        '</main><footer><a href="{{ unsubscribe_url }}">Unsubscribe</a>{{ track_view }}</footer>' +
        "</body></html>",
      subject: "News for {{ subscriber.name }}",
      mode: "html" as const,
    },
  },
  {
    name: "plain-text",
    compile: {
      body: "Hello {{ subscriber.name }}: {% for item in data.items %}{{ item.name | upcase }};{% endfor %}",
      mode: "plain" as const,
    },
  },
];

const recipients = Array.from({ length: 200 }, (_, i) => recipient(i));
for (let round = 0; round < rounds; round++) {
  for (const testCase of cases) {
    const compiled = renderer.compile(testCase.compile);
    // Each recipient renders with a fresh message budget, as a send gives it.
    for (let warm = 0; warm < 20; warm++) {
      compiled.renderSync(
        recipients[warm % recipients.length] ?? "",
        undefined,
        createMessageBudget(),
      );
    }
    const start = performance.now();
    for (const data of recipients) {
      compiled.renderSync(data, undefined, createMessageBudget());
    }
    const microseconds = ((performance.now() - start) * 1000) / recipients.length;
    console.log(
      JSON.stringify({ round, case: testCase.name, usPerRender: Number(microseconds.toFixed(1)) }),
    );
  }
}
