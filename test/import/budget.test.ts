// M1.9 webhook budget under live changes, with the real batch size and budget. The injected clock
// holds an import between batches, so another administrator's change lands at a known row.
import { afterEach, expect, test } from "bun:test";
import { createImporter } from "@/subscribers/import/importer";
import { registerImportRoutes } from "@/subscribers/import/routes";
import { txFixture, type TxFixture } from "@/test/tx/fixture";
import { startReceiver } from "@/test/webhooks/receiver";
import { MAX_BULK_DELIVERIES } from "@/webhooks/effects";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const ROWS = 3000;
const consent = ["subscriber.unsubscribed", "subscriber.blocklisted"];

async function open() {
  const f = await txFixture({ webhooks: {} });
  cleanups.push(() => f.close());
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const importer = createImporter({
    dataDir: f.directory,
    clock: f.clock,
    logger: f.app.logger,
    i18n: f.app.i18n,
    store: f.owners.subscribers,
    touchLists() {},
    domainPolicy: () => ({ allow: [], block: [] }),
  });
  await importer.sweep();
  cleanups.push(async () => {
    const turning = setInterval(() => f.clock.advance(1), 1);
    await importer.close();
    clearInterval(turning);
  });
  registerImportRoutes(f.owners.router, { importer, roles: f.owners.roles, auth: f.auth });
  const hook = async (events: string[], enabled: boolean) => {
    const url = receiver.url();
    const created = await f.json("/api/webhooks", "POST", { url, events, enabled });
    expect(created.status).toBe(200);
    return created.body.data.id as number;
  };
  const created = await f.json("/api/lists", "POST", { name: "budget" });
  return { f, hook, list: created.body.data.id as number };
}
/** `ROWS` subscribers on `list`, the first `live` of them confirmed and the rest unsubscribed. */
function seed(f: TxFixture, list: number, live: number) {
  f.db.run(
    `WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < ?)
     INSERT INTO subscribers (uuid, email, name)
     SELECT lower(hex(randomblob(16))), 'seed' || n || '@example.test', 'Seed' FROM i`,
    [ROWS],
  );
  f.db.run(
    `INSERT INTO subscriber_lists (subscriber_id, list_id, status)
     SELECT id, ?, CASE WHEN id <= ? THEN 'confirmed' ELSE 'unsubscribed' END FROM subscribers`,
    [list, live],
  );
}
const file = `email\n${Array.from({ length: ROWS }, (_, i) => `seed${i + 1}@example.test\n`).join("")}`;
async function post(f: TxFixture, params: unknown) {
  const form = new FormData();
  form.append("params", JSON.stringify(params));
  form.append("file", new File([file], "budget.csv"));
  const response = await f.request("/api/import/subscribers", {
    method: "POST",
    headers: f.sessionHeaders,
    body: form,
  });
  expect(response.status).toBe(200);
}
const status = async (f: TxFixture) => (await f.json("/api/import/subscribers")).body.data;
/** Let batches through until `imported`, or the end. The import then waits on the clock. */
async function release(f: TxFixture, imported = Infinity) {
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(1)) {
    const current = await status(f);
    if (current.imported >= imported || !["importing", "stopping"].includes(current.status))
      return current;
    f.clock.advance(1);
  }
  throw new Error("Import did not reach the row");
}
const count = (f: TxFixture, sql: string) =>
  Number((f.db.query(`SELECT count(*) AS n FROM ${sql}`).get() as { n: bigint }).n);
const deliveries = (f: TxFixture) => count(f, "webhook_deliveries");
const logs = async (f: TxFixture) =>
  (await f.json("/api/import/subscribers/logs")).body.data as string;

test("a membership change during an import cannot carry it over the budget", async () => {
  const { f, hook, list } = await open();
  for (let i = 0; i < 20; i++) await hook(["subscriber.unsubscribed"], true);
  await f.crashWebhooks();
  seed(f, list, 100);
  await post(f, {
    mode: "subscribe",
    delim: ",",
    lists: [list],
    subscription_status: "unsubscribed",
    overwrite_subscription_status: true,
  });
  expect((await release(f, 100)).imported).toBe(100);
  expect(deliveries(f)).toBe(2000);
  // The file was admitted at 2,000 deliveries. Now every other row would really queue them.
  const ids = f.db.query("SELECT id FROM subscribers WHERE id > 100").all() as { id: bigint }[];
  const added = await f.json("/api/subscribers/lists", "PUT", {
    ids: ids.map(({ id }) => Number(id)),
    action: "add",
    target_list_ids: [list],
    status: "confirmed",
  });
  expect(added.status).toBe(200);

  const done = await release(f);
  expect(done).toMatchObject({ status: "failed", imported: 2500, total: ROWS });
  expect(await logs(f)).toContain("50,000");
  expect(deliveries(f)).toBe(MAX_BULK_DELIVERIES);
  // Every batch that stayed has all its webhooks, and the refused one wrote nothing.
  expect(count(f, "(SELECT DISTINCT subscriber_id FROM webhook_deliveries)")).toBe(2500);
  expect(count(f, "subscriber_lists WHERE status = 'unsubscribed'")).toBe(2500);
  expect(count(f, "subscriber_lists WHERE status = 'confirmed'")).toBe(500);
});

test("webhooks enabled during a blocklist import cannot carry it over the budget", async () => {
  const { f, hook, list } = await open();
  await hook(consent, true);
  const disabled: number[] = [];
  for (let i = 0; i < 19; i++) disabled.push(await hook(consent, false));
  await f.crashWebhooks();
  seed(f, list, ROWS);
  await post(f, { mode: "blocklist", delim: ",", lists: [] });
  expect((await release(f, 100)).imported).toBe(100);
  expect(deliveries(f)).toBe(200);
  for (const id of disabled)
    expect((await f.json(`/api/webhooks/${id}`, "PUT", { enabled: true })).status).toBe(200);

  // 200 for the first batch and 4,000 for each next one: a fourteenth would pass 50,000.
  const done = await release(f);
  expect(done).toMatchObject({ status: "failed", imported: 1300, total: ROWS });
  expect(await logs(f)).toContain("50,000");
  expect(deliveries(f)).toBe(48_200);
  expect(count(f, "(SELECT DISTINCT subscriber_id FROM webhook_deliveries)")).toBe(1300);
  expect(count(f, "subscribers WHERE status = 'blocklisted'")).toBe(1300);
  expect(count(f, "subscriber_lists WHERE status = 'unsubscribed'")).toBe(1300);
});
