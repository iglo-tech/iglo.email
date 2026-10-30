// Behavior the real routes can only show with an injected clock or fixture rows: period
// boundaries, which period a unique count lands in, sequence-step grouping, the summary
// refresh loop and how reader failures surface. test/contract/analytics.ts covers the rest
// against both the reference and the compiled executable.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAnalyticsReader, ReaderError } from "@/analytics/reader";
import { registerAnalyticsRoutes } from "@/analytics/routes";
import { dueBetween } from "@/analytics/schedule";
import { createSummaries, startSummaryRefresh } from "@/analytics/summaries";
import { createRouter, startServer } from "@/server/server";
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
    {
      list_id: list,
      campaign_id: 0,
      count: 1,
      timestamp: "2025-12-29T00:00:00Z",
    },
    {
      list_id: list,
      campaign_id: 0,
      count: 2,
      timestamp: "2026-01-05T00:00:00Z",
    },
    {
      list_id: list,
      campaign_id: 0,
      count: 1,
      timestamp: "2026-01-26T00:00:00Z",
    },
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
          "INSERT INTO sends (uuid, source, kind, to_email, template_id, step_id, status, created_at, sent_at) VALUES (?, ?, 'transactional', 'a@example.test', ?, ?, ?, ?, ?) RETURNING id",
        )
        .get(
          `s${++n}`,
          step ? "sequence" : "tx",
          template,
          step,
          status,
          at,
          status === "sent" ? at : null,
        ) as { id: bigint }
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
  const first = slow.read("dashboardCounts", []);
  await expect(slow.read("dashboardCounts", [])).rejects.toMatchObject({
    kind: "busy",
  });
  await expect(first).rejects.toMatchObject({ kind: "timeout" });
  const failed = createAnalyticsReader({ path: "x", command: ["false"] });
  await expect(failed.read("dashboardCounts", [])).rejects.toMatchObject({
    kind: "failed",
  });

  const router = createRouter();
  let current = failed;
  registerAnalyticsRoutes(router, {
    reader: {
      read: (method: "dashboardCounts") => current.read(method, []),
    } as never,
    summaries,
    campaigns: f.owners.store,
    roles: f.owners.roles,
    auth: f.owners.auth,
    settings: () => ({ individualTracking: false, cacheSlowQueries: false }),
  });
  const counts = () =>
    router.handle(
      f.app,
      new Request("http://fixture.test/api/dashboard/counts", {
        headers: f.sessionHeaders,
      }),
    );
  expect((await counts()).status).toBe(500);
  expect(f.errors).toHaveLength(1);
  current = slow;
  const held = slow.read("dashboardCounts", []).catch(() => {});
  expect((await counts()).status).toBe(429);
  await held;
  expect((await counts()).status).toBe(500); // Timed out, with a slot free again.
});

test("the dashboard campaigns card reads through the reader", async () => {
  const list = await f.list("news");
  await f.campaign({ name: "c", subject: "s", lists: [list] });
  expect((await data("/api/dashboard/campaigns")).map((row: { name: string }) => row.name)).toEqual(
    ["c"],
  );
  const failed = createAnalyticsReader({ path: "x", command: ["false"] });
  const router = createRouter();
  registerAnalyticsRoutes(router, {
    reader: failed,
    summaries,
    campaigns: f.owners.store,
    roles: f.owners.roles,
    auth: f.owners.auth,
    settings: () => ({ individualTracking: false, cacheSlowQueries: false }),
  });
  const card = await router.handle(
    f.app,
    new Request("http://fixture.test/api/dashboard/campaigns", {
      headers: f.sessionHeaders,
    }),
  );
  expect(card.status).toBe(500);
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
  expect(due("CRON_TZ=UTC 0 3 * * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  // Calendar forms widen to every day and never miss.
  expect(due("TZ=UTC 0 3 L * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 * * 5#2", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 15W * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 LW * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 L-3 * *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 * * WED", "2026-01-06T02:59:00Z", "2026-01-07T03:00:00Z")).toBe(true);
  expect(due("TZ=UTC 0 3 * JUL *", "2026-01-01T02:59:00Z", "2026-01-01T03:00:00Z")).toBe(false);
});

const ended = (done: Promise<void>) =>
  Promise.race([
    done.then(
      () => "ended",
      () => "ended",
    ),
    Bun.sleep(50).then(() => "running"),
  ]);

/** The refresh loop with the cached dashboard behind it, driven by the fake clock. */
function refreshing(interval: string) {
  options.cacheSlowQueries = true;
  const logged: unknown[] = [];
  const settings = { enabled: true, interval };
  const loop = startSummaryRefresh({
    clock: f.clock,
    logger: { error: (error) => logged.push(error) },
    summaries,
    settings: () => settings,
  });
  return {
    logged,
    settings,
    loop,
    /** Let the loop reach its sleep, move the clock, and wait for what that woke to finish. */
    async tick(ms: number) {
      const settled = () =>
        Promise.race([f.clock.whenSleeping(), loop.done.catch(() => {}), Bun.sleep(2_000)]);
      await settled();
      f.clock.advance(ms);
      await Bun.sleep(1);
      await settled();
    },
    lists: async () => (await data("/api/dashboard/counts")).lists.total as number,
    async stop() {
      f.clock.advance(60_000);
      await loop.stop();
    },
  };
}

test("TZ=Local fires in the system zone and keeps the server running", async () => {
  const minute = new Date(f.clock.now().getTime() + 60_000);
  const spec = `TZ=Local ${minute.getMinutes()} ${minute.getHours()} * * *`;
  const refresh = refreshing(spec);
  try {
    await refresh.tick(0);
    await f.list("one");
    await refresh.tick(60_000);
    expect(await ended(refresh.loop.done)).toBe("running");
    expect(await refresh.lists()).toBe(1);
    expect(refresh.logged).toEqual([]);
    expect(await ended(refresh.loop.done)).toBe("running");
  } finally {
    await refresh.stop();
  }
});

test("a schedule that cannot be evaluated is logged once and keeps the last snapshot", async () => {
  const refresh = refreshing("TZ=UTC 0 3 * * *");
  try {
    await refresh.tick(0);
    expect(await refresh.lists()).toBe(0);
    await f.list("one");
    refresh.settings.interval = "TZ=Mars/Base 0 3 * * *";
    await refresh.tick(60_000);
    await refresh.tick(60_000);
    expect(await ended(refresh.loop.done)).toBe("running");
    expect(refresh.logged).toHaveLength(1);
    expect(await refresh.lists()).toBe(0);
    // A corrected setting takes effect at the next check.
    refresh.settings.interval = "@every 1m";
    await refresh.tick(60_000);
    await refresh.tick(60_000);
    expect(await refresh.lists()).toBe(1);
  } finally {
    await refresh.stop();
  }
});

test("every zone the settings accept can be evaluated", () => {
  const due = (zone: string) =>
    dueBetween(
      `TZ=${zone} 0 3 * * *`,
      new Date("2026-01-01T02:59:00Z"),
      new Date("2026-01-01T03:00:00Z"),
    );
  expect(due("Factory")).toBe(true);
  const system = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    // An empty location is UTC to Go's time.LoadLocation, not the system zone.
    expect(due("")).toBe(true);
  } finally {
    if (system === undefined) delete process.env.TZ;
    else process.env.TZ = system;
  }
});

test("@every shorter than a minute refreshes on time", async () => {
  const refresh = refreshing("@every 5s");
  try {
    await refresh.tick(0);
    expect(await refresh.lists()).toBe(0);
    await f.list("one");
    await refresh.tick(4_999);
    expect(await refresh.lists()).toBe(0);
    await refresh.tick(1);
    expect(await refresh.lists()).toBe(1);
  } finally {
    await refresh.stop();
  }
});

test("@every counts from when scheduling starts, not from multiples of the duration", async () => {
  const refresh = refreshing("@every 1h"); // Starts at 03:04:05.
  try {
    await refresh.tick(0);
    await f.list("one");
    await refresh.tick(56 * 60_000); // 04:00:05 is a multiple of an hour's start, not a period.
    expect(await refresh.lists()).toBe(0);
    await refresh.tick(4 * 60_000); // 04:04:05.
    expect(await refresh.lists()).toBe(1);
  } finally {
    await refresh.stop();
  }
});

test("a send counts on the day it was delivered, not the day it was queued", async () => {
  const { id: template } = f.db
    .query(
      "INSERT INTO templates (name, type, subject, body) VALUES ('t', 'tx', 's', 'b') RETURNING id",
    )
    .get() as { id: bigint };
  const { id: sequence } = f.db
    .query(
      `INSERT INTO sequences (uuid, name, trigger) VALUES ('q', 'Q', '{"event":"x"}') RETURNING id`,
    )
    .get() as { id: bigint };
  const { id: step } = f.db
    .query(
      "INSERT INTO sequence_steps (uuid, sequence_id, position, wait, kind) VALUES ('st', ?, 1, 'PT0S', 'marketing') RETURNING id",
    )
    .get(sequence) as { id: bigint };
  f.db
    .query(
      "INSERT INTO sends (uuid, source, kind, to_email, template_id, step_id, status, created_at, sent_at) VALUES ('s', 'sequence', 'transactional', 'a@example.test', ?, ?, 'sent', '2026-01-01T23:59:00.000Z', '2026-01-02T00:01:00.000Z')",
    )
    .run(template, step);
  const sends = async (from: string, to: string, group: string) =>
    (
      (await data(`/api/sends/analytics?from=${from}&to=${to}&group_by=${group}`)) as {
        sends: number;
      }[]
    ).map((row) => row.sends);
  for (const group of ["template", "step"]) {
    expect(await sends("2026-01-02", "2026-01-03", group)).toEqual([1]);
    expect(await sends("2026-01-01", "2026-01-01T23:59:59Z", group)).toEqual([]);
  }
});

test("rows arrive by period and then owner when days of a week merge", async () => {
  const first = await f.list("first");
  const second = await f.list("second");
  const ada = await f.subscriber("ada@example.test", [first, second]);
  const a = await f.campaign({ name: "a", subject: "s", lists: [first] });
  const b = await f.campaign({ name: "b", subject: "s", lists: [second] });
  f.clock.advance(3 * DAY); // Monday 2026-01-05.
  await view(b, ada);
  f.clock.advance(DAY);
  await view(a, ada);
  await view(b, ada);
  await relogin();
  const week = (id: number, count: number) => ({
    list_id: id,
    campaign_id: 0,
    count,
    timestamp: "2026-01-05T00:00:00Z",
  });
  expect(
    await data(`/api/lists/analytics/views?id=${second}&id=${first}&${wide}&interval=week`),
  ).toEqual([week(first, 1), week(second, 2)]);
});

/** A child that records its PID and then waits, so a test can see which ones really ran. */
const recorded = () => {
  const file = join(f.db.filename.replace(/[^/]*$/, ""), `pids-${crypto.randomUUID()}`);
  return {
    command: ["sh", "-c", `echo $$ >> ${file}; exec sleep 30`],
    pids: () =>
      existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [],
  };
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
};
const kinds = async (reads: Promise<unknown>[]) =>
  (await Promise.allSettled(reads)).map((result) =>
    result.status === "rejected" ? (result.reason as ReaderError).kind : "read",
  );

test("closing stops admission, refuses queued reads and awaits every child", async () => {
  const child = recorded();
  const owned = createAnalyticsReader({
    path: "x",
    command: child.command,
    concurrency: 1,
    timeoutMs: 300,
  });
  const running = owned.read("dashboardCounts", []);
  const queued = owned.read("dashboardCounts", []);
  await until(() => child.pids().length === 1);
  const settled = kinds([running, queued]);
  await owned.close();
  expect(child.pids().filter(alive)).toEqual([]);
  expect(await settled).toEqual(["closed", "closed"]);
  expect(await kinds([owned.read("dashboardCounts", [])])).toEqual(["closed"]);
  await Bun.sleep(350);
  expect(child.pids()).toHaveLength(1);
});

test("cancelling kills a running read and removes a queued one", async () => {
  const child = recorded();
  const owned = createAnalyticsReader({
    path: "x",
    command: child.command,
    concurrency: 1,
    timeoutMs: 300,
  });
  const client = new AbortController();
  const other = new AbortController();
  const running = owned.read("dashboardCounts", [], client.signal);
  const queued = owned.read("dashboardCounts", [], other.signal);
  await until(() => child.pids().length === 1);
  other.abort();
  expect(await kinds([queued])).toEqual(["cancelled"]);
  expect(child.pids().filter(alive)).toHaveLength(1);
  client.abort();
  expect(await kinds([running])).toEqual(["cancelled"]);
  expect(child.pids().filter(alive)).toEqual([]);
  await expect(owned.read("dashboardCounts", [], client.signal)).rejects.toMatchObject({
    kind: "cancelled",
  });
  await owned.close();
});

test("a client that disconnects takes its read with it", async () => {
  const child = recorded();
  const owned = createAnalyticsReader({
    path: "x",
    command: child.command,
    timeoutMs: 2_000,
  });
  const router = createRouter();
  registerAnalyticsRoutes(router, {
    reader: owned,
    summaries,
    campaigns: f.owners.store,
    roles: f.owners.roles,
    auth: f.owners.auth,
    settings: () => ({ individualTracking: false, cacheSlowQueries: false }),
  });
  const server = startServer(f.app, router);
  try {
    const client = new AbortController();
    const response = fetch(`http://127.0.0.1:${server.port}/api/dashboard/counts`, {
      headers: f.sessionHeaders,
      signal: client.signal,
    }).catch(() => null);
    await until(() => child.pids().length === 1);
    client.abort();
    await response;
    await until(() => child.pids().filter(alive).length === 0);
    await Bun.sleep(20);
    expect(f.errors).toEqual([]);
  } finally {
    await server.stop(true);
    await owned.close();
  }
});

test("output over the cap is refused whole and the child is killed", async () => {
  const big = createAnalyticsReader({
    path: "x",
    command: ["sh", "-c", "head -c 100000 /dev/zero; exec sleep 30"],
    maxOutputBytes: 1_000,
    timeoutMs: 300,
  });
  await expect(big.read("dashboardCounts", [])).rejects.toMatchObject({
    kind: "limit",
  });
  await big.close();

  const exact = createAnalyticsReader({
    path: "x",
    command: ["sh", "-c", "printf 0123456789"],
    maxOutputBytes: 10,
  });
  expect(new TextDecoder().decode(await exact.read("dashboardCounts", []))).toBe("0123456789");
  await exact.close();
});

test("a child above the memory limit is killed", async () => {
  const hungry = createAnalyticsReader({
    path: "x",
    command: [
      process.execPath,
      "-e",
      "const b = Buffer.alloc(120 * 1048576, 1); await Bun.sleep(30000); console.log(b.length)",
    ],
    memoryBytes: 80 * 1048576,
    timeoutMs: 3_000,
  });
  await expect(hungry.read("dashboardCounts", [])).rejects.toMatchObject({
    kind: "limit",
  });
  await hungry.close();
});

test("a queue past its bound is refused at once, without touching queued reads", async () => {
  const child = recorded();
  const owned = createAnalyticsReader({
    path: "x",
    command: child.command,
    concurrency: 1,
    maxQueued: 1,
    admissionMs: 300,
    timeoutMs: 400,
  });
  const running = owned.read("dashboardCounts", []);
  let settled = false;
  const queued = owned.read("dashboardCounts", []).finally(() => (settled = true));
  await expect(owned.read("dashboardCounts", [])).rejects.toMatchObject({
    kind: "busy",
  });
  expect(settled).toBe(false);
  await Promise.allSettled([running, queued]);
  await owned.close();
});

test("a read over a limit is a clean error, never a partial body", async () => {
  const big = createAnalyticsReader({
    path: "x",
    command: ["sh", "-c", `printf '{"data":['; head -c 100000 /dev/zero | tr '\\0' 1`],
    maxOutputBytes: 1_000,
  });
  const router = createRouter();
  registerAnalyticsRoutes(router, {
    reader: big,
    summaries,
    campaigns: f.owners.store,
    roles: f.owners.roles,
    auth: f.owners.auth,
    settings: () => ({ individualTracking: false, cacheSlowQueries: false }),
  });
  const response = await router.handle(
    f.app,
    new Request("http://fixture.test/api/dashboard/counts", {
      headers: f.sessionHeaders,
    }),
  );
  expect(response.status).toBe(422);
  expect((await response.json()) as { message: string }).toMatchObject({
    message: expect.stringContaining("too large"),
  });
  expect(f.errors).toEqual([]);
  await big.close();
});
