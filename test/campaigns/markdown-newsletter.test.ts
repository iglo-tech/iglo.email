// B105 (D112): a realistic Markdown newsletter of 4, 16, 64 and 256 KiB renders in a preview, a test
// send to the SMTP sink and a campaign send to two subscribers, each within a second of being sent.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture, type RunnerFixture } from "@/test/campaigns/runner/fixture";
import { previewForm, readerSession } from "@/test/campaigns/markdown-support";
import { newsletter } from "@/test/templates/markdown-newsletter";

let f: CampaignsFixture | undefined;
let r: RunnerFixture | undefined;
afterEach(async () => {
  await f?.close();
  await r?.close();
  f = undefined;
  r = undefined;
});

test.each([4, 16, 64, 256])(
  "a %i KiB newsletter renders in preview and in a test send",
  async (kib) => {
    f = await campaignsFixture();
    const news = await f.list("news");
    const campaign = await f.campaign({ name: "digest", subject: "Digest", lists: [news] });
    const { source, last } = newsletter(kib);
    const headers = await readerSession(
      f,
      `reader-${kib}`,
      ["campaigns:get", "campaigns:manage"],
      [{ id: news, permissions: ["list:get", "list:manage"] }],
    );
    const started = performance.now();
    const preview = await f.request(`/api/campaigns/${campaign.id}/preview`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: previewForm(source),
    });
    const html = await preview.text();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(preview.status).toBe(200);
    expect(html).toContain(`<h2>Story ${last}: a headline`);

    await f.subscriber("ada@example.test", [news]);
    const sent = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
      name: "Digest",
      subject: "Digest",
      lists: [news],
      messenger: "email",
      content_type: "markdown",
      body: source,
      subscribers: ["ada@example.test"],
    });
    expect(sent.status).toBe(200);
    const [message] = await f.mail(1);
    expect(message).toBeDefined();
    expect(Buffer.from(message!.data).toString()).toContain(`Story ${last}: a headline`);
  },
);

test.each([4, 16, 64, 256])(
  "a %i KiB newsletter is sent by a campaign to two subscribers",
  async (kib) => {
    r = await runnerFixture();
    const single = await r.list("single", "single");
    await r.member("a@x.test", [single]);
    await r.member("b@x.test", [single]);
    const { source, last } = newsletter(kib);
    const c = await r.campaign({
      name: "digest",
      subject: "Digest",
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
      expect(Buffer.from(push.message.body).toString()).toContain(`Story ${last}: a headline`);
    }
  },
);

test("a campaign body one byte past 256 KiB is refused", async () => {
  f = await campaignsFixture();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "big", subject: "s", lists: [news] });
  const headers = await readerSession(
    f,
    "too-big-reader",
    ["campaigns:get"],
    [{ id: news, permissions: ["list:get"] }],
  );
  const body = "x".repeat(256 * 1024 + 1);
  const response = await f.request(`/api/campaigns/${campaign.id}/preview`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: previewForm(body),
  });
  expect(response.status).toBe(400);
});
