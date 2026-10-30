// Serial in-process test-send measurements for docs/perf/M3.1-campaigns.md; not a CI
// threshold. POST /api/campaigns/:id/test with a realistic campaign (default template,
// about 8 KiB of HTML with Liquid fields, five tracked links, the view pixel and three
// custom headers) for 1, 10, 100 and 1,000 recipients, then the review's ten-header case.
import { campaignsFixture } from "@/test/campaigns/fixture";

const runs = Number(process.env.CAMPAIGNS_MEASURE_RUNS ?? "3");
const mib = (bytes: number) => +(bytes / 1048576).toFixed(1);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
const f = await campaignsFixture();
try {
  const news = await f.list("news");
  const emails: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const email = `r${i}@example.test`;
    await f.subscriber(email, [news], { attribs: { city: "Kraków", plan: "pro" } });
    emails.push(email);
  }
  const paragraph =
    "<p>Hello {{ subscriber.first_name }}, here is this week's update for {{ subscriber.attribs.city }}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>\n";
  const links = Array.from(
    { length: 5 },
    (_, i) =>
      `<p><a href="{{ "https://example.test/article/${i}?utm=weekly" | track_link }}">Article ${i}</a></p>\n`,
  ).join("");
  const body = `<h1>{{ campaign.name }}</h1>\n${paragraph.repeat(36)}${links}<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>{{ track_view }}`;
  const realistic = {
    name: "Weekly",
    subject: "Weekly for {{ subscriber.first_name }}",
    lists: [news],
    messenger: "email",
    content_type: "richtext",
    body,
    altbody: "Weekly for {{ subscriber.name }}",
    headers: [
      { "X-Campaign": "{{ campaign.name }}" },
      { "X-Who": "{{ subscriber.email }}" },
      { "X-Plan": "{{ subscriber.attribs.plan }}" },
    ],
  };
  const c = await f.campaign({ name: "Weekly", subject: "s", lists: [news] });
  const measure = async (input: object, count: number) => {
    const status: number[] = [];
    const response: number[] = [];
    const delivered: number[] = [];
    const rssGrowth: number[] = [];
    for (let run = 0; run < runs; run++) {
      Bun.gc(true);
      f.sink.messages.length = 0;
      const before = process.memoryUsage().rss;
      const started = performance.now();
      const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
        ...input,
        subscribers: emails.slice(0, count),
      });
      response.push(performance.now() - started);
      rssGrowth.push(process.memoryUsage().rss - before);
      status.push(sent.status);
      if (sent.status === 200) {
        const deadline = performance.now() + 300_000;
        while (f.sink.messages.length < count && performance.now() < deadline) await Bun.sleep(2);
        delivered.push(performance.now() - started);
      }
    }
    return {
      recipients: count,
      status: [...new Set(status)].join(","),
      responseMs: +median(response).toFixed(1),
      deliveredMs: delivered.length ? +median(delivered).toFixed(1) : null,
      rssGrowthAtResponseMiB: mib(median(rssGrowth)),
      bytesPerMessage: f.sink.messages[0] ? f.sink.messages[0].data.length : null,
    };
  };
  const results = [];
  for (const count of [1, 10, 100, 1000])
    results.push({ case: "realistic", ...(await measure(realistic, count)) });
  const header = `{% for i in (1..512) %}${"x".repeat(1024)}{% endfor %}`;
  results.push({
    case: "review ten 512 KiB headers",
    ...(await measure(
      {
        ...realistic,
        body: "<p>hi</p>",
        headers: Array.from({ length: 10 }, (_, i) => ({ [`X-Big-${i}`]: header })),
      },
      1,
    )),
  });
  process.stdout.write(
    `${JSON.stringify({ bun: Bun.version, runs, rssEndMiB: mib(process.memoryUsage().rss), results }, null, 2)}\n`,
  );
} finally {
  await f.close();
}
