// B142 (14-projects sections 8 and 15 "Bounces", D156): SES notices through the compiled executable.
// `POST /webhooks/service/ses` is the instance's route on the instance host (127.0.0.1 here), with
// the instance's bounce keys and topic ARNs; a notice lands in the one project its Message-ID names.
// The process fetches the SNS signing certificate through the loopback tunnel (sns-tunnel.ts), and
// the notices are signed with the real time, as the route checks their age against the real clock.
// The instance runs in four phases over one data directory: one project, three, an ambiguous copy,
// and no primary project.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstanceDatabase } from "@/projects/instance";
import { createRegistry } from "@/projects/registry";
import { bounceMessage, envelope, TOPIC } from "@/test/bounces/ses-fixture";
import { startSnsTunnel } from "@/test/bounces/sns-tunnel";
import type { SnsTunnel } from "@/test/bounces/sns-tunnel";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";

setDefaultTimeout(60_000);

const PRIMARY = "127.0.0.1";
const A = "a.example.test";
const OLD_A = "old.a.example.test";
const B = "b.example.test";
const C = "c.example.test";
const UNMATCHED = "[instance] An SES notice matched no project";
const real = { clock: { now: () => new Date() } };

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let tunnel: SnsTunnel;
let admin: Credentials;
let dataDir = "";
let server: Awaited<ReturnType<typeof startInstance>> | undefined;
let port = 0;
/** Each project's API credential, by host. It lives in the project's database, so it survives. */
const keys = new Map<string, string>();

interface Subscriber {
  id: number;
  uuid: string;
  email: string;
}
interface Bounce {
  type: string;
  source: string;
  email?: string;
  subscriber_id?: number;
  campaign: { id: number } | null;
}

async function start() {
  server = await startInstance(prepared.executable, dataDir, admin, tunnel.environment);
  port = server.port;
}
/** Stops the instance and returns its stderr. */
async function stop() {
  const stopped = await must(server).stop();
  server = undefined;
  return stopped.stderr;
}
const must = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("missing");
  }
  return value;
};
const key = (host: string) => must(keys.get(host));
async function apiUser(host: string, name: string) {
  keys.set(host, await createApiUser(port, host, await logIn(port, host, admin), `api-${name}`));
}
async function call<T>(host: string, method: string, path: string, body?: unknown) {
  const response = await api(port, host, key(host), method, path, body);
  expect({ path, status: response.status }).toEqual({ path, status: 200 });
  return asBody<{ data: T }>(JSON.parse(response.text)).data;
}
const subscriber = (host: string, email: string) =>
  call<Subscriber>(host, "POST", "/api/subscribers", {
    email,
    name: email,
    status: "enabled",
    lists: [],
  });
const statusOf = async (host: string, id: number) =>
  (await call<{ status: string }>(host, "GET", `/api/subscribers/${id}`)).status;
async function campaign(host: string, name: string) {
  const list = await call<{ id: number }>(host, "POST", "/api/lists", {
    name,
    type: "private",
    optin: "single",
  });
  return call<{ id: number; uuid: string }>(host, "POST", "/api/campaigns", {
    name,
    subject: "Bounce subject",
    lists: [list.id],
    content_type: "plain",
    type: "regular",
    messenger: "email",
    body: "Body",
  });
}
const bounces = async (host: string) =>
  (await call<{ results: Array<Bounce> }>(host, "GET", "/api/bounces?per_page=all")).results;

/** A signed SES bounce for `recipients`, with our Message-ID header when one is given. */
function notice(recipients: Array<string>, messageId?: string, bounceType = "Permanent") {
  return envelope(real, {
    Message: bounceMessage(
      real,
      recipients,
      { bounceType },
      messageId ? [{ name: "Message-ID", value: messageId }] : [],
    ),
  });
}
/** Posts a notice on `host` (the instance host unless named). */
async function deliver(body: unknown, host = PRIMARY) {
  const response = await request(port, host, "/webhooks/service/ses", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-amz-sns-message-type": "Notification" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}
const sorted = (values: Array<string | undefined>) =>
  values.toSorted((x, y) => String(x).localeCompare(String(y)));
const countLines = (stderr: string, line: string) =>
  stderr.split("\n").filter((entry) => entry.startsWith(line)).length;

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  tunnel = await startSnsTunnel();
  dataDir = join(prepared.directory, "data");
  // Phase 1: a fresh install, the primary project alone.
  await start();
  await apiUser(PRIMARY, "main");
  const operator = must((await instanceLogin(port, PRIMARY, admin)).session);
  for (const [name, value] of [
    ["bounce.enabled", true],
    ["bounce.webhooks_enabled", true],
    ["bounce.ses_enabled", true],
    ["bounce.ses_topic_arns", [TOPIC]],
  ] as const) {
    const saved = await instanceCall(
      port,
      PRIMARY,
      operator,
      "PUT",
      `/api/instance/settings/${name}`,
      value,
    );
    expect({ name, status: saved.status }).toEqual({ name, status: 200 });
  }
});

afterAll(async () => {
  if (server) {
    await stop();
  }
  await tunnel?.close();
  await prepared?.cleanup();
});

test("one project: every notice goes to it as today, including the address fallback", async () => {
  const bare = await subscriber(PRIMARY, "one-bare@example.com");
  const foreign = await subscriber(PRIMARY, "one-foreign@example.com");
  // No Message-ID at all: the recipient address names the subscriber.
  expect((await deliver(notice([bare.email]))).status).toBe(200);
  // A Message-ID of a domain no project holds and UUIDs it never sent: still this project's.
  const unknown = `<${crypto.randomUUID()}@elsewhere.example.test>`;
  expect((await deliver(notice([foreign.email], unknown))).status).toBe(200);
  const rows = await bounces(PRIMARY);
  expect(sorted(rows.map((row) => row.email))).toEqual(sorted([bare.email, foreign.email]));
  expect(rows.every((row) => row.source === "ses" && row.type === "hard")).toBe(true);
  expect(await statusOf(PRIMARY, bare.id)).toBe("blocklisted");
  // A repeat of a delivered message is recorded once.
  const once = notice([(await subscriber(PRIMARY, "one-repeat@example.com")).email]);
  expect((await deliver(once)).status).toBe(200);
  expect((await deliver(once)).status).toBe(200);
  expect((await bounces(PRIMARY)).length).toBe(3);
  expect(countLines(await stop(), UNMATCHED)).toBe(0);
});

/** Phase 2's fixtures: the same address in every project, and a campaign in each. */
const shared = "shared@example.com";
const people = new Map<string, Subscriber>();
const campaigns = new Map<string, { id: number; uuid: string }>();
let unmatchedSent = 0;

test("several projects: a notice lands in the project its Message-ID's host names", async () => {
  // Phase 2: projects `a` (with an extra hostname) and `b` beside the primary.
  registerProjects(dataDir, [
    { slug: "a", name: "A", hostname: A, extra: [OLD_A] },
    { slug: "b", name: "B", hostname: B },
  ]);
  await start();
  await apiUser(A, "a");
  await apiUser(B, "b");
  for (const host of [PRIMARY, A, B]) {
    people.set(host, await subscriber(host, shared));
    campaigns.set(host, await campaign(host, `ses-${host}`));
  }
  const before = await bounces(PRIMARY);
  for (const host of [A, B]) {
    const own = must(people.get(host));
    const id = `<${must(campaigns.get(host)).uuid}.${own.uuid}@${host}>`;
    expect((await deliver(notice([shared], id), PRIMARY)).status).toBe(200);
    const [row] = await bounces(host);
    expect(row?.subscriber_id).toBe(own.id);
    expect(row?.campaign?.id).toBe(must(campaigns.get(host)).id);
    expect(await statusOf(host, own.id)).toBe("blocklisted");
  }
  // Each project holds only its own notice; the primary none of them.
  expect((await bounces(A)).length).toBe(1);
  expect((await bounces(B)).length).toBe(1);
  expect(await bounces(PRIMARY)).toEqual(before);
  expect(await statusOf(PRIMARY, must(people.get(PRIMARY)).id)).toBe("enabled");
});

test("an extra hostname resolves, and the address fallback stays inside that project", async () => {
  const a = await subscriber(A, "extra@example.com");
  const b = await subscriber(B, "extra@example.com");
  // The domain decides: these UUIDs name nothing anywhere, so only A's address fallback applies.
  const id = `<${crypto.randomUUID()}@${OLD_A}>`;
  expect((await deliver(notice([a.email], id, "Transient"))).status).toBe(200);
  const rows = (await bounces(A)).filter((row) => row.subscriber_id === a.id);
  expect(rows.map((row) => row.type)).toEqual(["soft"]);
  expect((await bounces(B)).some((row) => row.subscriber_id === b.id)).toBe(false);
});

test("an unknown domain falls back to the projects' sends, campaigns and test sends", async () => {
  const own = await subscriber(B, "probe@example.com");
  const before = (await bounces(B)).length;
  const id = `<${must(campaigns.get(B)).uuid}.${own.uuid}@unknown.example.test>`;
  expect((await deliver(notice([own.email], id, "Transient"))).status).toBe(200);
  const rows = await bounces(B);
  expect(rows.length).toBe(before + 1);
  expect(rows.find((row) => row.subscriber_id === own.id)?.campaign?.id).toBe(
    must(campaigns.get(B)).id,
  );
  expect((await bounces(A)).filter((row) => row.type === "soft").length).toBe(1);
});

const counts = async () =>
  Promise.all([PRIMARY, A, B].map(async (host) => (await bounces(host)).length));

test("a notice no project claims stores nothing anywhere and names itself once", async () => {
  const before = await counts();
  // Unknown domain and UUIDs; and no Message-ID at all. The address is a subscriber everywhere.
  for (const id of [`<${crypto.randomUUID()}@unknown.example.test>`, undefined]) {
    expect((await deliver(notice([shared], id))).status).toBe(200);
    unmatchedSent++;
  }
  expect(await counts()).toEqual(before);
  for (const host of [PRIMARY, A, B]) {
    expect(await statusOf(host, must(people.get(host)).id)).toBe(
      host === PRIMARY ? "enabled" : "blocklisted",
    );
  }
});

/** A's subscriber that phase 3's copy `c` holds too, with the same UUID. */
let twin: Subscriber | undefined;

test("a project host does not serve the SES route", async () => {
  const fresh = await subscriber(A, "project-host@example.com");
  twin = fresh;
  const before = (await bounces(A)).length;
  for (const host of [A, OLD_A]) {
    const id = `<${must(campaigns.get(A)).uuid}.${fresh.uuid}@${A}>`;
    const answer = await deliver(notice([fresh.email], id), host);
    expect(answer.status).toBe(400);
    expect(asBody<{ message: string }>(JSON.parse(answer.body)).message).toBe("Unknown service.");
  }
  expect((await bounces(A)).length).toBe(before);
  expect(await statusOf(A, fresh.id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(unmatchedSent);
});

test("two projects that both claim a Message-ID: nothing is stored, and the line is written", async () => {
  // Phase 3: `c` starts as a copy of `a`'s database, so both hold the same campaign and subscriber.
  await cp(join(dataDir, "projects", "a"), join(dataDir, "projects", "c"), { recursive: true });
  registerProjects(dataDir, [{ slug: "c", name: "C", hostname: C }]);
  await start();
  keys.set(C, key(A));
  const both = must(twin);
  const before = [(await bounces(A)).length, (await bounces(C)).length];
  const id = `<${must(campaigns.get(A)).uuid}.${both.uuid}@unknown.example.test>`;
  expect((await deliver(notice([both.email], id))).status).toBe(200);
  expect([(await bounces(A)).length, (await bounces(C)).length]).toEqual(before);
  expect(await statusOf(A, both.id)).toBe("enabled");
  expect(await statusOf(C, both.id)).toBe("enabled");
  // Its own host still decides for each of them.
  expect((await deliver(notice([both.email], `<${crypto.randomUUID()}@${C}>`))).status).toBe(200);
  expect(await statusOf(C, both.id)).toBe("blocklisted");
  expect(await statusOf(A, both.id)).toBe("enabled");
  // A campaign delivery is a project's only when its subscriber is too: the shared campaign with
  // a subscriber only A holds is A's alone.
  const own = await subscriber(A, "ambiguous@example.com");
  const copy = await subscriber(C, "ambiguous@example.com");
  const delivery = `<${must(campaigns.get(A)).uuid}.${own.uuid}@unknown.example.test>`;
  expect((await deliver(notice([own.email], delivery))).status).toBe(200);
  expect(await statusOf(A, own.id)).toBe("blocklisted");
  expect(await statusOf(C, copy.id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(1);
});

test("without a primary project the route still works on the instance host", async () => {
  // Phase 4: the primary and the copy are unregistered; `a` and `b` remain.
  const clock = createRealClock();
  const db = openInstanceDatabase(dataDir, clock);
  try {
    const registry = createRegistry(db, clock);
    registry.remove("main");
    registry.remove("c");
    registry.close();
  } finally {
    db.close();
  }
  await start();
  const fresh = await subscriber(B, "no-primary@example.com");
  const id = `<${crypto.randomUUID()}@${B}>`;
  expect((await deliver(notice([fresh.email], id), PRIMARY)).status).toBe(200);
  expect(await statusOf(B, fresh.id)).toBe("blocklisted");
  // An unclaimed host is answered as the instance host.
  const other = await subscriber(B, "no-primary-other@example.com");
  const otherId = `<${crypto.randomUUID()}@${B}>`;
  expect((await deliver(notice([other.email], otherId), "unclaimed.example.test")).status).toBe(
    200,
  );
  expect(await statusOf(B, other.id)).toBe("blocklisted");
  expect(countLines(await stop(), UNMATCHED)).toBe(0);
});
