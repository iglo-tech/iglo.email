// Shared by the subscribers specs: the seed `reset`, the bulk-action steps and the filtered bulk
// action cases. Adapted from listmonk tests/specs/subscribers.spec.js at 6fcd95f, as the specs are.
// The cases run over several spec files, one per group of scopes, so independent stacks can take
// them in parallel (see test/e2e/run.ts). Each case makes its own data and needs nothing from the
// others.
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { api, confirm, selectList, test, signIn } from "./helpers.js";

export const SUBSCRIBERS = "/admin/subscribers";
export const SUB_NAMES = { john: "john@example.com", anon: "anon@example.com" };

export function subRow(page, text) {
  const rows = page.getByTestId("sub-row");
  return text ? rows.filter({ hasText: text }) : rows;
}

export function subRowIDs(page) {
  return page.getByTestId("sub-row").evaluateAll((els) => els.map((el) => Number(el.dataset.id)));
}

// The (filtered) total the listing header shows, e.g. "Subscribers (47)".
export const expectTotal = (page, n) =>
  expect(page.locator(".page-title")).toContainText(new RegExp(`\\(${n}\\)`));

export async function data(result) {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.data;
}

export async function reset(page) {
  for (const uri of ["/api/lists?all=true", "/api/lists?all=true&status=archived"])
    await data(await api(page, uri, "DELETE"));
  await data(await api(page, "/api/subscribers/query/delete", "POST", { all: true }));
  const list = (name, type, optin) =>
    api(page, "/api/lists", "POST", { name, type, optin, tags: ["test"] }).then(data);
  const defaultList = await list("Default list", "private", "single");
  const optinList = await list("Opt-in list", "public", "double");
  const subscriber = (email, name, lists, attribs) =>
    api(page, "/api/subscribers", "POST", {
      email,
      name,
      status: "enabled",
      lists,
      attribs,
    }).then(data);
  const john = await subscriber(SUB_NAMES.john, "John Doe", [defaultList.id], {
    city: "Bengaluru",
    good: true,
  });
  const anon = await subscriber(SUB_NAMES.anon, "Anon Doe", [optinList.id], {
    city: "Bengaluru",
    good: true,
  });
  return { LIST_DEFAULT: defaultList.id, LIST_OPTIN: optinList.id, JOHN: john.id, ANON: anon.id };
}

export async function seedSubscribers(
  page,
  n,
  { prefix = "seed", lists = [], status = "enabled" } = {},
) {
  // One round trip for all of them, in order; the first refusal is reported with its answer.
  const refused = await page.evaluate(
    async ([count, name, listIDs, state]) => {
      const csrf =
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("csrf="))
          ?.slice(5) ?? "";
      for (let i = 0; i < count; i += 1) {
        const response = await fetch("/api/subscribers", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({
            email: `${name}${i}@example.com`,
            name: `${name} ${i}`,
            status: state,
            lists: listIDs,
            attribs: { city: "Bengaluru", age: 20 + (i % 40) },
          }),
        });
        if (response.status !== 200)
          return { status: response.status, body: await response.text() };
      }
      return null;
    },
    [n, prefix, lists, status],
  );
  expect(refused, "seeding subscribers").toBeNull();
}

// Select rows and open the bulk-actions menu. With selectAll, promote the visible
// selection to the whole query (needs total > per-page for the button to render).
export async function openBulkMenu(page, { selectAll = false } = {}) {
  await expect(subRow(page).first()).toBeVisible();
  await page.locator("thead input[type=checkbox]").check();
  await page.getByTestId("btn-bulk-actions").click();
  if (selectAll) {
    await page.getByTestId("select-all-subscribers").click();
  }
}

export async function bulkManageLists(
  page,
  { action, lists, preconfirm = false, selectAll = false },
) {
  await openBulkMenu(page, { selectAll });
  await page.getByTestId("btn-manage-lists").click();

  const dialog = page.locator("dialog[open]");
  await dialog.getByTestId(`check-list-${action}`).check();
  for (const l of lists) {
    await selectList(dialog, l);
  }
  if (preconfirm) {
    await dialog.getByTestId("preconfirm").check();
  }

  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/subscribers(\/query)?\/lists/.test(r.url()) && r.request().method() === "PUT",
    ),
    page.waitForEvent("load"),
    dialog.locator("button[type=submit]").click(),
  ]);
}

// Trigger a confirm-guarded bulk action and wait for its API call.
export async function bulkConfirm(page, { testid, selectAll = false, match }) {
  await openBulkMenu(page, { selectAll });
  await page.getByTestId(testid).click();
  await Promise.all([page.waitForResponse(match), page.waitForEvent("load"), confirm(page)]);
}

export async function exportSelection(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.getByTestId("btn-export-subscribers").click();
      await confirm(page);
    })(),
  ]);
  return download;
}

export function filteredBulkActions(scopes) {
  test.describe("Subscribers: filtered bulk actions", () => {
    test.beforeEach(async ({ page }) => {
      await signIn(page);
    });

    for (const scope of scopes) {
      for (const action of ["delete", "blocklist", "export", "add", "remove", "unsubscribe"]) {
        test(`${action} applies only to subscribers matching the ${scope} filter`, async ({
          page,
        }) => {
          const { LIST_DEFAULT, LIST_OPTIN } = await reset(page);
          await data(await api(page, "/api/subscribers/query/delete", "POST", { all: true }));
          const status =
            scope === "status" && ["delete", "export"].includes(action)
              ? "blocklisted"
              : "disabled";
          const sourceList = scope === "subscription" ? LIST_OPTIN : LIST_DEFAULT;
          const targetList = sourceList === LIST_DEFAULT ? LIST_OPTIN : LIST_DEFAULT;
          await seedSubscribers(page, 22, {
            prefix: "target",
            status,
            lists: scope === "orphan" ? [] : [sourceList],
          });
          await seedSubscribers(page, 3, {
            prefix: "unrelated",
            lists: ["list", "list query params", "orphan", "query"].includes(scope)
              ? [LIST_OPTIN]
              : [sourceList],
          });
          const getSubscribers = async () =>
            (await data(await api(page, "/api/subscribers?per_page=100"))).results;
          if (scope === "subscription") {
            const ids = (await getSubscribers())
              .filter((s) => s.status === "enabled")
              .map((s) => s.id);
            await data(
              await api(page, "/api/subscribers/lists", "PUT", {
                ids,
                action: "add",
                target_list_ids: [sourceList],
                status: "confirmed",
              }),
            );
          }
          const before = await getSubscribers();
          const unrelated = before.filter((s) => s.status === "enabled");
          expect(unrelated).toHaveLength(3);
          const url = {
            status: `?status=${status}`,
            list: `/lists/${sourceList}`,
            orphan: "?subscription_status=none",
            search: "?search=target",
            query: `/lists/${sourceList}?query=${encodeURIComponent("subscribers.email LIKE 'target%' OR subscribers.status = 'enabled'")}`,
            subscription: "?subscription_status=unconfirmed",
            "list query params": `?list_id=${sourceList}`,
          }[scope];
          await page.goto(`${SUBSCRIBERS}${url}`);
          await expectTotal(page, 22);

          if (action === "delete" || action === "blocklist") {
            await bulkConfirm(page, {
              testid: action === "delete" ? "btn-delete-subscribers" : "btn-manage-blocklist",
              selectAll: true,
              match: (r) =>
                r.url().endsWith(`/api/subscribers/query/${action}`) &&
                r.request().method() === (action === "delete" ? "POST" : "PUT"),
            });
            if (action === "delete" || scope === "status")
              await expect(page.locator(".empty-state")).toBeVisible();
          } else if (action === "export") {
            await openBulkMenu(page, { selectAll: true });
            const download = await exportSelection(page);
            const csv = await readFile(await download.path(), "utf8");
            expect(csv.trim().split("\n")).toHaveLength(23);
            for (const sub of before)
              expect(csv.includes(sub.email)).toBe(sub.email.startsWith("target"));
          } else {
            await bulkManageLists(page, {
              action,
              lists: [
                (action === "add" ? targetList : sourceList) === LIST_DEFAULT
                  ? "Default list"
                  : "Opt-in list",
              ],
              preconfirm: action === "add" && targetList === LIST_OPTIN,
              selectAll: true,
            });
          }

          const after = await getSubscribers();
          expect(after.filter((s) => unrelated.some((u) => u.id === s.id))).toEqual(unrelated);
          const targets = after.filter((s) => s.email.startsWith("target"));
          expect(targets).toHaveLength(action === "delete" ? 0 : 22);
          for (const sub of targets) {
            if (action === "blocklist") expect(sub.status).toBe("blocklisted");
            if (action === "add") {
              expect(sub.lists.find((l) => l.id === targetList)?.subscription_status).toBe(
                targetList === LIST_OPTIN ? "confirmed" : "unconfirmed",
              );
            } else if (action === "remove") {
              expect(sub.lists.some((l) => l.id === sourceList)).toBe(false);
            } else if (action === "unsubscribe" && scope !== "orphan") {
              expect(sub.lists.find((l) => l.id === sourceList)?.subscription_status).toBe(
                "unsubscribed",
              );
            }
          }
        });
      }
    }
  });
}
