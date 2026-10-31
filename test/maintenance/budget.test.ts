// The delivery budget of a maintenance delete under live webhook changes, with the real batch size
// and budget (D61). The clock the routes yield on stands where another administrator acts, so a
// change lands at a known batch.
import { afterEach, expect, test } from "bun:test";
import { createAnalyticsPurge } from "@/analytics/purge";
import { createLogBuffer } from "@/maintenance/log-buffer";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import { MAINTENANCE_SUBSCRIBERS as BATCH } from "@/subscribers/store";
import { txFixture } from "@/test/tx/fixture";
import { startReceiver } from "@/test/webhooks/receiver";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
/** With 19 webhooks this is the largest selection under 50,000 deliveries: 49,989. */
const SELECTED = 2631;

async function open(afterBatch: (left: number) => Promise<void>) {
  const f = await txFixture({ webhooks: {} });
  cleanups.push(() => f.close());
  const receiver = startReceiver();
  cleanups.push(() => receiver.close());
  const purge = createAnalyticsPurge(f.db, f.db);
  cleanups.push(() => purge.close());
  const count = (sql: string) =>
    Number((f.db.query(`SELECT count(*) AS n FROM ${sql}`).get() as { n: bigint }).n);
  const routes = registerMaintenanceRoutes(f.owners.router, {
    subscribers: f.owners.subscribers,
    analytics: purge,
    logs: createLogBuffer(f.clock),
    auth: f.auth,
    clock: {
      now: () => f.clock.now(),
      sleep: async () => {
        await afterBatch(count("subscribers"));
        await Bun.sleep(0);
      },
    },
    keepOpen: () => {},
    individualTracking: () => true,
  });
  cleanups.push(() => routes.close());
  const hook = async (enabled: boolean) => {
    const created = await f.json("/api/webhooks", "POST", {
      url: receiver.url(),
      events: ["subscriber.deleted"],
      enabled,
    });
    expect(created.status).toBe(200);
    return created.body.data.id as number;
  };
  for (let i = 0; i < 19; i++) await hook(true);
  const extra = await hook(false);
  await f.crashWebhooks();
  f.db.run(
    `WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < ?)
     INSERT INTO subscribers (uuid, email, name, status)
     SELECT lower(hex(randomblob(16))), 'seed' || n || '@example.test', 'Seed', 'blocklisted' FROM i`,
    [SELECTED],
  );
  const setExtra = async (enabled: boolean) =>
    expect((await f.json(`/api/webhooks/${extra}`, "PUT", { enabled })).status).toBe(200);
  const remove = () => f.json("/api/maintenance/subscribers/blocklisted", "DELETE");
  return { setExtra, remove, count };
}

test("a webhook enabled and disabled during a delete cannot carry it over the budget", async () => {
  let toggle = async (_left: number) => {};
  const { setExtra, remove, count } = await open((left) => toggle(left));
  toggle = async (left) => {
    if (left === SELECTED - BATCH) await setExtra(true);
    if (left === SELECTED - BATCH * 2) await setExtra(false);
  };

  // 1,900 + 2,000 = 3,900, then 1,900 a batch: 24 more reach 49,500, and the last 31 would pass.
  const stopped = await remove();
  expect(stopped.status).toBe(400);
  expect(stopped.body.message).toContain("50,089");
  expect(stopped.body.message).toContain("50,000");
  expect(count("webhook_deliveries")).toBe(49_500);
  // Every batch that stayed has all its webhooks, and the refused one wrote nothing.
  expect(count("subscribers")).toBe(SELECTED - BATCH * 26);
  expect(
    count("(SELECT subscriber_id FROM webhook_deliveries GROUP BY 1 HAVING count(*) = 19)"),
  ).toBe(BATCH * 25);

  // A repeat is a new action over what is left, with its own whole-selection check.
  const finished = await remove();
  expect(finished.status).toBe(200);
  expect(finished.body.data).toEqual({ count: 31 });
  expect(count("subscribers")).toBe(0);
  expect(count("webhook_deliveries")).toBe(49_500 + 31 * 19);
}, 60_000);

test("a selection over the budget is refused whole, before any write", async () => {
  const { setExtra, remove, count } = await open(async () => {});
  await setExtra(true);
  const refused = await remove();
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("52,620");
  expect(count("subscribers")).toBe(SELECTED);
  expect(count("webhook_deliveries")).toBe(0);
}, 60_000);
