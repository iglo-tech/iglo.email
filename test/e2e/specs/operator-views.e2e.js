// B127: the operator screens. The send log is a page of its own and filters by status; a subscriber's
// sends and events name each message's subject, sequence and reason; an exact external ID finds its
// subscriber on the list; and the subscriber's tabs fit a phone without the page scrolling sideways.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { api, createUser, logout, makeList, PASSWORD, signIn, test, unique } from "../helpers.js";

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

test("a list-scoped reader's send log lists the sends to its lists and no others", async ({
  page,
}) => {
  await signIn(page);
  const mine = await makeList(page);
  const theirs = await makeList(page);
  const inMine = `${unique("scoped")}@example.com`;
  const inTheirs = `${unique("scoped")}@example.com`;
  const sentToMine = await started(page, mine, inMine);
  const sentToTheirs = await started(page, theirs, inTheirs);
  for (const sent of [sentToMine, sentToTheirs]) {
    await expect
      .poll(
        async () =>
          (await api(page, `/api/sends?subscriber_id=${sent.subscriber}&status=sent`)).body.data
            .total,
      )
      .toBe(1);
  }
  const listRole = await api(page, "/api/roles/lists", "POST", {
    name: unique("Mine only"),
    lists: [{ id: mine.id, permissions: ["list:get"] }],
  });
  expect(listRole.status).toBe(200);
  const reader = await createUser(page, ["sends:get"], listRole.body.data.id);
  await logout(page);

  await signIn(page, reader.username, PASSWORD);
  await page.goto("/admin/sends");
  const rows = page.getByTestId("send-row");
  await expect(rows.filter({ hasText: inMine })).toHaveCount(1);
  await expect(rows.filter({ hasText: inTheirs })).toHaveCount(0);
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
  // Each sequence is a link to it, styled as one, on its own line.
  const exitedLink = page
    .getByTestId("event-exited")
    .first()
    .getByRole("link", { name: made.body.data.name });
  await expect(exitedLink).toHaveAttribute("href", `/admin/sequences/${made.body.data.id}`);
  // A link takes the primary colour; an unstyled one would read in its line's muted text colour.
  const [linkColor, lineColor] = await exitedLink.evaluate((a) => [
    getComputedStyle(a).color,
    getComputedStyle(a.parentElement).color,
  ]);
  expect(linkColor).not.toBe(lineColor);
});

// B127 r2: a wiped send keeps its labels. Deleting the subscriber takes the address and the message,
// and the send log still names the sequence and step the send was for, and its template.
test("a wiped sequence send keeps its sequence and step, and its template's name", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const email = `${unique("op")}@example.com`;
  const { sequence, subscriber } = await started(page, list, email);
  let sendID = null;
  await expect
    .poll(async () => {
      const sends = await api(page, `/api/subscribers/${subscriber}/sends?per_page=100`);
      sendID = sends.body.data.results.find((send) => send.status === "sent")?.id ?? null;
      return sendID;
    })
    .not.toBeNull();
  expect((await api(page, `/api/subscribers/${subscriber}`, "DELETE")).status).toBe(200);

  await page.goto("/admin/sends");
  const wiped = page.locator(`[data-testid="send-row"][data-id="${sendID}"]`);
  await expect(wiped).toContainText("Removed (data wiped)");
  await expect(wiped).toContainText(`${sequence.name}, step 1`);
  await expect(wiped).not.toContainText(email);
});

// B127 r2: a step condition that ends an enrollment names its text, on the timeline and the tab.
test("an enrollment a step condition ended names the condition, on its timeline and the subscriber's tab", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const tx = await template(page);
  const event = unique("op-gate");
  const made = await api(page, "/api/sequences", "POST", {
    name: unique("Gate"),
    status: "active",
    trigger: { event },
    reentry: "always",
    list_id: list.id,
    steps: [
      {
        wait: "PT0S",
        kind: "transactional",
        template_id: tx.id,
        condition: { attr: "plan", op: "eq", value: "subscription" },
      },
    ],
  });
  expect(made.status).toBe(200);
  const began = await api(page, "/api/subscriber-events", "POST", {
    subscriber: {
      email: `${unique("op")}@example.com`,
      name: "Gate",
      grant_lists: [list.id],
      attribs: { plan: "free" },
    },
    name: event,
  });
  expect(began.status).toBe(200);
  const { subscriber_id: subscriber } = began.body.data;
  const enrollment = began.body.data.enrollments.started[0].id;
  await expect
    .poll(async () => (await api(page, `/api/enrollments/${enrollment}`)).body.data.status)
    .toBe("exited");

  await page.goto(`/admin/sequences/enrollments/${enrollment}`);
  await expect(page.getByTestId("timeline")).toContainText("Step condition not met: ");
  await expect(page.getByTestId("timeline")).toContainText('"value":"subscription"');
  await page.goto(`/admin/subscribers/${subscriber}/enrollments`);
  await expect(page.getByTestId("enrollment-row").first()).toContainText(
    'Step condition not met: {"attr":"plan","op":"eq","value":"subscription"}',
  );
});

// B127 r2: a marketing wait the frequency cap holds says so, and until when, on the subscriber's tab.
test("a cap-held wait names the cap and when it frees the step, on the subscriber's enrollments tab", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const tx = await template(page);
  const event = unique("op-hold");
  const made = await api(page, "/api/sequences", "POST", {
    name: unique("Held"),
    status: "active",
    trigger: { event },
    reentry: "always",
    list_id: list.id,
    steps: [
      { wait: "PT0S", kind: "marketing", template_id: tx.id },
      { wait: "PT1H", kind: "marketing", template_id: tx.id, max_late: "P8D" },
    ],
  });
  expect(made.status).toBe(200);
  const began = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email: `${unique("op")}@example.com`, name: "Held", grant_lists: [list.id] },
    name: event,
  });
  expect(began.status).toBe(200);
  const { subscriber_id: subscriber } = began.body.data;
  // The first marketing message goes at once, so the cap holds the second for a week from then.
  await expect
    .poll(async () => {
      const sends = await api(page, `/api/subscribers/${subscriber}/sends?per_page=100`);
      return sends.body.data.results.some((send) => send.status === "sent");
    })
    .toBe(true);

  await page.goto(`/admin/subscribers/${subscriber}/enrollments`);
  await expect(page.getByTestId("enrollment-held").first()).toContainText(
    "Held by frequency cap until ",
  );
});

// B127 r2: the sends whose sent time is missing or whose subject the thirty-day retention dropped say
// so. The pass cannot run in a test, so the payload of a finished send is cleared as the pass clears
// it; the address and the status stay, and the send log must read the same as after a real pass.
test("a sent send past the thirty-day retention says its subject is no longer kept", async ({
  page,
}) => {
  await signIn(page);
  const list = await audience(page);
  const email = `${unique("op")}@example.com`;
  const { subscriber, subject } = await started(page, list, email);
  let sendID = null;
  await expect
    .poll(async () => {
      const sends = await api(page, `/api/subscribers/${subscriber}/sends?per_page=100`);
      sendID = sends.body.data.results.find((send) => send.status === "sent")?.id ?? null;
      return sendID;
    })
    .not.toBeNull();
  const db = new DatabaseSync(join(process.env.E2E_DATA_DIR, "iglo-email.db"), { timeout: 5000 });
  try {
    db.prepare("UPDATE sends SET payload = NULL WHERE id = ?").run(sendID);
  } finally {
    db.close();
  }

  await page.goto("/admin/sends");
  const row = page.locator(`[data-testid="send-row"][data-id="${sendID}"]`);
  await expect(row).toContainText("Subject no longer kept (30-day retention)");
  await expect(row).not.toContainText(subject);
  await expect(row).toContainText(email);
  await expect(row.locator('td[data-label="Sent"]')).not.toHaveText("—");
  await page.goto(`/admin/subscribers/${subscriber}/sends`);
  await expect(page.getByTestId("send-row").first()).toContainText(
    "Subject no longer kept (30-day retention)",
  );
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
  // A send that did not go out has no sent time: its Sent cell is a dash, never its creation time.
  await expect(skipped.locator('td[data-label="Sent"]')).toHaveText("—");
  const wipedRow = sent.body.data.sends[0].id;
  const wiped = page.locator(`[data-testid="send-row"][data-id="${wipedRow}"]`);
  await expect(wiped).toContainText("Removed (data wiped)");
  await expect(wiped).not.toContainText(tx.subject);
  // The template still names the send, though its payload and address are gone.
  await expect(wiped).toContainText(tx.name);

  // The subscriber's own sends tab shows the same dash for a send that never went out (B127 r2).
  await page.goto(`/admin/subscribers/${id}/sends`);
  await expect(page.getByTestId("send-row").first().locator('td[data-label="Sent"]')).toHaveText(
    "—",
  );
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // B127 r2: a value that wraps on a phone reads from the left under its label, every line from the
  // same edge (a right-aligned wrap would start each line further in).
  test("a wrapped value in a card starts every line at the same left edge", async ({ page }) => {
    await signIn(page);
    const list = await audience(page);
    const tx = await template(page);
    const event = unique("op-wrap");
    const made = await api(page, "/api/sequences", "POST", {
      name: `${unique("Onboarding")} for everyone who joins the operator news list this season`,
      status: "active",
      trigger: { event },
      reentry: "always",
      list_id: list.id,
      steps: [{ wait: "P1D", kind: "transactional", template_id: tx.id }],
    });
    expect(made.status).toBe(200);
    const began = await api(page, "/api/subscriber-events", "POST", {
      subscriber: { email: `${unique("op")}@example.com`, name: "Wrap", grant_lists: [list.id] },
      name: event,
    });
    expect(began.status).toBe(200);
    await page.goto(`/admin/subscribers/${began.body.data.subscriber_id}/enrollments`);
    const sequence = page.getByTestId("enrollment-row").first().locator("td").nth(1);
    await expect(sequence).toContainText("for everyone who joins");
    const lines = await sequence.evaluate((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const leftOf = new Map();
      for (const rect of range.getClientRects()) {
        if (rect.width === 0) {
          continue;
        }
        const top = Math.round(rect.top);
        leftOf.set(top, Math.min(leftOf.get(top) ?? Infinity, Math.round(rect.left)));
      }
      return [...leftOf.values()];
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(new Set(lines).size).toBe(1);
  });

  // B127 r2: the send log's card names the column the table's header names.
  test("the send log's card for a sequence send is labelled Sequence / template", async ({
    page,
  }) => {
    await signIn(page);
    const list = await audience(page);
    const email = `${unique("op")}@example.com`;
    const { sequence } = await started(page, list, email);
    await page.goto("/admin/sends");
    const row = page.getByTestId("send-row").filter({ hasText: email });
    await expect(row).toHaveCount(1);
    const cell = row.locator("td").filter({ hasText: `${sequence.name}, step 1` });
    const label = await cell.evaluate((td) => getComputedStyle(td, "::before").content);
    expect(label).toBe('"Sequence / template"');
  });

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
