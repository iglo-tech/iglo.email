import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnalyticsPurge } from "@/analytics/purge";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { createLogBuffer } from "@/maintenance/log-buffer";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import { MAINTENANCE_SUBSCRIBERS as BATCH } from "@/subscribers/store";

let f: CampaignsFixture;
let purge: ReturnType<typeof createAnalyticsPurge>;
let routes: ReturnType<typeof registerMaintenanceRoutes>;
let tracked = true;
let pump: ReturnType<typeof setInterval> | undefined;
beforeEach(async () => {
  f = await campaignsFixture();
  tracked = true;
  purge = createAnalyticsPurge(f.db, f.db);
  routes = registerMaintenanceRoutes(f.router, {
    subscribers: f.owners.subscribers,
    analytics: purge,
    logs: createLogBuffer(f.clock),
    auth: f.owners.auth,
    clock: f.clock,
    keepOpen: () => {},
    individualTracking: () => tracked,
  });
});
afterEach(async () => {
  clearInterval(pump);
  await routes.close();
  purge.close();
  await f.close();
});

const seed = (count: number, status = "enabled") =>
  f.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO subscribers (uuid, email, name, status)
    SELECT lower(hex(randomblob(16))), 's' || lower(hex(randomblob(8))) || '@example.test', 'n', '${status}' FROM n`);
const count = (sql: string) => Number((f.db.query(sql).get() as { n: bigint }).n);
/** Each batch awaits the injected clock; this stands in for the running event loop. */
const run = () => {
  pump = setInterval(() => f.clock.advance(0), 0);
};

test("a delete longer than one batch deletes all it selects, and only that", async () => {
  const list = await f.list("kept");
  const member = await f.subscriber("member@example.test", [list]);
  seed(BATCH * 2 + 3);
  run();
  const response = await f.json("/api/maintenance/subscribers/orphan", "DELETE");
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({ count: BATCH * 2 + 3 });
  expect(count("SELECT count(*) AS n FROM subscribers")).toBe(1);
  expect(count(`SELECT count(*) AS n FROM subscribers WHERE id = ${member.id}`)).toBe(1);
  expect(count("SELECT count(*) AS n FROM subscribers_fts")).toBe(1);
});

test("the server yields between batches, and stopping keeps what is done", async () => {
  seed(BATCH * 3);
  const pending = f.json("/api/maintenance/subscribers/orphan", "DELETE");
  await f.clock.whenSleeping();
  // One batch is committed and the writer is free for anything else.
  expect(count("SELECT count(*) AS n FROM subscribers")).toBe(BATCH * 2);
  f.db.run("BEGIN IMMEDIATE");
  f.db.run("COMMIT");
  const busy = await f.json("/api/maintenance/subscribers/blocklisted", "DELETE");
  expect(busy.status).toBe(429);
  const closing = routes.close();
  f.clock.advance(0);
  await closing;
  const stopped = await pending;
  expect(stopped.status).toBe(503);
  expect(count("SELECT count(*) AS n FROM subscribers")).toBe(BATCH * 2);
});

test("a date walk gets past rows it keeps", async () => {
  const list = await f.list("views");
  const camp = await f.campaign({ name: "c", subject: "s", lists: [list] });
  const old = "2000-01-01T00:00:00.000Z";
  f.db.run(
    `INSERT INTO sends (uuid, source, kind, to_email, status) VALUES ('u', 'tx', 'transactional', 'a@example.test', 'sent')`,
  );
  const send = count("SELECT id AS n FROM sends");
  // More rows of a send than a batch looks at, ahead of the rows to delete.
  f.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
    INSERT INTO campaign_views (send_id, created_at) SELECT ${send}, '${old}' FROM n`);
  f.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
    INSERT INTO campaign_views (campaign_id, created_at) SELECT ${camp.id}, '2000-01-02T00:00:00.000Z' FROM n`);
  run();
  const exported = await f.json(
    "/api/maintenance/analytics/views/export?since=1999-01-01T00:00:00Z",
  );
  expect((exported.body as string).trim().split("\n")).toHaveLength(11);
  const deleted = await f.json(
    "/api/maintenance/analytics/views?before_date=2000-02-01T00:00:00Z",
    "DELETE",
  );
  expect(deleted.status).toBe(200);
  expect(count("SELECT count(*) AS n FROM campaign_views WHERE campaign_id IS NOT NULL")).toBe(0);
  expect(count("SELECT count(*) AS n FROM campaign_views WHERE send_id IS NOT NULL")).toBe(2500);
});

test("an export stops with a client that goes away, and at most two run at once", async () => {
  const list = await f.list("views");
  const camp = await f.campaign({ name: "c", subject: "s", lists: [list] });
  f.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
    INSERT INTO campaign_views (campaign_id, created_at) SELECT ${camp.id}, '2000-01-01T00:00:00.000Z' FROM n`);
  const path = "/api/maintenance/analytics/views/export?since=1999-01-01T00:00:00Z";
  const get = () => f.request(path, { headers: f.sessionHeaders });
  const open = await Promise.all([get(), get()]);
  expect(open.map((r) => r.status)).toEqual([200, 200]);
  expect((await get()).status).toBe(429);
  for (const response of open) await response.body!.cancel();
  // The server sees the cancels when the connections close.
  for (let i = 0; i < 200; i++) {
    const again = await get();
    if (again.status === 200) {
      await again.body!.cancel();
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("export slots were not released");
});

test("an export with individual tracking off holds no subscriber", async () => {
  const list = await f.list("views");
  const ada = await f.subscriber("ada@example.test", [list]);
  const camp = await f.campaign({ name: "c", subject: "s", lists: [list] });
  f.db.run(
    `INSERT INTO campaign_views (campaign_id, subscriber_id) VALUES (${camp.id}, ${ada.id})`,
  );
  tracked = false;
  run();
  const response = await f.json(
    "/api/maintenance/analytics/views/export?since=1999-01-01T00:00:00Z",
  );
  const [, row] = (response.body as string).split("\n");
  expect(row).toStartWith(`${camp.id},${camp.uuid},c,0,,,,`);
});
