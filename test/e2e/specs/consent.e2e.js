// Consent and unsubscribe from the mail, as a reader uses it (docs/design/13-e2e-coverage.md, E2).
// Not an upstream spec: listmonk's suite does not open the links its mails carry. Each test makes
// its own uniquely named lists, subscribers, templates, campaigns and sequences through the API,
// then takes every link it follows from the mail the SMTP sink received for its own address: the
// body a reader sees, or the List-Unsubscribe headers a mail client reads. No link is built from an
// API UUID, except where a test swaps a UUID on purpose to show that a wrong one changes nothing.
import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { api, ok, requestAdmin, settledMail, signIn, test, unique } from "../helpers.js";

const SUB_FORM = "/subscription/form";
const FINISH = { timeout: 30_000 };
// The scheduler's tick (src/scheduler/scheduler.ts, SCHEDULER_INTERVAL_MS).
const SCHEDULER_TICK_MS = 15_000;
// A sequence's second step is due this long after its first step runs. Long enough that an
// unsubscribe or blocklist made after the first mail lands before the step is due on a loaded host;
// short enough that the exit check, which waits past the due time, stays well under the timeout.
const SECOND_STEP = "PT30S";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OPTIN = new RegExp(`/subscription/optin/${UUID}$`, "i");
const UNSUBSCRIBE = new RegExp(`/(subscription/${UUID}|m/${UUID}/unsubscribe)/${UUID}$`, "i");

const address = (prefix) => `${unique(prefix)}@example.com`;
// A client address of its own, so the public pages' limits are not shared between tests.
const peer = () => `203.0.113.${1 + (randomBytes(1)[0] % 254)}`;

// A public list, so the subscription form offers it. Single opt-in unless the test says otherwise.
const list = (page, data = {}) =>
  ok(page, "/api/lists", "POST", {
    name: unique("Consent"),
    type: "public",
    optin: "single",
    ...data,
  });

async function reader(page, lists, { email = address("reader"), preconfirm = false } = {}) {
  return ok(page, "/api/subscribers", "POST", {
    email,
    name: "Consent Reader",
    status: "enabled",
    lists: lists.map((l) => l.id),
    ...(preconfirm ? { preconfirm_subscriptions: true } : {}),
  });
}

// The subscription status of one list for one subscriber, read through the admin API.
async function membership(page, person, target) {
  const current = await ok(page, `/api/subscribers/${person.id}`);
  return current.lists.find((l) => l.id === target.id)?.subscription_status;
}

async function campaign(page, lists, overrides = {}) {
  return ok(page, "/api/campaigns", "POST", {
    name: unique("Consent campaign"),
    subject: unique("Consent subject"),
    type: "regular",
    content_type: "html",
    body: '<p>Consent body</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
    lists: lists.map((l) => l.id),
    ...overrides,
  });
}

async function sendCampaign(page, c) {
  await ok(page, `/api/campaigns/${c.id}/status`, "PUT", { status: "running" });
  await expect
    .poll(async () => (await ok(page, `/api/campaigns/${c.id}`)).status, FINISH)
    .toBe("finished");
}

// A transactional template that a marketing send can use; its body carries the unsubscribe link
// the way a template author writes it.
async function marketingTemplate(page) {
  return ok(page, "/api/templates", "POST", {
    name: unique("Marketing"),
    type: "tx",
    subject: unique("Marketing subject"),
    body: '<p>Marketing news.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
  });
}

// One marketing mail to one subscriber on a list, sent through POST /api/tx.
async function marketingMail(page, target, email) {
  const template = await marketingTemplate(page);
  const sent = await api(page, "/api/tx", "POST", {
    kind: "marketing",
    list_id: target.id,
    template_id: template.id,
    subscriber_emails: [email],
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return template;
}

// A sequence on one list whose steps are marketing mails, and a subscriber enrolled in it by hand.
async function enrolled(page, target, person, steps) {
  const template = await marketingTemplate(page);
  const sequence = await ok(page, "/api/sequences", "POST", {
    name: unique("Consent sequence"),
    status: "active",
    trigger: { event: unique("evt") },
    list_id: target.id,
    steps: steps.map((wait) => ({ wait, kind: "marketing", template_id: template.id })),
  });
  return ok(page, "/api/enrollments", "POST", {
    sequence_id: sequence.id,
    subscriber_id: person.id,
  });
}

// The frequency cap lets a subscriber have one marketing mail per `marketing.min_interval` (P7D by
// default), and a sequence's second step is marketing too: at P7D the cap would hold it for a week
// whatever the unsubscribe did, and no later mail could ever be seen. The exit test shortens the
// interval to one second, so the step falls due and only its exit can stop it. The original value
// is kept here, and `afterEach` puts it back through the request fixture: a test that timed out has
// closed its page by then, so the setting never outlives the test.
let capped = null;
async function shortenMarketingCap(page) {
  capped = (await ok(page, "/api/settings"))["marketing.min_interval"];
  await ok(page, "/api/settings/marketing.min_interval", "PUT", "PT1S");
}
test.afterEach(async ({ request }) => {
  if (capped === null) return;
  const original = capped;
  capped = null;
  const call = await requestAdmin(request);
  const response = await call("/api/settings/marketing.min_interval", "PUT", original);
  expect(response.status).toBe(200);
});

// The enrollment once its first step has run: the step moves on when that step is sent, so the
// enrollment's step changing is the sign that it now waits on the second step's due time.
async function waitingOnSecondStep(page, started) {
  expect(started.step_id, "the enrollment starts on its first step").not.toBeNull();
  let waiting;
  await expect
    .poll(async () => {
      waiting = await ok(page, `/api/enrollments/${started.id}`);
      return waiting.step_id;
    }, FINISH)
    .not.toBe(started.step_id);
  expect(waiting).toMatchObject({ status: "active" });
  expect(waiting.due_at, "the second step has a due time").toBeTruthy();
  return waiting;
}

// Waits past the latest of the given steps' due times and two scheduler ticks after it, so the
// scheduler has run on each. The wait is bounded by the step's own wait, which is `SECOND_STEP`.
async function pastDueAndTwoTicks(...waiting) {
  const latest = Math.max(...waiting.map((item) => Date.parse(item.due_at)));
  const until = latest + 2 * SCHEDULER_TICK_MS;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
}

// Mail the sink received for one address, waited for up to `timeout`. A sequence step waits for
// the scheduler's next 15 s tick, so its wait is longer than `mailFor`'s.
async function mailsFor(email, count = 1, timeout = 60_000) {
  let mails = [];
  await expect(async () => {
    const response = await fetch(`${process.env.E2E_MAIL}?to=${encodeURIComponent(email)}`);
    mails = await response.json();
    expect(mails.length).toBeGreaterThanOrEqual(count);
  }).toPass({ timeout });
  return mails;
}

// Every absolute link in a mail body, with HTML's `&amp;` read as `&`, as a reader's click would.
const linksIn = (mail) =>
  [...mail.body.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) =>
    match[0].replaceAll("&amp;", "&"),
  );

const optinLink = (mail) => {
  const found = linksIn(mail).find((url) => OPTIN.test(new URL(url).pathname));
  expect(found, "the confirmation mail links to its opt-in page").toBeTruthy();
  return found;
};

// The unsubscribe link a reader sees: not the manage-preferences link, which has the same path.
const unsubscribeLink = (mail) => {
  const found = linksIn(mail).find(
    (url) => UNSUBSCRIBE.test(new URL(url).pathname) && !new URL(url).searchParams.has("manage"),
  );
  expect(found, "the mail links to an unsubscribe page").toBeTruthy();
  return found;
};

// The List-Unsubscribe header's URL, without the angle brackets RFC 2369 puts around it.
const listUnsubscribeURL = (mail) => {
  const url = /^<([^>]+)>$/.exec(mail.listUnsubscribe ?? "")?.[1];
  expect(url, "the mail carries a List-Unsubscribe header").toBeTruthy();
  return url;
};

// A request from outside the browser: no cookies, no token, the way a mail client sends one-click.
const outside = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": peer(),
    },
    body,
    redirect: "manual",
  });

// Open the page a mail linked to and submit its unsubscribe form, as a reader does.
async function unsubscribeInBrowser(page, url, { blocklist = false } = {}) {
  await page.goto(url);
  await expect(page.locator("#btn-unsub")).toBeVisible();
  if (blocklist) await page.locator("#privacy-blocklist").check();
  await page.locator("#btn-unsub").click();
  await expect(page.locator("body")).toContainText(/unsubscribed/i);
}

// The subscription form, filled in and submitted by someone who is not signed in. The form ticks
// every public list, so the lists not named are unticked: the person joins exactly `lists`.
async function subscribeThroughForm(page, { email, name, lists }) {
  await page.goto(SUB_FORM);
  await page.locator("input[name=email]").fill(email);
  await page.locator("input[name=name]").fill(name);
  const wanted = new Set(lists.map((target) => target.name));
  const offered = [];
  for (const item of await page.locator("ul.lists li").all()) {
    const label = (await item.locator("label").innerText()).trim();
    offered.push(label);
    const box = item.locator("input[type=checkbox]");
    if (wanted.has(label)) await box.check();
    else await box.uncheck();
  }
  expect(offered, "every named list is on the form").toEqual(expect.arrayContaining([...wanted]));
  // The handler answers with the pending text when a named list is double opt-in, else the other.
  const text = lists.some((target) => target.optin === "double")
    ? "An e-mail has been sent to you to confirm your subscription(s)."
    : "Subscribed successfully.";
  // The form posts to its own URL, so the page's URL does not change: wait for the POST's answer.
  const [response] = await Promise.all([
    page.waitForResponse(
      (answer) =>
        answer.request().method() === "POST" && new URL(answer.url()).pathname === SUB_FORM,
    ),
    page.locator("button[type=submit]").click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page.locator("body")).toContainText(text);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("the double opt-in mail's link confirms the subscription when the reader submits it", async ({
  page,
}) => {
  const optin = await list(page, { optin: "double" });
  const person = await reader(page, [optin]);
  const [mail] = await mailsFor(person.email);
  expect(mail.subject).toMatch(/confirm/i);
  expect(await membership(page, person, optin)).toBe("unconfirmed");

  await page.goto(optinLink(mail));
  await expect(page.locator("form.optin-form")).toBeVisible();
  await page.locator("form.optin-form button[type=submit]").click();
  await expect(page.locator("body")).toContainText(/confirmed/i);
  expect(await membership(page, person, optin)).toBe("confirmed");
});

test("opening the confirmation link shows the page and confirms nothing until it is submitted", async ({
  page,
}) => {
  const optin = await list(page, { optin: "double" });
  const person = await reader(page, [optin]);
  const [mail] = await mailsFor(person.email);

  await page.goto(optinLink(mail));
  await expect(page.locator("form.optin-form")).toBeVisible();
  await page.reload();
  await expect(page.locator("form.optin-form")).toBeVisible();
  expect(await membership(page, person, optin)).toBe("unconfirmed");
});

test("a wrong or unknown UUID on the opt-in and unsubscribe pages changes nothing and shows the error page", async ({
  page,
}) => {
  const optin = await list(page, { optin: "double" });
  const target = await list(page);
  const person = await reader(page, [optin, target]);
  const bystander = await reader(page, [target]);
  await marketingMail(page, target, person.email);
  await sendCampaign(page, await campaign(page, [target]));
  // The opt-in mail, the marketing mail and the campaign mail, in whatever order they arrived.
  const mails = await mailsFor(person.email, 3);
  const find = (text) => mails.find((mail) => mail.body.includes(text));
  const optinMail = mails.find((mail) =>
    linksIn(mail).some((url) => OPTIN.test(new URL(url).pathname)),
  );
  const marketing = find("Marketing news.");
  const campaignMail = find("Consent body");
  expect(optinMail && marketing && campaignMail).toBeTruthy();

  // The opt-in page with a UUID no subscriber has.
  const unknown = randomUUID();
  const optinURL = optinLink(optinMail).replace(person.uuid, unknown);
  const shown = await page.goto(optinURL);
  expect(shown.status()).toBe(404);
  await expect(page.locator("body")).toContainText(/not found/i);
  expect((await outside(optinURL, "confirm=true")).status).toBe(404);
  expect(await membership(page, person, optin)).toBe("unconfirmed");

  // The message page with a real subscriber's UUID: the pair must belong together.
  const swapped = unsubscribeLink(marketing).replace(person.uuid, bystander.uuid);
  expect((await page.goto(swapped)).status()).toBe(404);
  expect((await outside(swapped, "")).status).toBe(404);
  expect(await membership(page, person, target)).toBe("unconfirmed");
  expect(await membership(page, bystander, target)).toBe("unconfirmed");

  // The campaign page with an unknown subscriber UUID.
  const campaignURL = unsubscribeLink(campaignMail).replace(person.uuid, unknown);
  expect((await page.goto(campaignURL)).status()).toBe(404);
  expect((await outside(campaignURL, "")).status).toBe(404);
  expect(await membership(page, person, target)).toBe("unconfirmed");
  expect(await membership(page, bystander, target)).toBe("unconfirmed");
});

test("the unsubscribe link in a campaign mail ends that campaign's list and leaves the person's other list", async ({
  page,
}) => {
  const [first, second] = [await list(page), await list(page)];
  const person = await reader(page, [first, second]);
  await sendCampaign(page, await campaign(page, [first]));
  const [mail] = await mailsFor(person.email);

  await unsubscribeInBrowser(page, unsubscribeLink(mail));
  expect(await membership(page, person, first)).toBe("unsubscribed");
  expect(await membership(page, person, second)).not.toBe("unsubscribed");
});

test("the next campaign to that list skips the person, and one to the other list reaches them", async ({
  page,
}) => {
  const [first, second] = [await list(page), await list(page)];
  const person = await reader(page, [first, second]);
  await sendCampaign(page, await campaign(page, [first]));
  const [mail] = await mailsFor(person.email);
  await unsubscribeInBrowser(page, unsubscribeLink(mail));

  await sendCampaign(page, await campaign(page, [first]));
  expect(await settledMail([person.email])).toEqual([1]);
  await sendCampaign(page, await campaign(page, [second]));
  expect(await settledMail([person.email])).toEqual([2]);
});

test("a campaign mail's List-Unsubscribe headers unsubscribe with one plain POST, with no cookies or token", async ({
  page,
}) => {
  const target = await list(page);
  const person = await reader(page, [target]);
  await sendCampaign(page, await campaign(page, [target]));
  const [mail] = await mailsFor(person.email);
  expect(mail.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");

  const response = await outside(listUnsubscribeURL(mail), "List-Unsubscribe=One-Click");
  expect(response.status).toBe(200);
  expect(await membership(page, person, target)).toBe("unsubscribed");
});

test("the message page a marketing mail links to shows the unsubscribe form, and submitting it unsubscribes", async ({
  page,
}) => {
  const target = await list(page);
  const person = await reader(page, [target]);
  await marketingMail(page, target, person.email);
  const [mail] = await mailsFor(person.email);
  expect(mail.body).toContain("Marketing news.");
  expect(mail.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
  expect(listUnsubscribeURL(mail)).toBe(unsubscribeLink(mail));

  await unsubscribeInBrowser(page, unsubscribeLink(mail));
  expect(await membership(page, person, target)).toBe("unsubscribed");
});

test("a plain GET of the unsubscribe link, as a link scanner makes it, changes no membership", async ({
  page,
}) => {
  const target = await list(page);
  const person = await reader(page, [target]);
  await sendCampaign(page, await campaign(page, [target]));
  const [mail] = await mailsFor(person.email);
  const url = unsubscribeLink(mail);
  const before = await membership(page, person, target);

  // No cookies, no token, no script: the request a scanner sends when it follows the link.
  const scanned = await fetch(url, {
    redirect: "manual",
    headers: { "X-Forwarded-For": peer() },
  });
  expect(scanned.status).toBe(200);
  expect(await scanned.text()).toContain("btn-unsub");
  expect(await membership(page, person, target)).toBe(before);
  expect(before).not.toBe("unsubscribed");

  // The same link still works when the reader submits the form, so the GET above was not a 404.
  await unsubscribeInBrowser(page, url);
  expect(await membership(page, person, target)).toBe("unsubscribed");
});

test("blocklisting from the public page leaves the person with no mail from any of their lists", async ({
  page,
}) => {
  const [first, second] = [await list(page), await list(page)];
  const person = await reader(page, [first, second]);
  await sendCampaign(page, await campaign(page, [first, second]));
  const [mail] = await mailsFor(person.email);
  await unsubscribeInBrowser(page, unsubscribeLink(mail), { blocklist: true });

  expect(await ok(page, `/api/subscribers/${person.id}`)).toMatchObject({ status: "blocklisted" });
  await sendCampaign(page, await campaign(page, [first, second]));
  expect(await settledMail([person.email])).toEqual([1]);
});

test("subscribing again through the form follows each list's opt-in rule", async ({ page }) => {
  const single = await list(page);
  const double = await list(page, { optin: "double" });
  const email = address("again");
  const person = await reader(page, [single, double], { email, preconfirm: true });
  await sendCampaign(page, await campaign(page, [single, double]));
  const [mail] = await mailsFor(email);
  await unsubscribeInBrowser(page, unsubscribeLink(mail));
  expect(await membership(page, person, double)).toBe("unsubscribed");

  await subscribeThroughForm(page, { email, name: "Consent Reader", lists: [single, double] });

  // A single opt-in list takes the subscriber back: the next campaign reaches them.
  expect(await membership(page, person, single)).not.toBe("unsubscribed");
  // A double opt-in list sends a new confirmation mail, which is the second mail the sink holds.
  const mails = await mailsFor(email, 2);
  const confirmation = mails.find((mail) =>
    linksIn(mail).some((url) => OPTIN.test(new URL(url).pathname)),
  );
  expect(confirmation, "a new confirmation mail").toBeTruthy();
  expect(confirmation.subject).toMatch(/confirm/i);
  expect(await membership(page, person, double)).toBe("unconfirmed");
  await sendCampaign(page, await campaign(page, [single]));
  expect(await settledMail([email])).toEqual([3]);
  await page.goto(optinLink(confirmation));
  await page.locator("form.optin-form button[type=submit]").click();
  await expect(page.locator("body")).toContainText(/confirmed/i);
  expect(await membership(page, person, double)).toBe("confirmed");
});

test("a sequence's marketing step reaches a confirmed person on a double opt-in list", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const target = await list(page, { optin: "double" });
  const person = await reader(page, [target], { preconfirm: true });
  expect(await membership(page, person, target)).toBe("confirmed");
  await enrolled(page, target, person, ["PT0S"]);
  const [mail] = await mailsFor(person.email, 1);
  expect(mail.body).toContain("Marketing news.");
  expect(mail.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
});

test("a sequence enrollment waiting on its next step exits when its person unsubscribes or is blocklisted through the mail", async ({
  page,
}) => {
  // Two people, two enrollments, one wait: each exit lands before its own second step is due, and
  // the wait runs past the later of the two due times, so each person's later mail is checked too.
  test.setTimeout(120_000);
  await shortenMarketingCap(page);
  const target = await list(page);
  const leaving = await reader(page, [target]);
  const blocked = await reader(page, [target]);
  // The second step falls due SECOND_STEP after the first runs. Each exit lands before that, so the
  // exit must end the step before the scheduler can send it: a later mail is the failure.
  const leavingStarted = await enrolled(page, target, leaving, ["PT0S", SECOND_STEP]);
  const blockedStarted = await enrolled(page, target, blocked, ["PT0S", SECOND_STEP]);
  const [leavingMail] = await mailsFor(leaving.email, 1);
  const [blockedMail] = await mailsFor(blocked.email, 1);
  const leavingWaiting = await waitingOnSecondStep(page, leavingStarted);
  const blockedWaiting = await waitingOnSecondStep(page, blockedStarted);

  await unsubscribeInBrowser(page, unsubscribeLink(leavingMail));
  await unsubscribeInBrowser(page, unsubscribeLink(blockedMail), { blocklist: true });
  expect(await ok(page, `/api/enrollments/${leavingStarted.id}`)).toMatchObject({
    status: "exited",
    exit_reason: "unsubscribed",
  });
  expect(await ok(page, `/api/enrollments/${blockedStarted.id}`)).toMatchObject({
    status: "exited",
    exit_reason: "blocklisted",
  });
  await pastDueAndTwoTicks(leavingWaiting, blockedWaiting);
  expect(await settledMail([leaving.email, blocked.email])).toEqual([1, 1]);
});
