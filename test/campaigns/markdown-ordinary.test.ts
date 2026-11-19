// B105 r2 (D112), blocker 2: ordinary Markdown with single newlines between blocks must render. Five
// documents of 16.6 to 20.2 KiB, each written the way a campaign author writes it (hard-break lines,
// address lines, a digest, a FAQ as heading then quote, testimonials as quote then a rule), are rendered
// as a preview and sent by a campaign to two subscribers.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture, type RunnerFixture } from "@/test/campaigns/runner/fixture";
import { previewForm, readerSession } from "@/test/campaigns/markdown-support";

let f: CampaignsFixture | undefined;
let r: RunnerFixture | undefined;
afterEach(async () => {
  await f?.close();
  await r?.close();
  f = undefined;
  r = undefined;
});

/** The five documents; `marker` is a line near the end that the rendered output must contain. */
const documents: { name: string; source: string; marker: string }[] = [
  {
    name: "schedule with hard breaks",
    source: Array.from(
      { length: 240 },
      (_, i) =>
        `**${9 + (i % 8)}:${String((i * 7) % 60).padStart(2, "0")}** Talk ${i}: a panel on item ${i}, in room ${"ABCD"[i % 4]}, with questions afterwards  \n`,
    ).join(""),
    marker: "Talk 239: a panel",
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
        `**${1 + (i % 28)} Nov** — Meetup at the _Old Library_, session ${i}, [details](https://events.example.test/e/${i})\n`,
    ).join(""),
    marker: "session 199,",
  },
  {
    name: "FAQ as heading then quote",
    source: Array.from(
      { length: 240 },
      (_, i) =>
        `### Question ${i}?\n> The answer is **yes**: see [the guide](https://h.test/${i}).\n`,
    ).join(""),
    marker: 'href="https://h.test/239"',
  },
  {
    name: "testimonials as quote then rule",
    source: Array.from(
      { length: 330 },
      (_, i) => `> “Great service, *highly* recommended” — Ann K. ${i}\n---\n`,
    ).join(""),
    marker: "Ann K. 329",
  },
];

for (const { name, source, marker } of documents) {
  test(`${name} (${(Buffer.byteLength(source) / 1024).toFixed(1)} KiB) renders in a preview`, async () => {
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
  });

  test(`${name} is sent by a campaign to two subscribers`, async () => {
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
    }
  });
}
