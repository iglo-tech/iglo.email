// D126 (r2): the view pixel records a view only for a campaign the runner delivered to the subscriber
// the pixel names. Every other request gets the same 1x1 image and records nothing. Through HTTP,
// with the pixels of real delivered mail, and the campaign statistics API (`views`).
import { afterEach, expect, test } from "bun:test";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import type { RunnerFixture } from "@/test/campaigns/runner/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<RunnerFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await runnerFixture({ webhooks: {} });
  fixtures.push(f);
  return f;
}

const dummy = "00000000-0000-0000-0000-000000000000";
const body = '<p><a href="{{ unsubscribe_url }}">u</a></p>{{ track_view }}';

const views = async (f: RunnerFixture, id: number) =>
  asBody<number>((await f.json(`/api/campaigns/${id}`)).body.data.views);
/** The view pixel path in a delivered message. */
const pixelOf = (f: RunnerFixture, to: string) => {
  const push = f.pushes.find((p) => p.to === to)!;
  const text = Buffer.from(push.message.body).toString();
  return /http:\/\/fixture\.test(\/campaign\/[^"]+\/px\.png)/.exec(text)![1]!;
};
const pixel = async (f: RunnerFixture, path: string) => {
  const response = await f.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  return new Uint8Array(await response.arrayBuffer());
};
/** Sends a campaign to the list and waits until the runner has finished it. */
async function send(f: RunnerFixture, lists: Array<number>) {
  const c = await f.campaign({
    name: "Weekly",
    subject: "Weekly",
    lists,
    content_type: "html",
    body,
  });
  await f.status(c.id, "running");
  f.start();
  await f.until(c.id, "finished");
  return c;
}

test("individual tracking: only a pixel of mail delivered to the subscriber it names counts", async () => {
  const f = await open();
  // The runner names the subscriber in its pixels; the public route counts them (one setting in production).
  f.settings.individualTracking = true;
  f.publicSettings.individualTracking = true;
  const single = await f.list("single", "single");
  const ada = await f.member("ada@example.test", [single], "confirmed");
  const c = await send(f, [single]);
  // The pixel of Ada's own delivered message counts, once.
  const genuine = await pixel(f, pixelOf(f, "ada@example.test"));
  expect(await views(f, c.id)).toBe(1);

  // A subscriber the campaign never reached: the same image, and no view.
  const bob = await f.member("bob@example.test", [single], "confirmed");
  expect(await pixel(f, `/campaign/${c.uuid}/${bob.uuid}/px.png`)).toEqual(genuine);
  expect(await views(f, c.id)).toBe(1);

  // An absent subscriber, and the dummy subscriber under individual tracking: the same image, no view.
  expect(await pixel(f, `/campaign/${c.uuid}/${crypto.randomUUID()}/px.png`)).toEqual(genuine);
  expect(await pixel(f, `/campaign/${c.uuid}/${dummy}/px.png`)).toEqual(genuine);
  expect(await views(f, c.id)).toBe(1);

  // A draft the runner never delivered: no subscriber pairs, and nothing counts.
  const draft = await f.campaign({
    name: "Draft",
    subject: "Draft",
    lists: [single],
    content_type: "html",
    body,
  });
  expect(await pixel(f, `/campaign/${draft.uuid}/${ada.uuid}/px.png`)).toEqual(genuine);
  expect(await views(f, draft.id)).toBe(0);

  // The control: a second genuine pixel of Ada's mail counts again.
  await pixel(f, pixelOf(f, "ada@example.test"));
  expect(await views(f, c.id)).toBe(2);
});

test("anonymous tracking: a pixel of mail the server sent counts, and a subscriber it never reached does not", async () => {
  const f = await open();
  f.settings.individualTracking = false;
  f.publicSettings.individualTracking = false;
  const single = await f.list("single", "single");
  await f.member("ada@example.test", [single], "confirmed");
  const c = await send(f, [single]);
  // Without individual tracking the pixel names the dummy subscriber, and counts as anonymous.
  const path = pixelOf(f, "ada@example.test");
  expect(path).toContain(`/${dummy}/px.png`);
  const genuine = await pixel(f, path);
  expect(await views(f, c.id)).toBe(1);

  // A subscriber the campaign never reached: the same image, and no view.
  const late = await f.member("late@example.test", [single], "confirmed");
  expect(await pixel(f, `/campaign/${c.uuid}/${late.uuid}/px.png`)).toEqual(genuine);
  expect(await views(f, c.id)).toBe(1);

  // An unsent draft: the same image, and no view.
  const draft = await f.campaign({
    name: "Draft",
    subject: "Draft",
    lists: [single],
    content_type: "html",
    body,
  });
  expect(await pixel(f, `/campaign/${draft.uuid}/${dummy}/px.png`)).toEqual(genuine);
  expect(await views(f, draft.id)).toBe(0);
});

test("mail sent with individual tracking on still counts after it is turned off, anonymously", async () => {
  const f = await open();
  const single = await f.list("single", "single");
  const ada = await f.member("ada@example.test", [single], "confirmed");
  // Sent while tracking was on: its pixel names Ada.
  f.settings.individualTracking = true;
  f.publicSettings.individualTracking = true;
  const c = await send(f, [single]);
  const named = pixelOf(f, "ada@example.test");
  expect(named).toContain(`/${ada.uuid}/px.png`);
  // Tracking is now off: the same pixel still counts, anonymously, and names nobody.
  f.settings.individualTracking = false;
  f.publicSettings.individualTracking = false;
  await pixel(f, named);
  expect(await views(f, c.id)).toBe(1);
});
