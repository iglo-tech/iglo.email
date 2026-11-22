// B127: the operator screens show what the API reports. The send log is its own page behind
// sends:get; a subscriber's counts name what they count, and its sends tab shows the journal's
// subject, sequence and status; the enrollment timeline tones a step and names a cap hold; the
// dashboard names the campaign count and the sends. Rows arrive in the browser from the API, so these
// tests check the rendered markup, the translations the page ships and each permission.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, get, login, userWith } from "@/test/admin/support";
import type { Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";

/** The icon a sidebar link shows, by the link's href. */
const iconOf = (page: string, href: string) =>
  new RegExp(`href="${href}"[^>]*>\\s*<svg class="icon">\\s*<use href="[^"]*#icon-(\\w+)"`).exec(
    page,
  )?.[1];

let f: Fixture;
let cookie = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterAll(() => f.close());

test("the send log is a page of its own behind sends:get, with its filters and the labels its script reads", async () => {
  const response = await get(f, "/admin/sends", cookie);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("/admin/static/js/views/sends.js?v=");
  expect(html).toContain('data-testid="send-filters"');
  expect(html).toContain('data-testid="filter-status"');
  expect(html).toContain('data-testid="filter-source"');
  expect(html).toContain('data-testid="filter-kind"');
  expect(html).toContain('data-testid="filter-list"');
  // The browser reads these keys for each row's status, source, reason and fallback subject.
  for (const key of [
    "sends.status.sent",
    "sends.status.skipped",
    "sends.sourceSequence",
    "sends.subjectExpired",
    "sends.subjectSkipped",
    "sends.subjectWiped",
    "sends.sequenceOrTemplate",
    "sends.sequenceStep",
    "skipReasons.frequency_cap",
    "skipReasons.subscriber_blocklisted",
  ]) {
    expect(html).toContain(`"${key}"`);
  }

  const none = await userWith(f, cookie, "no-sends", ["campaigns:get"]);
  expect((await get(f, "/admin/sends", none)).status).toBe(403);
  const reader = await userWith(f, cookie, "sends-reader", ["sends:get"]);
  const listed = await (await get(f, "/admin/sends", reader)).text();
  expect(listed).toContain('data-testid="send-filters"');
  // The sidebar links to the log for a reader; a user without the grant has no link.
  expect(listed).toContain('href="/admin/sends"');
  // The send log has its own icon, not the dashboard's grid (B127).
  expect(iconOf(listed, "/admin/sends")).toBe("mail");
  expect(iconOf(await (await get(f, "/admin", reader)).text(), "/admin")).toBe("grid");
  expect(await (await get(f, "/admin/lists", none)).text()).not.toContain('href="/admin/sends"');
});

test("a subscriber's counts name what they count, and the sends tab shows the journal's labels", async () => {
  const activity = await (await get(f, "/admin/subscribers/7", cookie)).text();
  expect(activity).toContain('data-testid="stat-campaigns"');
  expect(activity).toContain("Campaigns viewed");
  expect(activity).toContain("Campaign views");
  expect(activity).toContain("Campaign clicks");
  expect(activity).toContain('data-testid="stat-sends"');
  expect(activity).toContain("Sequence and tx sends");
  // The external ID is copied from the page when there is one.
  expect(activity).toContain("External ID");
  expect(activity).toContain("form.external_id");

  const sends = await (await get(f, "/admin/subscribers/7/sends", cookie)).text();
  expect(sends).toContain('data-testid="send-row"');
  expect(sends).toContain('data-testid="link-all-sends"');
  expect(sends).toContain('href="/admin/sends?subscriber_id=7"');
  expect(sends).toContain("/admin/static/js/views/subscribers.js?v=");
  expect(sends).toContain('"sends.status.skipped"');

  const none = await userWith(f, cookie, "sub-no-sends", ["subscribers:get"]);
  const quiet = await (await get(f, "/admin/subscribers/7", none)).text();
  expect(quiet).toContain('data-testid="stat-campaigns"');
  expect(quiet).not.toContain('data-testid="stat-sends"');
  expect((await get(f, "/admin/subscribers/7/sends", none)).status).toBe(403);
});

test("the events tab names each refused sequence start by its sequence and its reason", async () => {
  const html = await (await get(f, "/admin/subscribers/7/events", cookie)).text();
  expect(html).toContain('data-testid="event-skipped"');
  expect(html).toContain("sequenceName(s.sequence_id)");
  expect(html).toContain("skipLabel(s.reason)");
  expect(html).toContain('"skipReasons.subscriber_blocklisted"');
});

test("the enrollment timeline tones each step by its decision and names a cap hold", async () => {
  const html = await (await get(f, "/admin/sequences/enrollments/1", cookie)).text();
  expect(html).toContain('x-bind:data-variant="entryVariant(entry)"');
  expect(html).toContain('"sequences.entry.waitingHeld"');
  expect(html).toContain('"sends.status.skipped"');
});

test("the dashboard names the campaign count, and the sequence and tx count only where the viewer may read sends", async () => {
  const html = await (await get(f, "/admin", cookie)).text();
  expect(html).toContain("Campaign messages sent");
  expect(html).toContain('data-testid="stat-messages"');
  expect(html).toContain("Sequence and tx sent");
  expect(html).toContain('href="/admin/sends?status=sent"');
  expect(html).toContain('"can_sends":true');

  const none = await userWith(f, cookie, "dash-none", ["campaigns:get"]);
  const quiet = await (await get(f, "/admin", none)).text();
  expect(quiet).toContain("Campaign messages sent");
  expect(quiet).not.toContain('href="/admin/sends?status=sent"');
  expect(quiet).toContain('"can_sends":false');
});
