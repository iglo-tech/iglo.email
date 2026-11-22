// D124: a campaign test message's subject starts with "[Test] " so its recipient can tell it from a
// real send (D117 already keeps it inert). A real send's subject is unchanged. Through HTTP, the
// SMTP sink and the runner's push record.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture } from "@/test/campaigns/runner/fixture";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

test("a campaign test message's subject starts with [Test] ", async () => {
  const f = await campaignsFixture();
  cleanups.push(() => f.close());
  const news = await f.list("news");
  await f.subscriber("ada@example.test", [news]);
  const c = await f.campaign({ name: "Weekly", subject: "Stored", lists: [news] });
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "Weekly",
    subject: "Hi there",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body: "<p>Hello</p>",
    subscribers: ["ada@example.test"],
  });
  expect(sent.status).toBe(200);
  const [mail] = await f.mail(1);
  expect(mail!.data).toContain("Subject: [Test] Hi there\r\n");
});

test("a real campaign send keeps its subject without the test prefix", async () => {
  const f = await runnerFixture({ webhooks: {} });
  cleanups.push(() => f.close());
  const single = await f.list("single", "single");
  await f.member("real@x.test", [single], "confirmed");
  const c = await f.campaign({ name: "c", subject: "Real subject", lists: [single] });
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  const push = f.pushes.find((p) => p.to === "real@x.test")!;
  expect(push.message.subject).toBe("Real subject");
});
