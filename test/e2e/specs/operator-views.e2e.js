// B127: the operator screens. The send log is a page of its own and filters by status; a subscriber's
// sends and events name each message's subject, sequence and reason; an exact external ID finds its
// subscriber on the list; and the subscriber's tabs fit a phone without the page scrolling sideways.
import { expect } from "@playwright/test";
import { api, signIn, test, unique } from "../helpers.js";

async function template(page) {
  const made = await api(page, "/api/templates", "POST", {
    name: unique("op-tx"),
    type: "tx",
    subject: unique("Welcome"),
    body: "<p>{{ subscriber.name }}</p>",
  });
  expect(made.status).toBe(200);
  return made.body.data;
}

// A sequence that starts for a person on the event, with one marketing step sent at once.
async function started(page, list, email, extra = {}) {
  const tx = await template(page);
  const event = unique("op-evt");
  const seq = await api(page, "/api/sequences", "POST", {
    name: unique("Onboarding"),
    status: "active",
    trigger: { event },
    reentry: "always",
    list_id: list.id,
    steps: [{ wait: "PT0S", kind: "marketing", template_id: tx.id }],
  });
  expect(seq.status).toBe(200);
  const sent = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email, name: "Operator", grant_lists: [list.id], ...extra },
    name: event,
  });
  expect(sent.status).toBe(200);
  return {
    sequence: seq.body.data,
    event,
    subscriber: sent.body.data.subscriber_id,
    subject: tx.subject,
  };
}

async function audience(page) {
  const made = await api(page, "/api/lists", "POST", {
    name: unique("Operator news"),
    type: "public",
    optin: "single",
  });
  expect(made.status).toBe(200);
  return made.body.data;
}

test("the send log lists each send by its subject and sequence step, and filters by status", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const email = `${unique("op")}@example.com`;
  const { sequence, subject } = await started(page, list, email);
  await expect
    .poll(async () => (await api(page, "/api/sends?status=sent&per_page=100")).body.data.total)
    .toBeGreaterThan(0);

  await page.goto("/admin/sends");
  const row = page.getByTestId("send-row").filter({ hasText: email });
  await expect(row).toContainText(subject);
  await expect(row).toContainText(`${sequence.name}, step 1`);
  await expect(row.getByTestId("send-status")).toHaveText("Sent");

  await page.getByTestId("filter-status").selectOption("failed");
  await page.getByTestId("btn-filter").click();
  await expect(page).toHaveURL(/status=failed/);
  await expect(page.getByTestId("send-row").filter({ hasText: email })).toHaveCount(0);
});

test("a subscriber's counts name what they count, and the sends tab names each message", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const email = `${unique("op")}@example.com`;
  const { sequence, subscriber, subject } = await started(page, list, email);

  await page.goto(`/admin/subscribers/${subscriber}`);
  await expect(page.getByTestId("stat-campaigns")).toBeVisible();
  await expect(page.getByTestId("stat-sends")).toHaveText("1");
  await expect(page.getByText("Campaigns viewed")).toBeVisible();

  await page.goto(`/admin/subscribers/${subscriber}/sends`);
  const row = page.getByTestId("send-row");
  await expect(row).toContainText(subject);
  await expect(row).toContainText(`${sequence.name}, step 1`);
  await expect(row).toContainText(email);
  await expect(page.getByTestId("link-all-sends")).toHaveAttribute(
    "href",
    `/admin/sends?subscriber_id=${subscriber}`,
  );
});

test("an exact external ID finds its subscriber on the list, and a fragment finds nothing", async ({
  page,
}) => {
  await signIn(page);
  const externalId = unique("ext");
  const email = `${unique("op")}@example.com`;
  const made = await api(page, "/api/subscribers", "POST", {
    email,
    name: "External",
    status: "enabled",
    external_id: externalId,
    lists: [],
  });
  expect(made.status).toBe(200);

  await page.goto(`/admin/subscribers?search=${externalId}`);
  await expect(page.getByText(email)).toBeVisible();
  await page.goto(`/admin/subscribers?search=${externalId.slice(0, -2)}`);
  await expect(page.getByText(email)).toHaveCount(0);
});

test("a refused sequence start is named by its sequence and its reason on the events tab", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const email = `${unique("op")}@example.com`;
  const { sequence, event, subscriber } = await started(page, list, email);
  const blocked = await api(page, `/api/subscribers/${subscriber}/blocklist`, "PUT", {});
  expect(blocked.status).toBe(200);
  const refused = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email },
    name: event,
  });
  expect(refused.status).toBe(200);

  await page.goto(`/admin/subscribers/${subscriber}/events`);
  const note = page.getByTestId("event-skipped").first();
  await expect(note).toContainText(sequence.name);
  await expect(note).toContainText("blocklisted");
});

test("an enrollment that an event exited names that event, on its timeline and the subscriber's tab", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const tx = await template(page);
  const start = unique("op-start");
  const stop = unique("op-stop");
  const made = await api(page, "/api/sequences", "POST", {
    name: unique("Exit"),
    status: "active",
    trigger: { event: start },
    exit_on: [stop],
    reentry: "always",
    list_id: list.id,
    steps: [{ wait: "P1D", kind: "marketing", template_id: tx.id }],
  });
  expect(made.status).toBe(200);
  const email = `${unique("op")}@example.com`;
  const began = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email, name: "Exit", grant_lists: [list.id] },
    name: start,
  });
  expect(began.status).toBe(200);
  const { subscriber_id: subscriber } = began.body.data;
  const enrollment = began.body.data.enrollments.started[0].id;
  const ended = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email },
    name: stop,
  });
  expect(ended.status).toBe(200);

  await page.goto(`/admin/sequences/enrollments/${enrollment}`);
  await expect(page.getByTestId("timeline")).toContainText(`Event ${stop}`);
  await page.goto(`/admin/subscribers/${subscriber}/enrollments`);
  await expect(page.getByTestId("enrollment-row").first()).toContainText(`Event ${stop} at`);
  // The events tab names the sequence each event started and exited.
  await page.goto(`/admin/subscribers/${subscriber}/events`);
  await expect(page.getByTestId("event-started").first()).toContainText(made.body.data.name);
  await expect(page.getByTestId("event-exited").first()).toContainText(made.body.data.name);
});

test("a send with no subject says why: a refused one was never prepared, a wiped one lost its address", async ({
  page,
}) => {
  await signIn(page);
  const tx = await template(page);
  const refusedSubscriber = await api(page, "/api/subscribers", "POST", {
    email: `${unique("op")}@example.com`,
    name: "Refused",
    status: "enabled",
    lists: [],
  });
  expect(refusedSubscriber.status).toBe(200);
  const id = refusedSubscriber.body.data.id;
  expect((await api(page, `/api/subscribers/${id}/blocklist`, "PUT", {})).status).toBe(200);
  const refused = await api(page, "/api/tx", "POST", {
    subscriber_id: id,
    template_id: tx.id,
    data: {},
  });
  expect(refused.status).toBe(200);

  const wipedSubscriber = await api(page, "/api/subscribers", "POST", {
    email: `${unique("op")}@example.com`,
    name: "Wiped",
    status: "enabled",
    lists: [],
  });
  expect(wipedSubscriber.status).toBe(200);
  const sent = await api(page, "/api/tx", "POST", {
    subscriber_id: wipedSubscriber.body.data.id,
    template_id: tx.id,
    data: {},
  });
  expect(sent.status).toBe(200);
  const wipedID = wipedSubscriber.body.data.id;
  expect((await api(page, `/api/subscribers/${wipedID}`, "DELETE")).status).toBe(200);

  await page.goto("/admin/sends");
  const refusedRow = refused.body.data.sends[0].id;
  const skipped = page.locator(`[data-testid="send-row"][data-id="${refusedRow}"]`);
  await expect(skipped).toContainText("Not sent: blocklisted");
  await expect(skipped).not.toContainText(tx.subject);
  const wipedRow = sent.body.data.sends[0].id;
  const wiped = page.locator(`[data-testid="send-row"][data-id="${wipedRow}"]`);
  await expect(wiped).toContainText("Removed (data wiped)");
  await expect(wiped).not.toContainText(tx.subject);
  // The template still names the send, though its payload and address are gone.
  await expect(wiped).toContainText(tx.name);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the subscriber's tabs wrap onto a second row, and the page does not scroll sideways", async ({
    page,
  }) => {
    await signIn(page);
    const list = await audience(page);
    const { subscriber } = await started(page, list, `${unique("op")}@example.com`);
    await page.goto(`/admin/subscribers/${subscriber}/events`);
    await expect(page.getByTestId("event-row").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    // Every tab a viewer can open is on screen, the last ones included.
    for (const name of ["Enrollments", "Sends"]) {
      await expect(page.getByRole("tab", { name })).toBeInViewport();
    }
  });
});
