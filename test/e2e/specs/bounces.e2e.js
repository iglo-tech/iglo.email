// Adapted from listmonk tests/specs/bounces.spec.js at 6fcd95f. Each test makes its own subscribers
// and a unique source instead of resetDB, so counts are read through a source filter. The bounce
// settings are read live here, so a test turns them on through the API. resetDB's complaint action
// is set the same way. Differences beside the cases below, with their rows in 07-api-and-ui.md.
import { expect } from "@playwright/test";
import { api, confirm, createUser, login, logout, openMenu, test, unique } from "../helpers.js";

const BOUNCES = "/admin/subscribers/bounces";

function bounceRow(page, email) {
  const rows = page.getByTestId("bounce-row");
  return email ? rows.filter({ hasText: email }) : rows;
}

async function ok(page, path, method = "GET", body = undefined) {
  const res = await api(page, path, method, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

let before;
async function enableBounces(page) {
  const settings = await ok(page, "/api/settings");
  before = settings;
  await ok(page, "/api/settings", "PUT", {
    ...settings,
    "bounce.enabled": true,
    "bounce.webhooks_enabled": true,
    "bounce.actions": {
      soft: { count: 2, action: "none" },
      hard: { count: 2, action: "blocklist" },
      complaint: { count: 1, action: "delete" },
    },
  });
}

async function makeList(page) {
  return ok(page, "/api/lists", "POST", { name: unique("bounces"), type: "private" });
}

async function makeSub(page, listID) {
  const email = `${unique("bounce")}@example.com`;
  return ok(page, "/api/subscribers", "POST", {
    email,
    name: email,
    status: "enabled",
    lists: [listID],
  });
}

// Register a bounce for an email via the webhook endpoint. The page's API call carries the same
// JSON an external caller sends.
async function postBounce(page, data) {
  await ok(page, "/webhooks/bounce", "POST", data);
}

async function subStatus(page, id) {
  const res = await api(page, `/api/subscribers/${id}`);
  return res.status === 200 ? res.body.data.status : null;
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await enableBounces(page);
});
// The run shares one database: a later spec expects bounces as this one found them.
test.afterEach(async ({ page, context }) => {
  // A test may end as a user who cannot write settings.
  await context.clearCookies();
  await login(page);
  const current = await ok(page, "/api/settings");
  const { "bounce.enabled": enabled, "bounce.webhooks_enabled": webhooks } = before;
  await ok(page, "/api/settings", "PUT", {
    ...current,
    "bounce.enabled": enabled,
    "bounce.webhooks_enabled": webhooks,
    "bounce.actions": before["bounce.actions"],
  });
});

test("applies bounce actions by type and lists what was recorded", async ({ page }) => {
  const list = await makeList(page);
  const [a, b] = [await makeSub(page, list.id), await makeSub(page, list.id)];
  const source = unique("api");

  // Soft bounces don't cross the threshold: the subscriber stays enabled.
  await postBounce(page, { source, type: "soft", email: a.email });
  await postBounce(page, { source, type: "soft", email: a.email });
  expect(await subStatus(page, a.id)).toBe("enabled");

  // Hard bounces blocklist.
  await postBounce(page, { source, type: "hard", email: a.email });
  await postBounce(page, { source, type: "hard", email: a.email });
  await expect.poll(() => subStatus(page, a.id)).toBe("blocklisted");

  // Complaints delete the subscriber outright.
  await postBounce(page, { source, type: "complaint", email: b.email });
  await expect.poll(() => subStatus(page, b.id)).toBeNull();

  // The complaint subscriber and its bounce were deleted. The blocklisted subscriber kept its
  // bounces up to the point it was blocklisted.
  await page.goto(`${BOUNCES}?source=${source}`);
  await expect(bounceRow(page).first()).toBeVisible();
  const count = await bounceRow(page).count();
  expect(count).toBeGreaterThan(0);
  await expect(bounceRow(page, a.email)).toHaveCount(count);
  await expect(bounceRow(page, b.email)).toHaveCount(0);
});

test("views a bounce record and deletes it", async ({ page }) => {
  const list = await makeList(page);
  const sub = await makeSub(page, list.id);
  const source = unique("api");
  await postBounce(page, { source, type: "soft", email: sub.email, meta: { reason: "mailbox" } });
  await postBounce(page, { source, type: "hard", email: sub.email });

  await page.goto(`${BOUNCES}?source=${source}`);
  await expect(bounceRow(page)).toHaveCount(2);
  const row = bounceRow(page).filter({ hasText: "Soft" });
  await openMenu(row);
  await row.getByTestId("btn-meta").click();
  await expect(page.locator("dialog[open] pre")).toContainText('"reason": "mailbox"');
  await page.locator("dialog[open] button").click();

  await openMenu(row);
  await row.getByTestId("btn-delete").click();
  await confirm(page);
  await expect(bounceRow(page)).toHaveCount(1);
});

test("source, type and campaign link to their filters, with paging", async ({ page }) => {
  const list = await makeList(page);
  const campaign = await ok(page, "/api/campaigns", "POST", {
    name: unique("Bounce target"),
    subject: "Bounce target",
    type: "regular",
    content_type: "html",
    body: "Test",
    lists: [list.id],
  });
  const source = `${unique("a b")}&c=d`;
  for (let i = 0; i < 22; i += 1) {
    const sub = await makeSub(page, list.id);
    await postBounce(page, {
      source,
      type: "soft",
      email: sub.email,
      campaign_uuid: campaign.uuid,
    });
  }
  await page.goto(BOUNCES);
  await page.goto(`${BOUNCES}?campaign_id=${campaign.id}`);
  await expect(page.locator(".page-title")).toContainText("(22)");
  await expect(bounceRow(page)).toHaveCount(20);
  await page.locator(".pagination").getByRole("link", { name: "2", exact: true }).click();
  await expect(bounceRow(page)).toHaveCount(2);

  await bounceRow(page).first().getByRole("link", { name: source }).click();
  await expect(page.locator(".page-title")).toContainText("(22)");
  await expect(page.locator(".filter-tag")).toContainText(source);
  await bounceRow(page).first().getByRole("link", { name: campaign.name }).last().click();
  await expect(page).toHaveURL(`${BOUNCES}?campaign_id=${campaign.id}`);
  await bounceRow(page).first().getByRole("link", { name: "Soft" }).click();
  await expect(page).toHaveURL(`${BOUNCES}?type=soft`);
});

test("hostile sources, meta and addresses render as text and stay exact filters", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const list = await makeList(page);
  const sub = await makeSub(page, list.id);
  const other = await makeSub(page, list.id);
  const marker = unique("source");
  // The spaces matter: a bulk action over the filter must not reach the source without them.
  const source = ` <img src=x onerror="window.pwned='source'"> ' x-on:click="pwned=1" ${marker} `;
  const trimmed = source.trim();
  const meta = {
    "<img src=x onerror=window.pwned=1>": `</pre><script>window.pwned=2</script>${marker}`,
  };
  await postBounce(page, { source, type: "soft", email: sub.email, meta });
  await postBounce(page, { source: trimmed, type: "soft", email: other.email });

  await page.goto(`${BOUNCES}?source=${encodeURIComponent(source)}`);
  const row = bounceRow(page, sub.email);
  await expect(bounceRow(page)).toHaveCount(1);
  await expect(row).toContainText("onerror");
  await expect(page.locator("main img:not(header img)")).toHaveCount(0);
  await expect(page.locator(".filter-tag")).toContainText("onerror");
  await openMenu(row);
  await row.getByTestId("btn-meta").click();
  await expect(page.locator("dialog[open] pre")).toContainText("<script>window.pwned=2");
  await page.locator("dialog[open] button").click();

  await page.locator("thead input[type=checkbox]").check();
  await page.getByTestId("btn-bulk-actions").click();
  await page.getByTestId("btn-delete-bounces").click();
  await confirm(page);
  await expect(bounceRow(page)).toHaveCount(0);
  const left = await ok(page, `/api/bounces?source=${encodeURIComponent(trimmed)}`);
  expect(left.total).toBe(1);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

test("select all across pages sends a source with its spaces, untrimmed", async ({ page }) => {
  const list = await makeList(page);
  const marker = unique("spaced");
  const source = `  ${marker}  `;
  // More than a page of the spaced source, and a bounce of the same source without its spaces.
  for (let i = 0; i < 23; i += 1) {
    const sub = await makeSub(page, list.id);
    await postBounce(page, { source, type: "soft", email: sub.email });
  }
  const other = await makeSub(page, list.id);
  await postBounce(page, { source: marker, type: "soft", email: other.email });

  await page.goto(`${BOUNCES}?source=${encodeURIComponent(source)}`);
  await expect(bounceRow(page)).toHaveCount(20);
  await page.locator("thead input[type=checkbox]").check();
  await page.getByTestId("btn-bulk-actions").click();
  await page.getByTestId("select-all-bounces").click();
  const sent = page.waitForRequest(
    (r) => r.method() === "DELETE" && r.url().includes("/api/bounces"),
  );
  await page.getByTestId("btn-delete-bounces").click();
  await confirm(page);
  expect(new URL((await sent).url()).searchParams.get("source")).toBe(source);
  await expect(bounceRow(page)).toHaveCount(0);
  expect((await ok(page, `/api/bounces?source=${encodeURIComponent(source)}`)).total).toBe(0);
  expect((await ok(page, `/api/bounces?source=${encodeURIComponent(marker)}`)).total).toBe(1);
});

test("a viewer sees no destructive action and the route needs bounces:get", async ({ page }) => {
  const list = await makeList(page);
  const sub = await makeSub(page, list.id);
  const source = unique("api");
  await postBounce(page, { source, type: "soft", email: sub.email });
  const viewer = await createUser(page, ["bounces:get"]);
  const none = await createUser(page, ["lists:get_all"]);
  await logout(page);

  await login(page, viewer.username, "e2e-user-password");
  await page.goto(`${BOUNCES}?source=${source}`);
  const row = bounceRow(page, sub.email);
  await expect(row).toBeVisible();
  await openMenu(row);
  await expect(row.getByTestId("btn-meta")).toBeVisible();
  await expect(row.getByTestId("btn-delete")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator("thead input[type=checkbox]").check();
  await page.getByTestId("btn-bulk-actions").click();
  await expect(page.getByTestId("btn-delete-bounces")).toHaveCount(0);
  await expect(page.getByTestId("btn-manage-blocklist")).toHaveCount(0);
  await logout(page);

  await login(page, none.username, "e2e-user-password");
  const denied = await page.goto(BOUNCES);
  expect(denied.status()).toBe(403);
});

test("rejects invalid scopes, preserves explicit IDs, and uses bounce permissions for blocklisting", async ({
  page,
}) => {
  const list = await makeList(page);
  const subs = [await makeSub(page, list.id), await makeSub(page, list.id)];
  const source = unique("scope");
  for (const sub of subs) await postBounce(page, { source, type: "soft", email: sub.email });
  const bounces = (await ok(page, `/api/bounces?source=${source}`)).results;
  expect(bounces).toHaveLength(2);
  for (const url of ["?all=true&campaign_id=invalid", "?all=true&id=invalid", ""]) {
    expect((await api(page, `/api/bounces${url}`, "DELETE")).status).toBe(400);
  }
  expect((await api(page, "/api/bounces/blocklist?id=invalid", "PUT")).status).toBe(400);
  const absent = unique("missing");
  await ok(page, `/api/bounces?all=true&source=${absent}`, "DELETE");
  await ok(page, `/api/bounces/blocklist?source=${absent}`, "PUT");
  for (const sub of subs) expect(await subStatus(page, sub.id)).toBe("enabled");

  // Upstream calls with an API user's Basic credentials; a session of the same role gives the
  // same permission check, and the CSRF header api() sends.
  const manager = await createUser(page, ["bounces:get", "bounces:manage"]);
  await logout(page);
  await login(page, manager.username, "e2e-user-password");
  await ok(page, `/api/bounces/blocklist?id=${bounces[0].id}`, "PUT");
  await logout(page);
  await login(page);
  expect(await subStatus(page, bounces[0].subscriber_id)).toBe("blocklisted");
  expect(await subStatus(page, bounces[1].subscriber_id)).toBe("enabled");
  await ok(page, `/api/bounces?all=true&id=${bounces[0].id}`, "DELETE");
  const left = (await ok(page, `/api/bounces?source=${source}`)).results;
  expect(left.map((b) => b.id)).toEqual([bounces[1].id]);
});

for (const filter of [
  "source",
  "type",
  "campaign_id",
  "combined",
  "selected IDs",
  "deselected row",
]) {
  for (const action of ["delete", "blocklist"]) {
    test(`${action} preserves bounces and subscribers outside ${filter}`, async ({ page }) => {
      const list = await makeList(page);
      const campaign = await ok(page, "/api/campaigns", "POST", {
        name: "Bounce target",
        subject: "Bounce target",
        type: "regular",
        content_type: "html",
        body: "Test",
        lists: [list.id],
      });
      const target = unique("target");
      const elsewhere = unique("other");
      const targets = [];
      const outsiders = [];
      for (let i = 0; i < 25; i += 1) {
        const sub = await makeSub(page, list.id);
        const outside = i >= 22;
        const source = outside && ["source", "combined"].includes(filter) ? elsewhere : target;
        const type = outside && ["type", "combined"].includes(filter) ? "complaint" : "soft";
        const campaignUUID =
          outside && ["campaign_id", "combined"].includes(filter) ? "" : campaign.uuid;
        // The delete action would take the fixture away, so a complaint counts as nothing here.
        if (i === 0) {
          const settings = await ok(page, "/api/settings");
          await ok(page, "/api/settings", "PUT", {
            ...settings,
            "bounce.actions": {
              ...settings["bounce.actions"],
              complaint: { count: 1000, action: "none" },
            },
          });
        }
        await postBounce(page, {
          email: sub.email,
          source,
          type,
          campaign_uuid: campaignUUID,
        });
        (outside ? outsiders : targets).push(sub.id);
      }
      const all = async () => {
        const out = [];
        for (const source of [target, elsewhere]) {
          out.push(...(await ok(page, `/api/bounces?per_page=100&source=${source}`)).results);
        }
        return out;
      };
      await expect.poll(async () => (await all()).length).toBe(25);
      // Upstream's "selected" cases have the whole clean table; here the source scopes the page.
      const query = {
        source: `source=${target}`,
        type: "type=soft",
        campaign_id: `campaign_id=${campaign.id}`,
        combined: `source=${target}&type=soft&campaign_id=${campaign.id}`,
        "selected IDs": `source=${target}`,
        "deselected row": `source=${target}`,
      }[filter];
      await page.goto(`${BOUNCES}?${query}`);
      await expect(bounceRow(page)).toHaveCount(20);
      await page.locator("thead input[type=checkbox]").check();
      await page.getByTestId("btn-bulk-actions").click();
      if (filter !== "selected IDs") await page.getByTestId("select-all-bounces").click();
      if (filter === "deselected row") {
        await page.getByTestId("btn-bulk-actions").click();
        await bounceRow(page).first().locator("input[name=id]").uncheck();
        await page.getByTestId("btn-bulk-actions").click();
      }
      const selected = filter.includes("selected")
        ? await page
            .locator("input[name=id]:checked")
            .evaluateAll((els) => els.map((el) => Number(el.dataset.subscriberId)))
        : targets;
      await page
        .getByTestId(action === "delete" ? "btn-delete-bounces" : "btn-manage-blocklist")
        .click();
      const [res] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === (action === "delete" ? "DELETE" : "PUT"),
        ),
        // The screen reloads after a success; a read during that would lose its page.
        page.waitForEvent("load"),
        confirm(page),
      ]);
      expect(res.ok()).toBeTruthy();
      const bounces = await all();
      for (const id of [...targets, ...outsiders]) {
        const affected = selected.includes(id);
        expect(bounces.some((b) => b.subscriber_id === id)).toBe(action !== "delete" || !affected);
        expect(await subStatus(page, id)).toBe(
          action === "blocklist" && affected ? "blocklisted" : "enabled",
        );
      }
    });
  }
}
