// Native screens with no upstream spec (docs/design/05-sequences.md#admin-ui). Test mode runs the
// compiled executable's real scheduler to the SMTP sink, so its one-minute wait is a real minute.
import { expect } from "@playwright/test";
import {
  api,
  confirm,
  createUser,
  login,
  logout,
  mailFor,
  PASSWORD,
  test,
  unique,
} from "../helpers.js";

const hostile = (kind) =>
  `<img src=x onerror="window.pwned='${kind}'"> "'\` {{ 7*7 }} x-on:click="window.pwned=1" ${unique(kind)}`;

async function template(page, subject = "Welcome") {
  const made = await api(page, "/api/templates", "POST", {
    name: unique("tx"),
    type: "tx",
    subject,
    body: "<p>{{ subscriber.name }}</p>",
  });
  expect(made.status).toBe(200);
  return made.body.data;
}
async function sequence(page, definition) {
  const made = await api(page, "/api/sequences", "POST", {
    name: unique("seq"),
    status: "active",
    trigger: { event: unique("evt") },
    ...definition,
  });
  expect(made.status).toBe(200);
  return made.body.data;
}
async function subscriber(page, extra = {}) {
  const email = `${unique("seq")}@example.com`;
  const made = await api(page, "/api/subscribers", "POST", {
    email,
    name: "Sequence Reader",
    status: "enabled",
    lists: [],
    ...extra,
  });
  expect(made.status).toBe(200);
  return made.body.data;
}

test("test mode advances on the timeline, to the sink, leaving the definition alone", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page);
  const tx = await template(page);
  const seq = await sequence(page, {
    steps: [
      { wait: "PT0S", kind: "transactional", template_id: tx.id },
      { wait: "P3D", kind: "transactional", template_id: tx.id },
    ],
  });
  const person = await subscriber(page);
  await page.goto(`/admin/sequences/${seq.id}`);
  await page.getByTestId("btn-test-mode").click();
  await expect(page.getByTestId("test-warning")).toContainText("sends real mail");
  await page.getByTestId("test-subscriber").fill(person.email);
  await page.getByTestId("btn-test-start").click();

  await page.waitForURL(/\/admin\/sequences\/enrollments\/\d+$/);
  const id = page.url().split("/").pop();
  await expect(page.getByTestId("test-badge")).toBeVisible();
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toContainText("Step 1 (Transactional)", { timeout: 30_000 });
  await expect(timeline).toContainText("Waiting for step 2");
  const [first] = await mailFor(person.email);
  expect(first.subject).toBe("[Test] Welcome");

  // A wait of three days is at most a minute; the page follows without a reload.
  await expect(page.locator('[data-testid="timeline-entry"][data-type="ended"]')).toContainText(
    "Completed",
    { timeout: 120_000 },
  );
  const mails = await mailFor(person.email, 2);
  expect(mails.map((m) => m.subject)).toEqual(["[Test] Welcome", "[Test] Welcome"]);

  const after = await api(page, `/api/sequences/${seq.id}`);
  expect(after.body.data.steps.map((s) => s.wait)).toEqual(["PT0S", "P3D"]);
  expect(after.body.data.updated_at).toBe(seq.updated_at);

  // Marked in the explorer, left out of the counts.
  await page.goto(`/admin/sequences/enrollments?sequence_id=${seq.id}`);
  const row = page.locator(`[data-testid="enrollment-row"][data-id="${id}"]`);
  await expect(row.getByTestId("test-badge")).toBeVisible();
  await page.goto("/admin/sequences");
  const listed = page.locator(`[data-testid="sequence-row"][data-id="${seq.id}"]`);
  await expect(listed.getByTestId("enrollment-counts")).toContainText("Completed 0");
  await expect(listed.getByTestId("step-counts").locator("tbody tr").first()).toContainText("0");
});

test("a person without consent is refused in the dialog", async ({ page }) => {
  await login(page);
  const tx = await template(page);
  const list = await api(page, "/api/lists", "POST", {
    name: unique("consent"),
    type: "public",
    optin: "double",
  });
  const seq = await sequence(page, {
    list_id: list.body.data.id,
    steps: [{ wait: "PT0S", kind: "marketing", template_id: tx.id }],
  });
  const person = await subscriber(page);
  await page.goto(`/admin/sequences/${seq.id}`);
  await page.getByTestId("btn-test-mode").click();
  await page.getByTestId("test-subscriber").fill(String(person.id));
  await page.getByTestId("btn-test-start").click();
  await expect(page.getByTestId("test-error")).toContainText("not_subscribed");
  const enrolled = await api(page, `/api/enrollments?sequence_id=${seq.id}`);
  expect(enrolled.body.data.total).toBe(0);
});

test("the editor saves what it shows, keeps what it hides and shows a refusal", async ({
  page,
}) => {
  await login(page);
  const tx = await template(page);
  await page.goto("/admin/sequences/new");
  const name = unique("made");
  await page.getByTestId("sequence-name-input").fill(name);
  await page.getByTestId("trigger-event").fill(unique("evt"));
  await page.getByTestId("step-template").selectOption(String(tx.id));
  await page.getByTestId("step-wait").fill("nonsense");
  await page.getByTestId("btn-save").click();
  // The API's own words, in the page, and nothing was created.
  await expect(page.getByTestId("error")).toContainText("steps.0.wait");
  await page.getByTestId("step-wait").fill("P1D");
  await page.getByTestId("btn-save").click();
  await page.waitForURL(/\/admin\/sequences\/\d+$/);
  const id = page.url().split("/").pop();

  // Fields the form does not show survive a save.
  const stored = await api(page, `/api/sequences/${id}`);
  const step = stored.body.data.steps[0];
  const changed = await api(page, `/api/sequences/${id}`, "PUT", {
    ...stored.body.data,
    steps: [{ ...step, subject: "Kept subject", cap_policy: "skip", max_late: "PT6H" }],
  });
  expect(changed.status).toBe(200);
  await page.reload();
  await page.getByTestId("step-example").selectOption({ label: "Attribute compare" });
  await page.getByTestId("btn-add-step").click();
  await page.getByTestId("step-template").nth(1).selectOption(String(tx.id));
  await page.getByTestId("btn-save").click();
  await expect(page.getByTestId("step-card")).toHaveCount(2);
  const saved = (await api(page, `/api/sequences/${id}`)).body.data;
  expect(saved.steps[0]).toMatchObject({
    id: step.id,
    subject: "Kept subject",
    cap_policy: "skip",
    max_late: "PT6H",
    condition: { attr: "plan", op: "eq", value: "subscription" },
  });
  expect(saved.status).toBe("draft");

  // A condition that is not JSON stops in the page; one the API refuses shows its message.
  const editor = page.locator(".step-card .cm-content").first();
  await editor.fill("{ not json");
  await page.getByTestId("btn-save").click();
  await expect(page.getByTestId("error")).toContainText("not valid JSON");
  await editor.fill('{"attr": "plan", "op": "nope", "value": 1}');
  await page.getByTestId("btn-save").click();
  await expect(page.getByTestId("error")).toContainText("steps.0.condition");

  await page.reload();
  await page.getByTestId("btn-activate").click();
  await expect(page.getByTestId("sequence-status")).toContainText("Active");
});

test("live enrollments are named before a save, and a viewer without SQL is refused it", async ({
  page,
}) => {
  await login(page);
  const tx = await template(page);
  const seq = await sequence(page, {
    reentry: "always",
    steps: [{ wait: "P1D", kind: "transactional", template_id: tx.id }],
  });
  const person = await subscriber(page);
  const made = await api(page, "/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: person.id,
  });
  expect(made.status).toBe(200);
  await page.goto(`/admin/sequences/${seq.id}`);
  await expect(page.getByTestId("live-warning")).toContainText("Active enrollments: 1");
  await expect(page.getByTestId("live-warning")).toContainText("Times already scheduled stay");
  await page.getByTestId("step-wait").fill("P2D");
  await page.getByTestId("btn-save").click();
  await expect(page.locator("dialog[open]")).toContainText("Active enrollments: 1");
  await confirm(page);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("step-wait")).toHaveValue("P2D");
  const row = (await api(page, `/api/enrollments/${made.body.data.id}`)).body.data;
  expect(row.due_at).toBe(made.body.data.due_at);

  const user = await createUser(page, ["sequences:get", "sequences:manage", "templates:get"]);
  await logout(page);
  await login(page, user.username, "e2e-user-password", `/admin/sequences/${seq.id}`);
  await page.locator(".step-card .cm-content").first().fill('{"sql": "subscribers.id > 0"}');
  await page.getByTestId("btn-save").click();
  await confirm(page);
  await expect(page.getByTestId("error")).toContainText("condition");
});

test("the explorer filters, pages, enrolls and cancels", async ({ page }) => {
  await login(page);
  const tx = await template(page);
  const seq = await sequence(page, {
    reentry: "always",
    steps: [{ wait: "P1D", kind: "transactional", template_id: tx.id }],
  });
  const people = [];
  for (let i = 0; i < 21; i += 1) {
    const person = await subscriber(page);
    people.push(person);
    expect(
      (
        await api(page, "/api/enrollments", "POST", {
          sequence_id: seq.id,
          subscriber_id: person.id,
        })
      ).status,
    ).toBe(200);
  }
  await page.goto(`/admin/sequences/enrollments?sequence_id=${seq.id}`);
  await expect(page.getByTestId("enrollment-row")).toHaveCount(20);
  await page.locator("nav.pagination a", { hasText: "2" }).click();
  await expect(page.getByTestId("enrollment-row")).toHaveCount(1);

  await page.goto("/admin/sequences/enrollments");
  await page.getByTestId("filter-sequence").selectOption(String(seq.id));
  await page.getByTestId("filter-subscriber").fill(people[3].email);
  await page.getByTestId("btn-filter").click();
  await expect(page.getByTestId("enrollment-row")).toHaveCount(1);
  await page.getByTestId("enrollment-row").getByTestId("btn-cancel").click();
  await confirm(page);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("enrollment-row")).toContainText("Canceled");
  await page.getByTestId("filter-subscriber").fill("");
  await page.getByTestId("filter-status").selectOption("canceled");
  await page.getByTestId("filter-exit-reason").fill("manual");
  await page.getByTestId("btn-filter").click();
  await expect(page.getByTestId("enrollment-row")).toHaveCount(1);

  const person = await subscriber(page);
  await page.getByTestId("btn-enroll").click();
  await page.getByTestId("enroll-sequence").selectOption(String(seq.id));
  await page.getByTestId("enroll-subscriber").fill(person.email);
  await page.getByTestId("btn-enroll-submit").click();
  await page.waitForURL(/\/admin\/sequences\/enrollments\/\d+$/);
  await expect(page.getByTestId("timeline")).toContainText("Waiting for step 1");
});

test("the subscriber page shows that person's events, enrollments and sends", async ({ page }) => {
  await login(page);
  const tx = await template(page);
  const eventName = unique("evt");
  await sequence(page, {
    trigger: { event: eventName },
    steps: [{ wait: "PT0S", kind: "transactional", template_id: tx.id }],
  });
  const email = `${unique("tabs")}@example.com`;
  const sent = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email, name: "Tabs" },
    name: eventName,
    data: { plan: "pro" },
  });
  expect(sent.status).toBe(200);
  await mailFor(email);
  const id = sent.body.data.subscriber_id;
  await page.goto(`/admin/subscribers/${id}/events`);
  await expect(page.getByTestId("event-row")).toContainText(eventName);
  await expect(page.getByTestId("event-row")).toContainText('"plan": "pro"');
  await page.getByRole("tab", { name: "Enrollments" }).click();
  await expect(page.getByTestId("enrollment-row")).toHaveCount(1);
  await page.getByRole("tab", { name: "Sends" }).click();
  await expect(page.getByTestId("send-row")).toContainText(email);
});

test("hostile names, event data and attributes render as text", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const tx = await template(page);
  const name = hostile("sequence");
  const eventName = unique("evt");
  const seq = await sequence(page, {
    name,
    trigger: { event: eventName },
    exit_on: ["stop"],
    steps: [{ wait: "P1D", kind: "transactional", template_id: tx.id }],
  });
  const payload = hostile("payload");
  const attribute = hostile("attribute");
  const email = `${unique("hostile")}@example.com`;
  const made = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email, name: hostile("subscriber"), attribs: { note: attribute } },
    name: eventName,
    data: { [hostile("key")]: payload },
  });
  expect(made.status).toBe(200);
  const enrollment = made.body.data.enrollments.started[0].id;
  const subscriberID = made.body.data.subscriber_id;
  await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email },
    name: "stop",
  });

  const clean = async () => {
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    expect(await page.locator("section img, section b").count()).toBe(0);
    expect(errors).toEqual([]);
  };
  await page.goto("/admin/sequences");
  await expect(page.locator(`[data-testid="sequence-row"][data-id="${seq.id}"]`)).toContainText(
    name,
  );
  await clean();
  await page.goto(`/admin/sequences/${seq.id}`);
  await expect(page.getByTestId("sequence-name")).toHaveText(name);
  await clean();
  await page.goto(`/admin/sequences/enrollments?sequence_id=${seq.id}`);
  await expect(page.getByTestId("enrollment-row")).toContainText(name);
  await clean();
  await page.goto(`/admin/sequences/enrollments/${enrollment}`);
  await expect(page.getByTestId("timeline-data")).toContainText("onerror");
  await expect(page.getByTestId("timeline-sequence")).toHaveText(name);
  await clean();
  await page.goto(`/admin/subscribers/${subscriberID}/events`);
  await expect(page.getByTestId("event-row").first()).toBeVisible();
  await clean();
  await page.goto(`/admin/subscribers/${subscriberID}/enrollments`);
  await expect(page.getByTestId("enrollment-row")).toContainText(name);
  await clean();
  await page.goto(`/admin/subscribers/${subscriberID}/edit`);
  await expect(page.locator('textarea[name="attribs"]')).toHaveValue(/onerror/);
  await clean();
});

test("an enrollment hides its person from a viewer who can't read them", async ({ page }) => {
  await login(page);
  const seq = await sequence(page, {
    steps: [{ wait: "P1D", kind: "transactional", template_id: (await template(page)).id }],
  });
  const email = `${unique("private")}@example.com`;
  const street = unique("street");
  const made = await api(page, "/api/subscriber-events", "POST", {
    subscriber: { email },
    name: seq.trigger.event,
    data: { address: street },
  });
  expect(made.status).toBe(200);
  const enrollment = made.body.data.enrollments.started[0].id;
  await page.goto(`/admin/sequences/enrollments/${enrollment}`);
  await expect(page.getByTestId("timeline-data")).toContainText(street);
  await expect(
    page.locator(`a[href="/admin/subscribers/${made.body.data.subscriber_id}"]`),
  ).toHaveText(email);
  await expect(page.getByTestId("timeline-note")).toContainText("Only sends are recorded");
  await expect(page.getByTestId("timeline-hidden")).toHaveCount(0);

  const viewer = await createUser(page, ["sequences:get"]);
  await logout(page);
  await login(page, viewer.username, PASSWORD, `/admin/sequences/enrollments/${enrollment}`);
  await expect(page.getByTestId("timeline")).toContainText("Waiting for step 1");
  await expect(page.getByTestId("timeline-hidden")).toContainText("can't read this subscriber");
  await expect(page.getByTestId("timeline-data")).toHaveCount(0);
  await expect(page.locator("section.enrollments")).not.toContainText(email);
  await expect(page.locator("section.enrollments")).not.toContainText(street);
  await page.goto(`/admin/sequences/enrollments?sequence_id=${seq.id}`);
  await expect(page.getByTestId("enrollment-row")).toContainText(
    `#${made.body.data.subscriber_id}`,
  );
  await expect(page.getByTestId("enrollment-row")).not.toContainText(email);
});

test("template previews stay in the sandboxed frame", async ({ page }) => {
  await login(page);
  const made = await api(page, "/api/templates", "POST", {
    name: unique("hostile-tx"),
    type: "tx",
    subject: "s",
    body: `<img src=x onerror="parent.pwned=1"><script>parent.pwned=1</script>`,
  });
  const seq = await sequence(page, {
    status: "draft",
    steps: [{ wait: "PT0S", kind: "transactional", template_id: made.body.data.id }],
  });
  await page.goto(`/admin/sequences/${seq.id}`);
  await page.getByTestId("btn-step-preview").click();
  const frame = page.locator(".preview-modal iframe");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("src", /\/api\/templates\/\d+\/preview/);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});
