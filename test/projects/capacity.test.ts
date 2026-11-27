// B145a (14-projects sections 6, 7 and 15, D159): the capacity forecast on every project host. The
// instance runs in this process on a test clock that never moves, with three projects and a
// stand-in for SES v2 GetAccount. History and campaigns are seeded into each project's database;
// every expected number below is worked out by hand from section 7's rules.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@/projects/instance";
import type { Instance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import { adminCredentials, api, createApiUser, logIn } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";
import { buildDocument } from "@/openapi/document";
import { validate } from "@/test/openapi/schema";
import type { Document } from "@/test/openapi/schema";

setDefaultTimeout(30_000);

const PRIMARY = "127.0.0.1";
const A = "alpha.example.test";
const B = "beta.example.test";
const HOUR = 3_600_000;
const MINUTE = 60_000;

const clock = new TestClock();
const NOW = clock.now().getTime();
const iso = (offset: number) => new Date(NOW + offset).toISOString();

let dataDir = "";
let instance: Instance;
let server: ReturnType<typeof serveRouted>;
let ses: ReturnType<typeof Bun.serve>;
let port = 0;
let operator: InstanceSession;
let sentLast24Hours = 3000;
/** When set, the stand-in refuses every read with this AWS message. */
let refusal: string | null = null;
const keys = new Map<string, string>();
const openapi = asBody<Document>(JSON.parse(buildDocument()));

beforeAll(async () => {
  ses = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      refusal
        ? Response.json(
            { message: refusal },
            { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException:" } },
          )
        : Response.json({
            SendQuota: { Max24HourSend: 50_000, MaxSendRate: 20, SentLast24Hours: sentLast24Hours },
            ProductionAccessEnabled: true,
            SendingEnabled: true,
          }),
  });
  const admin = await adminCredentials();
  dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b145a-capacity-"));
  instance = await openInstance(
    {
      dataDir,
      rootUrl: "http://127.0.0.1",
      listen: { host: "127.0.0.1", port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
      sesEndpoint: () => `http://127.0.0.1:${ses.port}`,
    },
    clock,
  );
  await instance.add({ slug: "alpha", name: "Alpha Brand", hostname: A });
  await instance.add({ slug: "beta", name: "Beta Brand", hostname: B });
  const opened = instance;
  server = serveRouted({ host: "127.0.0.1", port: 0 }, (incoming, peer) =>
    opened.dispatch(incoming, peer),
  );
  instance.attach(server);
  port = server.port!;
  operator = (await instanceLogin(port, PRIMARY, admin)).session!;
  for (const host of [PRIMARY, A, B]) {
    keys.set(host, await createApiUser(port, host, await logIn(port, host, admin), "capacity"));
  }
  seed();
});

afterAll(async () => {
  await server?.stop(true);
  await instance?.close();
  await ses?.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

/** Writes into a project's database, as a fixture does; the app reads it through its own API. */
function write(slug: string, statements: ReadonlyArray<string>) {
  const db = new Database(join(dataDir, "projects", slug, "iglo-email.db"));
  try {
    db.run("PRAGMA busy_timeout = 5000");
    for (const statement of statements) {
      db.run(statement);
    }
  } finally {
    db.close();
  }
}

const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
const subscribers = (count: number) =>
  `${series(count)} INSERT INTO subscribers (id, uuid, email, name, status, created_at, updated_at)
   SELECT 1000 + i, 'cap-sub-' || i, 'cap' || i || '@example.test', 'S', 'enabled', '${iso(-48 * HOUR)}', '${iso(-48 * HOUR)}' FROM n`;
const list = (id: number, members: number) => [
  `INSERT INTO lists (id, uuid, name, type, optin) VALUES (${id}, 'cap-list-${id}', 'L${id}', 'private', 'single')`,
  `${series(members)} INSERT INTO subscriber_lists (subscriber_id, list_id, status, created_at, updated_at)
   SELECT 1000 + i, ${id}, 'confirmed', '${iso(-48 * HOUR)}', '${iso(-48 * HOUR)}' FROM n`,
];
const campaign = (
  id: number,
  status: string,
  fields: { sendAt?: number; toSend?: number; sent?: number; updated?: number; list?: number },
) => [
  `INSERT INTO campaigns (id, uuid, name, subject, from_email, body, messenger, status, send_at, to_send, sent, created_at, updated_at)
   VALUES (${id}, 'cap-camp-${id}', 'C${id}', 's', 'a@example.test', 'b', 'email', '${status}',
     ${fields.sendAt === undefined ? "NULL" : `'${iso(fields.sendAt)}'`}, ${fields.toSend ?? 0}, ${fields.sent ?? 0},
     '${iso(-48 * HOUR)}', '${iso(fields.updated ?? -48 * HOUR)}')`,
  ...(fields.list === undefined
    ? []
    : [
        `INSERT INTO campaign_lists (campaign_id, list_id, list_name) VALUES (${id}, ${fields.list}, 'L${fields.list}')`,
      ]),
];
const deliveries = (campaignId: number, count: number, at: number, status = "sent") =>
  `${series(count)} INSERT INTO campaign_deliveries (campaign_id, subscriber_id, status, at)
   SELECT ${campaignId}, 1000 + i, '${status}', '${iso(at)}' FROM n`;
let sendId = 0;
const sends = (count: number, at: number, status: string, kind = "transactional") => {
  const first = sendId;
  sendId += count;
  return `${series(count)} INSERT INTO sends (uuid, source, kind, to_email, status, created_at, attempted_at, sent_at)
    SELECT 'cap-send-' || (${first} + i), 'tx', '${kind}', 'x@example.test', '${status}', '${iso(at)}', '${iso(at)}',
      ${status === "sent" ? `'${iso(at)}'` : "NULL"} FROM n`;
};

/**
 * The fixture. Now is N.
 * - main: 300 sends at N−20 h and 300 at N−2 h (sent); 50 failed at N−1 h and 100 sent at N−30 h,
 *   neither counted. Campaign 1 scheduled at N+6 h, 500 recipients.
 * - alpha: campaign 1 finished at N−6 h with 1,000 deliveries then (yesterday's daily run, 18 h
 *   before the daily candidate); campaign 2 running, to_send 2,000, sent 500 (its deliveries at
 *   N−25 h): 1,500 to go; campaign 3 scheduled at N+15 min, 250 recipients.
 * - beta: 400 marketing sends at N−10 h; campaign 1 scheduled at N+20 h, 300 recipients; campaign 2
 *   scheduled at N+40 h, 700 recipients.
 * The app's own 24 hours: 600 + 1,000 + 400 = 2,000, of which 1,000 are not campaign mail.
 * SES says 3,000 sent: 1,000 outside sends. Quota 50,000; rate min(10, SES 20) = 10/s.
 */
function seed() {
  write("main", [
    sends(300, -20 * HOUR, "sent"),
    sends(300, -2 * HOUR, "sent"),
    sends(50, -1 * HOUR, "failed"),
    sends(100, -30 * HOUR, "sent"),
    subscribers(500),
    ...list(901, 500),
    ...campaign(1, "scheduled", { sendAt: 6 * HOUR, list: 901 }),
  ]);
  write("alpha", [
    subscribers(1000),
    ...list(901, 250),
    ...campaign(1, "finished", { sent: 1000, toSend: 1000, updated: -6 * HOUR }),
    deliveries(1, 1000, -6 * HOUR),
    ...campaign(2, "running", { toSend: 2000, sent: 500, updated: -25 * HOUR }),
    deliveries(2, 500, -25 * HOUR),
    ...campaign(3, "scheduled", { sendAt: 15 * MINUTE, list: 901 }),
  ]);
  write("beta", [
    sends(400, -10 * HOUR, "sent", "marketing"),
    subscribers(700),
    ...list(901, 300),
    ...list(902, 700),
    ...campaign(1, "scheduled", { sendAt: 20 * HOUR, list: 901 }),
    ...campaign(2, "scheduled", { sendAt: 40 * HOUR, list: 902 }),
  ]);
}

interface Answer {
  available: boolean;
  reason: string | null;
  error: string | null;
  rate: { setting: number; ses: number | null; effective: number };
  account: Record<string, unknown> | null;
  forecast: {
    start: string;
    window_start: string;
    window_end: string;
    still_counted: number;
    outside: number;
    baseline: number;
    planned: number;
    candidate: number;
    demand: number;
    quota: number | null;
    headroom: number | null;
    fits: boolean;
  } | null;
}

async function capacity(host: string, query = "") {
  const response = await api(port, host, keys.get(host)!, "GET", `/api/sending/capacity${query}`);
  if (response.status === 200) {
    // Every answer fits the OpenAPI document's SendingCapacity, with no field it leaves out.
    const data = asBody<{ data: unknown }>(JSON.parse(response.text)).data;
    expect(validate(openapi, { $ref: "#/components/schemas/SendingCapacity" }, data)).toEqual([]);
  }
  return {
    status: response.status,
    text: response.text,
    body: asBody<{ data: Answer }>(JSON.parse(response.text)).data,
  };
}

async function setInstance(values: Record<string, unknown>) {
  const current = await instanceCall(port, PRIMARY, operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
  const saved = await instanceCall(port, PRIMARY, operator, "PUT", "/api/instance/settings", {
    ...data,
    ...values,
  });
  expect(saved.status).toBe(200);
}

test("without SES API credentials there is no forecast, on every project host", async () => {
  for (const host of [PRIMARY, A, B]) {
    const { status, body } = await capacity(host, "?count=100");
    expect(status).toBe(200);
    expect(body).toEqual({
      available: false,
      reason: "not_configured",
      error: null,
      rate: { setting: 14, ses: null, effective: 14 },
      account: null,
      forecast: null,
    });
  }
  const check = await instanceCall(
    port,
    PRIMARY,
    operator,
    "POST",
    "/api/instance/settings/ses/check",
  );
  expect(check.status).toBe(200);
  expect(asBody<{ data: { configured: boolean } }>(await check.json()).data.configured).toBe(false);
});

test("the check button reads the account with the saved keys; API credentials are refused", async () => {
  await setInstance({
    "messaging.max_send_rate": 10,
    "ses.api_region": "eu-west-1",
    "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
    "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  const check = await instanceCall(
    port,
    PRIMARY,
    operator,
    "POST",
    "/api/instance/settings/ses/check",
  );
  expect(check.status).toBe(200);
  expect(asBody<{ data: unknown }>(await check.json()).data).toEqual({
    configured: true,
    error: null,
    setting: 10,
    account: {
      max_send_rate: 20,
      max_24_hour_send: 50_000,
      sent_last_24_hours: 3000,
      production_access_enabled: true,
      sending_enabled: true,
      read_at: iso(0),
    },
  });
  const refused = await api(
    port,
    PRIMARY,
    keys.get(PRIMARY)!,
    "POST",
    "/api/instance/settings/ses/check",
  );
  expect(refused.status).toBe(401);
});

/** The forecast's numbers for a request, with the window as offsets from now. */
async function numbers(host: string, query: string) {
  const { status, body, text } = await capacity(host, query);
  expect(status).toBe(200);
  // Instance totals only: no project's name, slug or hostname is in the answer (invariant 1).
  for (const name of ["Alpha", "Beta", "alpha", "beta", "example.test", "main"]) {
    expect(text).not.toContain(name);
  }
  const f = body.forecast!;
  return {
    start: Date.parse(f.start) - NOW,
    end: Date.parse(f.window_end) - NOW,
    from: Date.parse(f.window_start) - NOW,
    still: f.still_counted,
    outside: f.outside,
    baseline: f.baseline,
    planned: f.planned,
    demand: f.demand,
    headroom: f.headroom,
    fits: f.fits,
  };
}

test("a candidate of 18,000 starting now: the window ends at its finish, 30 minutes later", async () => {
  const { body } = await capacity(PRIMARY, `?count=18000&at=${iso(0)}`);
  expect(body.available).toBe(true);
  expect(body.rate).toEqual({ setting: 10, ses: 20, effective: 10 });
  expect(body.account).toMatchObject({
    max_24_hour_send: 50_000,
    sent_last_24_hours: 3000,
    age_seconds: 0,
  });
  // F = N + 18,000 / 10 s = N+30 min; the window (N−23 h 30 min, N+30 min]. 30 min of it is ahead.
  // Still counted: all 2,000 of the app's own, and the outside 1,000 × (24 h − 30 min) / 24 h = 979.17
  // rounded up to 980. Baseline: 1,000 × 30 min / 24 h = 20.8 → 21. Planned: alpha's running 1,500,
  // alpha's campaign at N+15 min 250 (inside the window only because it ends at the finish), and the
  // candidate 18,000. main's N+6 h, beta's N+20 h and N+40 h are outside.
  expect(await numbers(PRIMARY, `?count=18000&at=${iso(0)}`)).toEqual({
    start: 0,
    end: 30 * MINUTE,
    from: 30 * MINUTE - 24 * HOUR,
    still: 2000 + 980,
    outside: 1000,
    baseline: 21,
    planned: 1500 + 250 + 18_000,
    demand: 2980 + 21 + 19_750,
    headroom: 50_000 - 22_751,
    fits: true,
  });
  // Without `at` the candidate starts now too.
  expect((await numbers(PRIMARY, "?count=18000")).demand).toBe(22_751);
});

test("the same candidate in 12 hours and in 30 hours", async () => {
  // F = N+12 h 30 min; window (N−11 h 30 min, N+12 h 30 min], 12 h 30 min ahead. Still counted: main's
  // 300 at N−2 h, alpha's 1,000 at N−6 h, beta's 400 at N−10 h = 1,700 (main's N−20 h has aged
  // out), and outside 1,000 × 11.5 / 24 = 479.17 → 480. Baseline 1,000 × 12.5 / 24 = 520.8 → 521.
  // Planned: 1,500 running + main's 500 at N+6 h + alpha's 250 at N+15 min + 18,000.
  expect(await numbers(A, `?count=18000&at=${iso(12 * HOUR)}`)).toEqual({
    start: 12 * HOUR,
    end: 12 * HOUR + 30 * MINUTE,
    from: -11 * HOUR - 30 * MINUTE,
    still: 1700 + 480,
    outside: 1000,
    baseline: 521,
    planned: 1500 + 500 + 250 + 18_000,
    demand: 2180 + 521 + 20_250,
    headroom: 50_000 - 22_951,
    fits: true,
  });
  // F = N+30 h 30 min; window (N+6 h 30 min, …]: nothing past still counts, the whole window is
  // ahead (baseline 1,000), and beta's 300 at N+20 h joins the running 1,500 and the candidate.
  expect(await numbers(B, `?count=18000&at=${iso(30 * HOUR)}`)).toEqual({
    start: 30 * HOUR,
    end: 30 * HOUR + 30 * MINUTE,
    from: 6 * HOUR + 30 * MINUTE,
    still: 0,
    outside: 1000,
    baseline: 1000,
    planned: 1500 + 300 + 18_000,
    demand: 20_800,
    headroom: 29_200,
    fits: true,
  });
});

test("an edited scheduled campaign given by ID counts once, at its own send time and audience", async () => {
  // beta's campaign 2: N+40 h, 700 recipients, F = N+40 h 70 s. Window (N+16 h 70 s, F]: the
  // running 1,500, beta's 300 at N+20 h, and campaign 2 once, as the candidate.
  expect(await numbers(B, "?campaign_id=2")).toEqual({
    start: 40 * HOUR,
    end: 40 * HOUR + 70_000,
    from: 16 * HOUR + 70_000,
    still: 0,
    outside: 1000,
    baseline: 1000,
    planned: 1500 + 300 + 700,
    demand: 3500,
    headroom: 46_500,
    fits: true,
  });
  // `count` and `at` override the campaign's own; it is still left out of the planned list.
  const moved = await numbers(B, `?campaign_id=2&count=100&at=${iso(40 * HOUR)}`);
  expect(moved.planned).toBe(1500 + 300 + 100);
  // The same ID on another host is that project's campaign: alpha's running one, counted once.
  const other = await numbers(A, "?campaign_id=2");
  expect(other.start).toBe(0);
  expect(other.planned).toBe(1500);
});

test("a daily campaign at yesterday's hour is not counted against yesterday's run", async () => {
  // alpha's 1,000 went out at N−6 h; today's run of 1,000 at N+18 h ends 100 s later, so the window
  // starts at N−6 h + 100 s, after yesterday's run. Still counted: main's 300 at N−2 h and outside
  // 1,000 × (86,400 − 64,900) / 86,400 = 248.8 → 249. Baseline 1,000 × 64,900 / 86,400 = 751.2 → 752.
  // Planned: 1,500 + main's 500 at N+6 h + alpha's 250 at N+15 min + 1,000.
  expect(await numbers(A, `?count=1000&at=${iso(18 * HOUR)}`)).toEqual({
    start: 18 * HOUR,
    end: 18 * HOUR + 100_000,
    from: -6 * HOUR + 100_000,
    still: 300 + 249,
    outside: 1000,
    baseline: 752,
    planned: 1500 + 500 + 250 + 1000,
    demand: 549 + 752 + 3250,
    headroom: 50_000 - 4551,
    fits: true,
  });
});

test("without a candidate the window is the 24 hours up to now", async () => {
  // Everything past counts: 2,000 + 1,000 outside; nothing ahead; planned is the running 1,500
  // (scheduled ones after now are outside the window).
  expect(await numbers(PRIMARY, "")).toMatchObject({
    start: 0,
    end: 0,
    still: 3000,
    baseline: 0,
    planned: 1500,
    demand: 4500,
  });
});

test("over the quota: the answer says so and never refuses; the outside share is never below 0", async () => {
  const over = await numbers(PRIMARY, "?count=60000");
  expect(over.fits).toBe(false);
  expect(over.headroom).toBeLessThan(0);
  // SES says fewer were sent than the app's own 2,000 (its count lags): outside is 0, not −1,500.
  sentLast24Hours = 500;
  const check = await instanceCall(
    port,
    PRIMARY,
    operator,
    "POST",
    "/api/instance/settings/ses/check",
  );
  expect(check.status).toBe(200);
  expect(await numbers(PRIMARY, `?count=18000&at=${iso(0)}`)).toMatchObject({
    outside: 0,
    still: 2000,
    demand: 2000 + 21 + 19_750,
  });
  sentLast24Hours = 3000;
  await instanceCall(port, PRIMARY, operator, "POST", "/api/instance/settings/ses/check");
});

test("a failed read shows project users a plain message; AWS's text stays with the instance admin", async () => {
  const arn = "arn:aws:iam::123456789012:user/iglo-ses-read";
  refusal = `User: ${arn} is not authorized to perform: ses:GetAccount`;
  try {
    const check = await instanceCall(
      port,
      PRIMARY,
      operator,
      "POST",
      "/api/instance/settings/ses/check",
    );
    expect(asBody<{ data: { error: string } }>(await check.json()).data.error).toBe(
      `SES GetAccount answered 403 AccessDeniedException: ${refusal}`,
    );
    for (const host of [PRIMARY, A, B]) {
      const { status, body, text } = await capacity(host, "?count=100");
      expect(status).toBe(200);
      // The last good snapshot still gives a forecast.
      expect(body.available).toBe(true);
      expect(body.error).toBe(
        "The SES account could not be read. The instance admin can check why.",
      );
      expect(text).not.toContain("123456789012");
      expect(text).not.toContain("arn:aws");
    }
  } finally {
    refusal = null;
    await instanceCall(port, PRIMARY, operator, "POST", "/api/instance/settings/ses/check");
  }
  expect((await capacity(A, "?count=100")).body.error).toBeNull();
});

test("a bad candidate is a 400; an unknown campaign a 404", async () => {
  for (const query of [
    "?at=tomorrow",
    // RFC 3339 only (D136): no zone (read in the server's zone otherwise), an impossible date
    // (rolled over to 2 March otherwise) and an offset without its colon are all refused.
    "?at=2026-11-26T09:00",
    "?at=2026-11-26T09:00:00",
    "?at=2026-02-30T10:00:00Z",
    "?at=2026-11-26T09:00:00%2B0200",
    "?count=-1",
    "?count=1.5",
    "?campaign_id=0",
    "?count=1&count=2",
  ]) {
    const { status } = await capacity(PRIMARY, query);
    expect({ query, status }).toEqual({ query, status: 400 });
  }
  expect((await capacity(PRIMARY, "?campaign_id=999")).status).toBe(404);
  const offset = await capacity(PRIMARY, "?count=1&at=2030-01-02T12:00:00.5%2B02:00");
  expect(offset.status).toBe(200);
  expect(offset.body.forecast?.start).toBe("2030-01-02T10:00:00.500Z");
});

test("B170 (D198): a list-scoped user gets 403 for a campaign outside its lists and for a missing one", async () => {
  const key = keys.get(B)!;
  const made = async (path: string, body: unknown) => {
    const response = await api(port, B, key, "POST", path, body);
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    return asBody<{ data: { id: number; password?: string } }>(JSON.parse(response.text)).data;
  };
  const own = await made("/api/lists", { name: "Scoped own", type: "private", optin: "single" });
  const role = await made("/api/roles/users", {
    name: "b170-scoped",
    permissions: ["campaigns:get"],
  });
  const lists = await made("/api/roles/lists", {
    name: "b170-scoped-lists",
    lists: [{ id: own.id, permissions: ["list:get"] }],
  });
  const user = await made("/api/users", {
    username: "b170-scoped",
    type: "api",
    status: "enabled",
    user_role_id: role.id,
    list_role_id: lists.id,
  });
  const scoped = `Basic ${btoa(`b170-scoped:${user.password}`)}`;
  for (const id of ["1", "999"]) {
    const response = await api(port, B, scoped, "GET", `/api/sending/capacity?campaign_id=${id}`);
    expect({ id, status: response.status }).toEqual({ id, status: 403 });
  }
  // Without a campaign the scoped user still reads the forecast.
  expect((await api(port, B, scoped, "GET", "/api/sending/capacity")).status).toBe(200);
});

test("MCP tools/call of get_sending_capacity works with a project token and names no project", async () => {
  const response = await api(port, B, keys.get(B)!, "POST", "/api/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_sending_capacity", arguments: { campaign_id: 2 } },
  });
  expect(response.status).toBe(200);
  const result = asBody<{ result: { isError?: boolean; content: Array<{ text: string }> } }>(
    JSON.parse(response.text),
  ).result;
  expect(result.isError ?? false).toBe(false);
  const text = result.content[0]!.text;
  expect(text).not.toContain("Beta");
  expect(text).not.toContain("example.test");
  const parsed = asBody<{ data: Answer }>(JSON.parse(text));
  expect(parsed.data.forecast?.demand).toBe(3500);
  // The instructions name the project the endpoint serves, and say to check capacity first.
  const init = await api(port, B, keys.get(B)!, "POST", "/api/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  const instructions = asBody<{ result: { instructions: string } }>(JSON.parse(init.text)).result
    .instructions;
  expect(instructions).toContain('serves only the project "Beta Brand"');
  expect(instructions).toContain("`get_sending_capacity`");
});

/** Project beta's MCP `initialize` instructions. */
async function initialize() {
  const init = await api(port, B, keys.get(B)!, "POST", "/api/mcp", {
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  expect(init.status).toBe(200);
  return asBody<{ result: { instructions: string } }>(JSON.parse(init.text)).result.instructions;
}

/** Renames project beta through the instance API. */
async function rename(name: string) {
  const edited = await instanceCall(port, PRIMARY, operator, "PUT", "/api/instance/projects/beta", {
    name,
  });
  expect(edited.status).toBe(200);
}

test("B170 (D198): MCP initialize names a renamed project by its new name, with no restart", async () => {
  await rename("Beta Renamed");
  try {
    const renamed = await initialize();
    expect(renamed).toContain('serves only the project "Beta Renamed"');
    expect(renamed).not.toContain("Beta Brand");
  } finally {
    await rename("Beta Brand");
  }
  expect(await initialize()).toContain('serves only the project "Beta Brand"');
});

test("a long project name is cut in the MCP instructions on a whole character, never inside one", async () => {
  const admin = await adminCredentials();
  const cases = [
    // A cut at 39 UTF-16 units would keep only the first half of the emoji's surrogate pair.
    { slug: "gamma", name: `${"x".repeat(38)}😀😀`, quoted: `${"x".repeat(38)}…` },
    // A family emoji is one character of several code points joined by ZWJ: kept whole or dropped.
    { slug: "delta", name: `${"y".repeat(36)}👩‍👩‍👧zz`, quoted: `${"y".repeat(36)}…` },
  ];
  for (const { slug, name, quoted } of cases) {
    const host = `${slug}.example.test`;
    await instance.add({ slug, name, hostname: host });
    const key = await createApiUser(port, host, await logIn(port, host, admin), "capacity");
    const init = await api(port, host, key, "POST", "/api/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(init.status).toBe(200);
    const instructions = asBody<{ result: { instructions: string } }>(JSON.parse(init.text)).result
      .instructions;
    expect(instructions.isWellFormed()).toBe(true);
    expect(instructions).toContain(`serves only the project "${quoted}"`);
  }
});
