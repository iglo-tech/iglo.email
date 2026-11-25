// Invariant 8 of 14-projects section 14 (B149e, D168): no process-global state. Two instances run
// in this one process at the same time, each with its own data directory, its own test clock at a
// different time, its own instance settings (rate and SES keys) and its own stand-in for SES v2
// GetAccount, and each with a project the other does not have. Everything is observed through
// each instance's own HTTP server: the instance API, the project API and the stand-ins' request
// counts. A module-level map of projects, a shared dispatcher or rate, a shared SES snapshot or
// a shared clock would show one instance's state in the other's answers.
import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import { adminCredentials, api, createApiUser, logIn, request } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";

setDefaultTimeout(60_000);

const HOST = "127.0.0.1";
const DAY = 86_400_000;

interface Side {
  readonly name: string;
  readonly clock: TestClock;
  readonly port: number;
  readonly operator: InstanceSession;
  /** Super Admin API keys by Host header. */
  readonly keys: Map<string, string>;
  readonly reads: () => number;
  readonly close: () => Promise<void>;
}

interface Options {
  readonly name: string;
  /** How far this instance's clock is ahead of the shared test start. */
  readonly ahead: number;
  readonly setting: number;
  readonly ses: { readonly rate: number; readonly max: number; readonly sent: number };
  readonly keyId: string;
  /** A project only this instance has. */
  readonly project: { readonly slug: string; readonly hostname: string };
}

const cleanup: Array<() => Promise<void> | void> = [];
let one: Side;
let two: Side;

async function open(options: Options): Promise<Side> {
  const clock = new TestClock();
  clock.advance(options.ahead);
  let reads = 0;
  const ses = Bun.serve({
    port: 0,
    hostname: HOST,
    fetch: () => {
      reads++;
      return Response.json({
        SendQuota: {
          Max24HourSend: options.ses.max,
          MaxSendRate: options.ses.rate,
          SentLast24Hours: options.ses.sent,
        },
        ProductionAccessEnabled: true,
        SendingEnabled: true,
      });
    },
  });
  const admin = await adminCredentials();
  const dataDir = await mkdtemp(join(tmpdir(), `iglo-email-b149e-${options.name}-`));
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${HOST}`,
      listen: { host: HOST, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
      sesEndpoint: () => `http://${HOST}:${ses.port}`,
    },
    clock,
  );
  const server = serveRouted({ host: HOST, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  instance.attach(server);
  const port = server.port!;
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await Promise.allSettled(instance.stop());
    await server.stop(true);
    await instance.close();
    await ses.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  };
  cleanup.push(close);
  const operator = (await instanceLogin(port, HOST, admin)).session!;
  // The project goes in through the instance API, as an operator adds one without a restart.
  const created = await instanceCall(port, HOST, operator, "POST", "/api/instance/projects", {
    slug: options.project.slug,
    name: options.project.slug,
    hostname: options.project.hostname,
  });
  expect(created.status).toBe(200);
  const current = await instanceCall(port, HOST, operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
  const saved = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
    ...data,
    "messaging.max_send_rate": options.setting,
    "ses.api_region": "eu-west-1",
    "ses.api_access_key_id": options.keyId,
    "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  expect(saved.status).toBe(200);
  const keys = new Map<string, string>();
  for (const host of [HOST, options.project.hostname]) {
    keys.set(host, await createApiUser(port, host, await logIn(port, host, admin), options.name));
  }
  return { name: options.name, clock, port, operator, keys, reads: () => reads, close };
}

beforeAll(async () => {
  // A read refused or late is an attention line on stderr: kept, not printed.
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => errors.mockRestore());
  // Both open before either is used, so each one's state is set while the other already exists.
  [one, two] = await Promise.all([
    open({
      name: "one",
      ahead: 0,
      setting: 10,
      ses: { rate: 20, max: 50_000, sent: 1200 },
      keyId: "AKIAIOSFODNN7EXAMPLE",
      project: { slug: "alpha", hostname: "alpha.example.test" },
    }),
    open({
      name: "two",
      ahead: 40 * DAY,
      setting: 30,
      ses: { rate: 5, max: 200, sent: 7 },
      keyId: "AKIAI44QH8DHBEXAMPLE",
      project: { slug: "beta", hostname: "beta.example.test" },
    }),
  ]);
});

afterAll(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

interface Capacity {
  rate: { setting: number; ses: number | null; effective: number };
  account: { max_24_hour_send: number; sent_last_24_hours: number; read_at: string } | null;
  forecast: { window_end: string } | null;
}

async function capacity(side: Side, host: string): Promise<Capacity> {
  const response = await api(side.port, host, side.keys.get(host)!, "GET", "/api/sending/capacity");
  expect(response.status).toBe(200);
  return asBody<{ data: Capacity }>(JSON.parse(response.text)).data;
}

async function projects(side: Side): Promise<Array<string>> {
  const response = await instanceCall(
    side.port,
    HOST,
    side.operator,
    "GET",
    "/api/instance/projects",
  );
  expect(response.status).toBe(200);
  const { data } = asBody<{ data: Array<{ slug: string }> }>(await response.json());
  return data.map((project) => project.slug).sort();
}

test("each instance's routing table holds its own projects only", async () => {
  expect(await projects(one)).toEqual(["alpha", "main"]);
  expect(await projects(two)).toEqual(["beta", "main"]);
  // The other instance's project hostname is an unclaimed host here: it reaches the primary, whose
  // API key the other project's key is not.
  const foreign = await api(
    one.port,
    "beta.example.test",
    two.keys.get("beta.example.test")!,
    "GET",
    "/api/subscribers",
  );
  expect(foreign.status).toBe(403);
});

test("each instance paces and forecasts with its own settings, SES account and clock", async () => {
  const first = await capacity(one, "alpha.example.test");
  const second = await capacity(two, "beta.example.test");
  // One: setting 10 below SES's 20. Two: SES's 5 below the setting 30.
  expect(first.rate).toEqual({ setting: 10, ses: 20, effective: 10 });
  expect(second.rate).toEqual({ setting: 30, ses: 5, effective: 5 });
  expect(first.account).toMatchObject({ max_24_hour_send: 50_000, sent_last_24_hours: 1200 });
  expect(second.account).toMatchObject({ max_24_hour_send: 200, sent_last_24_hours: 7 });
  // Each snapshot and window are timed by that instance's clock, 40 days apart.
  expect(first.account?.read_at).toBe(one.clock.now().toISOString());
  expect(second.account?.read_at).toBe(two.clock.now().toISOString());
  expect(first.forecast?.window_end).toBe(one.clock.now().toISOString());
  expect(second.forecast?.window_end).toBe(two.clock.now().toISOString());
  // Each stand-in was read by its own instance only, once, within the one-a-minute rule.
  expect(one.reads()).toBe(1);
  expect(two.reads()).toBe(1);

  // Moving one clock past the minute makes only that instance read again, and the other still
  // answers from its own snapshot, rate and clock.
  one.clock.advance(61_000);
  const again = await capacity(one, HOST);
  const other = await capacity(two, HOST);
  expect(one.reads()).toBe(2);
  expect(two.reads()).toBe(1);
  expect(again.account?.read_at).toBe(one.clock.now().toISOString());
  expect(other).toMatchObject({
    rate: { setting: 30, ses: 5, effective: 5 },
    account: {
      max_24_hour_send: 200,
      sent_last_24_hours: 7,
      read_at: two.clock.now().toISOString(),
    },
    forecast: { window_end: two.clock.now().toISOString() },
  });
});

test("data written in one instance is never seen in the other", async () => {
  const created = await api(one.port, HOST, one.keys.get(HOST)!, "POST", "/api/subscribers", {
    email: "only-one@example.test",
    name: "Only one",
    status: "enabled",
  });
  expect(created.status).toBe(200);
  const listed = async (side: Side) => {
    const response = await api(side.port, HOST, side.keys.get(HOST)!, "GET", "/api/subscribers");
    expect(response.status).toBe(200);
    return asBody<{ data: { results: Array<{ email: string }> } }>(
      JSON.parse(response.text),
    ).data.results.map((row) => row.email);
  };
  expect(await listed(one)).toContain("only-one@example.test");
  expect(await listed(two)).not.toContain("only-one@example.test");
});

test("closing one instance leaves the other serving with its own state", async () => {
  await one.close();
  const after = await capacity(two, "beta.example.test");
  expect(after.rate).toEqual({ setting: 30, ses: 5, effective: 5 });
  expect(await projects(two)).toEqual(["beta", "main"]);
  const health = await request(two.port, HOST, "/admin/instance/sending", {
    headers: { cookie: two.operator.cookie },
  });
  expect(health.status).toBe(200);
});
