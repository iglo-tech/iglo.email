// B126 (D123): a sequence's marketing mail to a private single-opt-in list. Its unsubscribe link,
// revisited after the one-click, says the person is already unsubscribed and names no list, because
// the private list is never named. The mail comes from the scheduler and the SMTP sink, and the link
// is read from the send the scheduler wrote, through the public route.
import { afterEach, expect, test } from "bun:test";
import { schedulerFixture } from "@/test/scheduler/fixture";
import type { SchedulerFixture } from "@/test/scheduler/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<SchedulerFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}

test("a sequence's private-list mail: the revisited link says already unsubscribed, without naming the list", async () => {
  const f = await open();
  const address = "member@example.test";
  const membersCreated = await f.json("/api/lists", "POST", {
    name: "Members",
    type: "private",
    optin: "single",
  });
  const members = asBody<number>(membersCreated.body.data.id);
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Hello");
  await f.sequence({
    name: "Members",
    list_id: members,
    trigger: { event: "order_paid" },
    steps: [{ wait: "PT0S", kind: "marketing", template_id: template }],
  });
  const started = await f.json("/api/subscriber-events", "POST", {
    subscriber: { email: address, name: "Mia", grant_lists: [members] },
    name: "order_paid",
  });
  expect(started.status).toBe(200);
  const subscriber = asBody<number>(started.body.data.subscriber_id);

  const marketing = () =>
    f.sink.messages.filter((m) => m.to.includes(address) && m.data.includes("List-Unsubscribe:"))
      .length;
  await f.until(() => marketing() === 1, "the sequence's marketing mail");

  const send = asBody<{ uuid: string }>(
    f.db.query("SELECT uuid FROM sends WHERE to_email = ? AND kind = 'marketing'").get(address),
  ).uuid;
  const uuid = asBody<string>((await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid);
  const page = `/m/${send}/unsubscribe/${uuid}`;
  expect(await (await f.request(page)).text()).toContain(
    "Do you want to unsubscribe from this mailing list?",
  );

  const oneClick = await f.request(page, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(oneClick.status).toBe(200);

  const again = await (await f.request(page)).text();
  expect(again).toContain("You are already unsubscribed from these emails.");
  expect(again).not.toContain("Members");
  expect(again).not.toContain("Do you want to unsubscribe");
});
