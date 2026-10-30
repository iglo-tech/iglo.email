// Behavior the real routes can only show with an injected clock or fixture rows: period
// boundaries, which period a unique count lands in, sequence-step grouping, the summary
// refresh loop and how reader failures surface. test/contract/analytics.ts covers the rest
// against both the reference and the compiled executable.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnalyticsReader, ReaderError } from "@/analytics/reader";
import { registerAnalyticsRoutes } from "@/analytics/routes";
import { dueBetween } from "@/analytics/schedule";
import { createSummaries, startSummaryRefresh } from "@/analytics/summaries";
import { createRouter } from "@/server/server";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";

const DAY = 86_400_000;
let f: CampaignsFixture;
let reader: ReturnType<typeof createAnalyticsReader>;
let summaries: ReturnType<typeof createSummaries>;
let headers: Record<string, string>;
const options = { cacheSlowQueries: false };
const wide = "from=2000-01-01&to=2099-01-01";

beforeEach(async () => {
  f = await campaignsFixture();
  headers = f.sessionHeaders;
  options.cacheSlowQueries = false;
  reader = createAnalyticsReader({ path: f.db.filename });
  summaries = createSummaries(f.db, f.clock, reader);
  registerAnalyticsRoutes(f.router, {
    reader,
    summaries,
    campaigns: f.owners.store,
    roles: f.owners.roles,
    auth: f.owners.auth,
    settings: () => ({
      individualTracking: f.settings.individualTracking,
      cacheSlowQueries: options.cacheSlowQueries,
    }),
  });
});
afterEach(async () => {
  await reader.close();
  summaries.close();
  await f.close();
});

const view = async (campaign: { uuid: string }, subscriber: { uuid: string }) =>
  expect((await f.request(`/campaign/${campaign.uuid}/${subscriber.uuid}/px.png`)).status).toBe(
    200,
  );
/** Sign in again after moving the clock past the session's lifetime. */
const relogin = async () => {
  const session = await f.owners.auth.login("fixture-admin", "fixture-admin-password");
  if (!session || !("id" in session)) throw new Error("login failed");
  headers = { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
};
const data = async (path: string) => {
  const response = await f.json(path, "GET", undefined, headers);
  expect(response.status).toBe(200);
  return response.body.data;
};

test("periods are UTC DATE_TRUNC, with weeks from Monday", async () => {
  const list = await f.list("news");
  const ada = await f.subscriber("ada@example.test", [list]);
  const camp = await f.campaign({ name: "c", subject: "s", lists: [list] });
  await view(camp, ada); // Friday 2026-01-02 03:04:05.
  f.clock.advance(3 * DAY); // Monday 2026-01-05.
  await view(camp, ada);
  await view(camp, ada);
  f.clock.advance(27 * DAY); // Sunday 2026-02-01.
  await view(camp, ada);
  await relogin();
  const rows = (interval: string, path = `campaigns/analytics/views?id=${camp.id}`) =>
    data(`/api/${path}&${wide}&interval=${interval}`);
  const row = (timestamp: string, count: number) => ({
    campaign_id: camp.id,
    count,
    timestamp,
  });
  expect(await rows("hour")).toEqual([
    row("2026-01-02T03:00:00Z", 1),
    row("2026-01-05T03:00:00Z", 2),
    row("2026-02-01T03:00:00Z", 1),
  ]);
  expect(await rows("day")).toEqual([
    row("2026-01-02T00:00:00Z", 1),
    row("2026-01-05T00:00:00Z", 2),
    row("2026-02-01T00:00:00Z", 1),
  ]);
  expect(await rows("week")).toEqual([
    row("2025-12-29T00:00:00Z", 1),
    row("2026-01-05T00:00:00Z", 2),
    row("2026-01-26T00:00:00Z", 1),
  ]);
  expect(await rows("month")).toEqual([
    row("2026-01-01T00:00:00Z", 3),
    row("2026-02-01T00:00:00Z", 1),
  ]);
  expect(await rows("week", `lists/analytics/views?id=${list}`)).toEqual([
    { list_id: list, campaign_id: 0, count: 1, timestamp: "2025-12-29T00:00:00Z" },
    { list_id: list, campaign_id: 0, count: 2, timestamp: "2026-01-05T00:00:00Z" },
    { list_id: list, campaign_id: 0, count: 1, timestamp: "2026-01-26T00:00:00Z" },
  ]);
  // from and to are inclusive, at millisecond precision.
  const edge = "2026-01-05T03:04:05";
  expect(
    await data(`/api/campaigns/analytics/views?id=${camp.id}&from=${edge}.000Z&to=${edge}.000Z`),
  ).toEqual([row("2026-01-05T00:00:00Z", 2)]);
  expect(
    await data(`/api/campaigns/analytics/views?id=${camp.id}&from=${edge}.001Z&to=${edge}.999Z`),
  ).toEqual([]);
});

test("a unique count lands in each subscriber's first period of the range", async () => {
  f.settings.individualTracking = true;
  const list = await f.list("news");
  const ada = await f.subscriber("ada@example.test", [list]);
  const bob = await f.subscriber("bob@example.test", [list]);
  const camp = await f.campaign({ name: "c", subject: "s", lists: [list] });
  await view(camp, ada);
  f.clock.advance(DAY);
  await view(camp, ada);
  await view(camp, bob);
  const unique = (interval: string, from = "2000-01-01") =>
    data(
      `/api/campaigns/analytics/views?id=${camp.id}&from=${from}&to=2099-01-01&unique=true&interval=${interval}`,
    );
  const row = (timestamp: string, count: number) => ({
    campaign_id: camp.id,
    count,
    timestamp,
  });
  expect(await unique("day")).toEqual([
    row("2026-01-02T00:00:00Z", 1),
    row("2026-01-03T00:00:00Z", 1),
  ]);
  // The same subscribers, one row: days of a week merge after DISTINCT ON.
  expect(await unique("week")).toEqual([row("2025-12-29T00:00:00Z", 2)]);
  // A view before the range does not move ada's first period.
  expect(await unique("day", "2026-01-03")).toEqual([row("2026-01-03T00:00:00Z", 2)]);
});

test("the chart window is 31 days up to the newest row, not up to today", async () => {
  const list = await f.list("news");
  const ada = await f.subscriber("ada@example.test", [list]);
  const camp = await f.campaign({ name: "c", subject: "s", lists: [list] });
  await view(camp, ada);
  f.clock.advance(DAY);
  await view(camp, ada);
  f.clock.advance(30 * DAY);
  await view(camp, ada);
  f.clock.advance(90 * DAY);
  await relogin();
  expect(await data("/api/dashboard/charts")).toEqual({
    link_clicks: [],
    campaign_views: [
      { count: 1, date: "2026-01-03" },
      { count: 1, date: "2026-02-02" },
    ],
  });
});

test("sends group by template and by sequence step; only sent ones count as sends", async () => {
  const { db, owners } = f;
  const at = f.clock.now().toISOString();
  const template = (name: string) =>
    (
      db
        .query(
          "INSERT INTO templates (name, type, subject, body) VALUES (?, 'tx', 's', 'b') RETURNING id",
        )
        .get(name) as { id: bigint }
    ).id;
  const receipt = template("receipt");
  const welcome = template("welcome");
  const { id: sequence } = db
    .query(
      `INSERT INTO sequences (uuid, name, trigger) VALUES ('q', 'Onboarding', '{"event":"x"}') RETURNING id`,
    )
    .get() as { id: bigint };
  const step = (position: number) =>
    (
      db
        .query(
          "INSERT INTO sequence_steps (uuid, sequence_id, position, wait, kind) VALUES (?, ?, ?, 'PT0S', 'marketing') RETURNING id",
        )
        .get(`step-${position}`, sequence, position) as { id: bigint }
    ).id;
  const first = step(1);
  const second = step(2);
  let n = 0;
  const send = (template: bigint, step: bigint | null, status = "sent") =>
    (
      db
        .query(
          "INSERT INTO sends (uuid, source, kind, to_email, template_id, step_id, status, created_at) VALUES (?, ?, 'transactional', 'a@example.test', ?, ?, ?, ?) RETURNING id",
        )
        .get(`s${++n}`, step ? "sequence" : "tx", template, step, status, at) as { id: bigint }
    ).id;
  const one = send(receipt, null);
  send(receipt, null, "failed");
  const two = send(welcome, first);
  const three = send(welcome, first);
  send(welcome, second);
  const linkId = owners.tracking.get(owners.tracking.link("https://example.test/")!)!.id;
  for (const id of [one, one, two, three, three]) owners.tracking.view(id, null);
  for (const id of [two, two]) owners.tracking.click(id, linkId, null);

  expect(await data(`/api/sends/analytics?${wide}`)).toEqual([
    {
      template_id: Number(receipt),
      template_name: "receipt",
      sends: 1,
      views: 2,
      unique_views: 1,
      clicks: 0,
      unique_clicks: 0,
    },
    {
      template_id: Number(welcome),
      template_name: "welcome",
      sends: 3,
      views: 3,
      unique_views: 2,
      clicks: 2,
      unique_clicks: 1,
    },
  ]);
  const row = (
    id: bigint,
    position: number,
    sends: number,
    views: number,
    uniqueViews: number,
  ) => ({
    step_id: Number(id),
    position,
    sequence_id: Number(sequence),
    sequence_name: "Onboarding",
    sends,
    views,
    unique_views: uniqueViews,
    clicks: position === 1 ? 2 : 0,
    unique_clicks: position === 1 ? 1 : 0,
  });
  expect(await data(`/api/sends/analytics?${wide}&group_by=step`)).toEqual([
    row(first, 1, 2, 3, 2),
    row(second, 2, 1, 0, 0),
  ]);
  // A deleted template keeps its numbers under a null group.
  db.run("DELETE FROM templates WHERE id = ?", [receipt]);
  expect((await data(`/api/sends/analytics?${wide}`))[0]).toMatchObject({
    template_id: null,
    template_name: null,
    sends: 1,
  });
  expect(await data("/api/sends/analytics?from=2099-01-01&to=2099-01-02")).toEqual([]);
});

test("the refresh loop runs on the interval and keeps numbers still between runs", async () => {
  options.cacheSlowQueries = true;
  const logged: unknown[] = [];
  const settings = { enabled: true, interval: "TZ=UTC 0 4 * * *" };
  const loop = startSummaryRefresh({
    db: f.db,
    clock: f.clock,
    logger: { error: (error) => logged.push(error) },
    summaries,
    settings: () => settings,
  });
  const tick = async (ms: number) => {
    await f.clock.whenSleeping();
    f.clock.advance(ms);
    await Bun.sleep(0);
  };
  const lists = async () => (await data("/api/dashboard/counts")).lists.total as number;
  const until = async (expected: number) => {
    for (let i = 0; i < 400 && (await lists()) !== expected; i++) {
      await Bun.sleep(5);
      f.clock.advance(0);
    }
    expect(await lists()).toBe(expected);
  };
  try {
    // Nothing stored yet: the first tick fills the rows without waiting for the interval.
    await until(0);
    await f.list("one");
    expect(await lists()).toBe(0);
    await tick(60_000); // 03:05:05.
    await Bun.sleep(100);
    expect(await lists()).toBe(0);
    await tick(55 * 60_000); // 04:00:05 passed the cron minute.
    await until(1);
    const { data: raw } = f.db
      .query("SELECT data FROM analytics_summaries WHERE name = 'list_stats'")
      .get() as { data: string };
    expect(JSON.parse(raw)).toEqual({});
    // Off forgets the rows, so on starts again from now.
    settings.enabled = false;
    options.cacheSlowQueries = false;
    await tick(60_000);
    await Bun.sleep(20);
    await tick(60_000);
    await Bun.sleep(20);
    expect(summaries.missing()).toBe(true);
    expect(logged).toEqual([]);
  } finally {
    f.clock.advance(60_000);
    await loop.stop();
  }
});

test("a refresh that fails is logged, keeps the old rows and leaves the loop running", async () => {
  const failing = createAnalyticsReader({ path: "/nonexistent/iglo.db" });
  const broken = createSummaries(f.db, f.clock, failing);
  const logged: unknown[] = [];
  const loop = startSummaryRefresh({
    db: f.db,
    clock: f.clock,
    logger: { error: (error) => logged.push(error) },
    summaries: broken,
    settings: () => ({ enabled: true, interval: "@hourly" }),
  });
  for (let i = 0; i < 400 && !logged.length; i++) await Bun.sleep(5);
  expect(logged[0]).toBeInstanceOf(ReaderError);
  await f.clock.whenSleeping();
  f.clock.advance(60_000);
  await loop.stop();
  broken.close();
});

test("reader limits: a timeout kills the child, a full queue is refused, failures are errors", async () => {
  const slow = createAnalyticsReader({
    path: "x",
    command: ["sleep", "30"],
    timeoutMs: 50,
    concurrency: 1,
    admissionMs: 10,
  });
  const first = slow.read("dashboardCounts");
  await expect(slow.read("dashboardCounts")).rejects.toMatchObject({ kind: "busy" });
  await expect(first).rejects.toMatchObject({ kind: "timeout" });
  const failed = createAnalyticsReader({ path: "x", command: ["false"] });
  await expect(failed.read("dashboardCounts")).rejects.toMatchObject({ kind: "failed" });

  const router = createRouter();
  let current = failed;
  registerAnalyticsRoutes(router, {
    reader: { read: (method: "dashboardCounts") => current.read(method) } as never,
    summaries,
    campaigns: f.owners.store,
    roles: f.owners.roles,
    auth: f.owners.auth,
    settings: () => ({ individualTracking: false, cacheSlowQueries: false }),
  });
  const counts = () =>
    router.handle(
      f.app,
      new Request("http://fixture.test/api/dashboard/counts", { headers: f.sessionHeaders }),
    );
  expect((await counts()).status).toBe(500);
  expect(f.errors).toHaveLength(1);
  current = slow;
  const held = slow.read("dashboardCounts").catch(() => {});
  expect((await counts()).status).toBe(429);
  await held;
  expect((await counts()).status).toBe(500); // Timed out, with a slot free again.
});

test("the cron interval follows the settings' spec forms", () => {
  const at = (text: string) => new Date(text);
  const due = (spec: string, after: string, until: string) =>
    dueBetween(spec, at(after), at(until));
  expect(due("TZ=UTC 0 3 * * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 * * *", "2026-01-01T03:00:00Z", "2026-01-01T03:01:00Z")).toBe(false);
  expect(due("TZ=UTC */15 * * * *", "2026-01-01T03:14:30Z", "2026-01-01T03:15:30Z")).toBe(true);
  expect(due("TZ=UTC 0 0 * * mon", "2026-01-04T23:59:00Z", "2026-01-05T00:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 0 * * mon", "2026-01-05T23:59:00Z", "2026-01-06T00:00:00Z")).toBe(false);
  // Two restricted day fields match when either does.
  expect(due("TZ=UTC 0 0 13 * fri", "2026-01-01T23:59:00Z", "2026-01-02T00:00:00Z")).toBe(true);
  expect(due("TZ=Europe/Warsaw 0 3 * * *", "2026-01-01T01:59:00Z", "2026-01-01T02:00:00Z")).toBe(
    true,
  );
  expect(due("@every 5m", "2026-01-01T00:04:59Z", "2026-01-01T00:05:01Z")).toBe(true);
  expect(due("@every 5m", "2026-01-01T00:05:01Z", "2026-01-01T00:06:01Z")).toBe(false);
  expect(due("CRON_TZ=UTC @every 1h30m", "2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z")).toBe(
    true,
  );
  // Calendar forms widen to every day and never miss.
  expect(due("TZ=UTC 0 3 L * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 * * 5#2", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 15W * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 LW * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 L-3 * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 * * WED", "2026-01-06T02:59:00Z", "2026-01-07T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 * JUL *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(false);
});
