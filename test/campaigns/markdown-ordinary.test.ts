// B105 (D112): ordinary Markdown must render. The reviewer's five documents of 16.6 to 20.2 KiB (r2 review),
// written the way a campaign author writes them (hard-break lines, address lines, an events digest, a FAQ as
// heading then quote, testimonials as quote then a rule), and a 64 KiB document of 200 real tables, are rendered
// as a preview and sent by a campaign to two subscribers.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture } from "@/test/campaigns/fixture";
import type { CampaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import type { RunnerFixture } from "@/test/campaigns/runner/fixture";
import { previewForm, readerSession } from "@/test/campaigns/markdown-support";

let f: CampaignsFixture | undefined;
let r: RunnerFixture | undefined;
afterEach(async () => {
  await f?.close();
  await r?.close();
  f = undefined;
  r = undefined;
});

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The documents; `marker` is text near the end that the rendered output must contain. */
const documents: Array<{
  name: string;
  source: string;
  marker: string;
  /** Rendered `<table>` elements the output must contain, when the document is a table document. */
  tables?: number;
}> = [
  {
    name: "schedule with hard breaks",
    source: Array.from(
      { length: 300 },
      (_, i) =>
        `**${9 + (i % 8)}:${pad2((i * 7) % 60)}** Talk ${i}: a panel on item ${i}, in room ${"ABCD"[i % 4]}, with Q&A  \n`,
    ).join(""),
    marker: "Talk 299: a panel",
  },
  {
    name: "address lines",
    source: Array.from(
      { length: 400 },
      (_, i) => `*Store ${i}*, ${12 + i} Main Street, Springfield, Suite ${i % 9}\n`,
    ).join(""),
    marker: "Store 399",
  },
  {
    name: "events digest",
    source: Array.from(
      { length: 200 },
      (_, i) =>
        `**${1 + (i % 28)} Nov** — Meetup at the _Old Library_, session ${i}, [details](https://e.test/${i})\n`,
    ).join(""),
    marker: "session 199,",
  },
  {
    name: "FAQ as heading then quote",
    source: Array.from(
      { length: 300 },
      (_, i) => `### Question ${i}?\n> Answer: **yes**, [guide](https://h.test/${i}).\n`,
    ).join(""),
    marker: 'href="https://h.test/299"',
  },
  {
    name: "testimonials as quote then rule",
    source: Array.from(
      { length: 300 },
      (_, i) => `> “Great service, *highly* recommended” — Ann K., Oslo ${i}\n---\n`,
    ).join(""),
    marker: "Ann K., Oslo 299",
  },
  {
    name: "200 tables of 5 rows and 10 cells",
    source: Array.from({ length: 200 }, (_, t) => {
      const header = `| ${Array.from({ length: 10 }, () => "h").join(" | ")} |\n`;
      const delimiter = `|${Array.from({ length: 10 }, () => "---").join("|")}|\n`;
      const rows = Array.from(
        { length: 5 },
        () => `| t${t} | ${Array.from({ length: 9 }, () => "c").join(" | ")} |\n`,
      ).join("");
      return `${header}${delimiter}${rows}\n`;
    }).join(""),
    marker: "t199</td>",
    tables: 200,
  },
];

for (const { name, source, marker, tables } of documents) {
  const kib = (Buffer.byteLength(source) / 1024).toFixed(2);

  test(`${name} (${kib} KiB) renders in a preview`, async () => {
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(64 * 1024);
    f = await campaignsFixture();
    const news = await f.list("news");
    const campaign = await f.campaign({ name: "ordinary", subject: "s", lists: [news] });
    const headers = await readerSession(
      f,
      "ordinary-reader",
      ["campaigns:get"],
      [{ id: news, permissions: ["list:get"] }],
    );
    const started = performance.now();
    const response = await f.request(`/api/campaigns/${campaign.id}/preview`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: previewForm(source),
    });
    const html = await response.text();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    if (tables !== undefined) {
      expect(html.split("<table>").length - 1).toBe(tables);
    }
  });

  test(`${name} (${kib} KiB) is sent by a campaign to two subscribers`, async () => {
    r = await runnerFixture();
    const single = await r.list("single", "single");
    await r.member("a@x.test", [single]);
    await r.member("b@x.test", [single]);
    const c = await r.campaign({
      name: "ordinary",
      subject: "Ordinary",
      lists: [single],
      content_type: "markdown",
      body: source,
    });
    expect((await r.status(c.id, "running")).status).toBe(200);
    r.start();
    await r.until(c.id, "finished");
    const read = await r.read(c.id);
    expect(read.status).toBe("finished");
    expect(read.sent).toBe(2);
    expect(r.pushes.map((p) => p.to).sort()).toEqual(["a@x.test", "b@x.test"]);
    for (const push of r.pushes) {
      expect(Buffer.from(push.message.body).toString()).toContain(marker);
      if (tables !== undefined) {
        expect(Buffer.from(push.message.body).toString().split("<table>").length - 1).toBe(tables);
      }
    }
  });
}
