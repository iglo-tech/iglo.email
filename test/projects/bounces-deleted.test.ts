// B149b r2 (D165; 14-projects section 8): the SES route's address lookup on an instance that has
// served more than one project. After a project is deleted, the one project left must not act on
// its own subscriber for a late notice about mail the deleted project sent. An instance that has
// only ever served one project keeps the lookup. Compiled executable, signed SNS through the tunnel.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { instanceMigrations, runMigrations } from "@/db/migrations";
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

setDefaultTimeout(120_000);

const PRIMARY = "127.0.0.1";
const B = "b.example.test";
const UNMATCHED = "[instance] An SES notice matched no project";
const real = { clock: { now: () => new Date() } };

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let tunnel: SnsTunnel;
let admin: Credentials;
let dataDir = "";
let server: Awaited<ReturnType<typeof startInstance>> | undefined;
let port = 0;
const keys = new Map<string, string>();

interface Subscriber {
  id: number;
  uuid: string;
  email: string;
}

const must = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("missing");
  }
  return value;
};
async function start() {
  server = await startInstance(prepared.executable, dataDir, admin, tunnel.environment);
  port = server.port;
}
async function stop() {
  const stopped = await must(server).stop();
  server = undefined;
  return stopped.stderr;
}
async function call<T>(host: string, method: string, path: string, body?: unknown) {
  const response = await api(port, host, must(keys.get(host)), method, path, body);
  expect({ path, status: response.status, text: response.text }).toEqual({
    path,
    status: 200,
    text: response.text,
  });
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
const bounceCount = async (host: string) =>
  (await call<{ results: Array<unknown> }>(host, "GET", "/api/bounces?per_page=all")).results
    .length;
const campaignBody = (name: string, list: number) => ({
  name,
  subject: "Late",
  lists: [list],
  content_type: "plain",
  type: "regular",
  messenger: "email",
  body: "Body",
});
async function campaign(host: string, name: string) {
  const list = await call<{ id: number }>(host, "POST", "/api/lists", {
    name,
    type: "private",
    optin: "single",
  });
  const made = await call<{ id: number; uuid: string }>(
    host,
    "POST",
    "/api/campaigns",
    campaignBody(name, list.id),
  );
  return { ...made, list: list.id };
}

/**
 * A signed SES bounce whose header list is the Message-ID alone (a message's own headers without
 * the X-Listmonk ones, as a transactional send carries, or as SES's truncated list leaves them).
 */
function notice(recipient: string, messageId?: string) {
  return envelope(real, {
    Message: bounceMessage(
      real,
      [recipient],
      { bounceType: "Permanent" },
      messageId ? [{ name: "Message-ID", value: messageId }] : [],
    ),
  });
}
async function deliver(body: unknown) {
  const response = await request(port, PRIMARY, "/webhooks/service/ses", {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-amz-sns-message-type": "Notification",
    },
    body: JSON.stringify(body),
  });
  return response.status;
}
const countLines = (stderr: string, line: string) =>
  stderr.split("\n").filter((entry) => entry.startsWith(line)).length;

/** The instance's SES keys on, and an API user for the primary. */
async function configure() {
  keys.set(PRIMARY, await createApiUser(port, PRIMARY, await logIn(port, PRIMARY, admin), "api-p"));
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
}

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  tunnel = await startSnsTunnel();
  dataDir = join(prepared.directory, "data");
  // A fresh install: the primary project alone.
  await start();
  await configure();
});

afterAll(async () => {
  if (server) {
    await stop();
  }
  await tunnel?.close();
  await prepared?.cleanup();
});

test("an instance that has only ever served one project keeps the address lookup, across a restart", async () => {
  const unknown = await subscriber(PRIMARY, "solo-unknown@example.com");
  const bare = await subscriber(PRIMARY, "solo-bare@example.com");
  // A send-form Message-ID the project never sent, then no Message-ID at all: the address names
  // the subscriber, as on a single install.
  expect(await deliver(notice(unknown.email, `<${crypto.randomUUID()}@elsewhere.test>`))).toBe(200);
  expect(await statusOf(PRIMARY, unknown.id)).toBe("blocklisted");
  expect(countLines(await stop(), UNMATCHED)).toBe(0);
  await start();
  expect(await deliver(notice(bare.email))).toBe(200);
  expect(await statusOf(PRIMARY, bare.id)).toBe("blocklisted");
  expect(countLines(await stop(), UNMATCHED)).toBe(0);
});

/** Project b's messages to an address the primary holds too: each one's Message-ID. */
const shared = "shared@example.com";
let primaryShared: Subscriber | undefined;
const late = new Map<string, string>();
let unmatchedSent = 0;

test("a deleted project's late notices never act on the remaining project's subscriber", async () => {
  // Project b beside the primary; the same address is a subscriber of both.
  registerProjects(dataDir, [{ slug: "b", name: "B", hostname: B }]);
  await start();
  keys.set(B, await createApiUser(port, B, await logIn(port, B, admin), "api-b"));
  primaryShared = await subscriber(PRIMARY, shared);
  const ownB = await subscriber(B, shared);
  // b's transactional send: its Message-ID is `<sendUuid@host>` and carries no subscriber header.
  const templates = await call<Array<{ id: number; type: string }>>(B, "GET", "/api/templates");
  await call(B, "POST", "/api/tx", {
    subscriber_email: shared,
    template_id: templates.find((item) => item.type === "tx")?.id,
    async: true,
  });
  const sends = await call<{
    results: Array<{ uuid: string; to_email: string }>;
  }>(B, "GET", "/api/sends?per_page=100");
  late.set("tx", `<${must(sends.results.find((row) => row.to_email === shared)).uuid}@${B}>`);
  // b's campaign delivery to its own subscriber of that address.
  const bCampaign = await campaign(B, "late-b");
  late.set("delivery", `<${bCampaign.uuid}.${ownB.uuid}@${B}>`);
  // b's campaign test with a Message-ID its user chose.
  const chosen = `<late-test-${crypto.randomUUID()}@${B}>`;
  const tested = await api(
    port,
    B,
    must(keys.get(B)),
    "POST",
    `/api/campaigns/${bCampaign.id}/test`,
    {
      ...campaignBody("late-b", bCampaign.list),
      headers: [{ "Message-ID": chosen }],
      subscribers: [shared],
    },
  );
  expect({ status: tested.status, text: tested.text }).toEqual({
    status: 200,
    text: tested.text,
  });
  late.set("test", chosen);
  // While b is served, its send's notice lands in b, never in the primary.
  const before = await bounceCount(PRIMARY);
  expect(await deliver(notice(shared, must(late.get("tx"))))).toBe(200);
  expect(await statusOf(B, ownB.id)).toBe("blocklisted");
  expect(await statusOf(PRIMARY, primaryShared.id)).toBe("enabled");
  // The operator deletes b.
  const operator = must((await instanceLogin(port, PRIMARY, admin)).session);
  const deleted = await instanceCall(
    port,
    PRIMARY,
    operator,
    "DELETE",
    "/api/instance/projects/b",
    {
      confirm: "b",
    },
  );
  expect(deleted.status).toBe(200);
  // Late bounces and complaints of b's messages, and one with no Message-ID at all: none is the
  // primary's, so none acts on its subscriber of the same address.
  for (const id of ["tx", "delivery", "test"]) {
    expect({
      id,
      status: await deliver(notice(shared, must(late.get(id)))),
    }).toEqual({
      id,
      status: 200,
    });
    unmatchedSent++;
    expect({ id, status: await statusOf(PRIMARY, primaryShared.id) }).toEqual({
      id,
      status: "enabled",
    });
  }
  expect(await deliver(notice(shared))).toBe(200);
  unmatchedSent++;
  expect(await statusOf(PRIMARY, primaryShared.id)).toBe("enabled");
  expect(await bounceCount(PRIMARY)).toBe(before);
  // The primary's own delivery still lands on its subscriber.
  const own = await subscriber(PRIMARY, "late-own@example.com");
  const ownCampaign = await campaign(PRIMARY, "late-own");
  expect(await deliver(notice(own.email, `<${ownCampaign.uuid}.${own.uuid}@${PRIMARY}>`))).toBe(
    200,
  );
  expect(await statusOf(PRIMARY, own.id)).toBe("blocklisted");
  // The primary's own transactional send: a header naming another subscriber is not believed and
  // the notice is stored nowhere, as with several projects; without it, it lands on the send's own.
  const recipient = await subscriber(PRIMARY, "late-tx@example.com");
  const other = await subscriber(PRIMARY, "late-tx-other@example.com");
  const ptemplates = await call<Array<{ id: number; type: string }>>(
    PRIMARY,
    "GET",
    "/api/templates",
  );
  await call(PRIMARY, "POST", "/api/tx", {
    subscriber_email: recipient.email,
    template_id: ptemplates.find((item) => item.type === "tx")?.id,
    async: true,
  });
  const psends = await call<{
    results: Array<{ uuid: string; to_email: string }>;
  }>(PRIMARY, "GET", "/api/sends?per_page=100");
  const sendId = `<${must(psends.results.find((row) => row.to_email === recipient.email)).uuid}@${PRIMARY}>`;
  const counted = await bounceCount(PRIMARY);
  const forged = envelope(real, {
    Message: bounceMessage(real, [recipient.email], { bounceType: "Permanent" }, [
      { name: "X-Listmonk-Subscriber", value: other.uuid },
      { name: "Message-ID", value: sendId },
    ]),
  });
  expect(await deliver(forged)).toBe(200);
  expect(await bounceCount(PRIMARY)).toBe(counted);
  expect(await statusOf(PRIMARY, recipient.id)).toBe("enabled");
  expect(await deliver(notice(recipient.email, sendId))).toBe(200);
  expect(await statusOf(PRIMARY, recipient.id)).toBe("blocklisted");
  expect(await statusOf(PRIMARY, other.id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(unmatchedSent);
});

test("after a restart the one project left still never looks a notice up by address", async () => {
  if (server) {
    await stop();
  }
  await start();
  let sent = 0;
  for (const id of [...late.values(), undefined]) {
    expect(await deliver(notice(shared, id))).toBe(200);
    sent++;
  }
  expect(await statusOf(PRIMARY, must(primaryShared).id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(sent);
});

/**
 * A v2.0.0 instance database (instance migrations 1 to 3, before the instance recorded whether it
 * served several projects) in a new data directory, with `projects` registered.
 */
function upgradedDataDir(
  name: string,
  projects: Array<{ slug: string; host: string; primary: boolean }>,
) {
  const directory = join(prepared.directory, name);
  const clock = createRealClock();
  const db = openDatabase(directory, "instance.db");
  try {
    runMigrations(db, directory, clock, instanceMigrations.slice(0, 3));
    for (const project of projects) {
      db.run("INSERT INTO projects (slug, name, created_at, is_primary) VALUES (?, ?, ?, ?)", [
        project.slug,
        project.slug,
        clock.now().toISOString(),
        project.primary ? 1 : 0,
      ]);
      db.run("INSERT INTO hostnames (hostname, project, kind) VALUES (?, ?, 'main')", [
        project.host,
        project.slug,
      ]);
    }
  } finally {
    db.close();
  }
  return directory;
}

test("an instance upgraded while it served several projects drops the lookup once one is deleted", async () => {
  if (server) {
    await stop();
  }
  dataDir = upgradedDataDir("upgraded-live", [
    { slug: "main", host: PRIMARY, primary: true },
    { slug: "b", host: B, primary: false },
  ]);
  await start();
  await configure();
  const operator = must((await instanceLogin(port, PRIMARY, admin)).session);
  const deleted = await instanceCall(
    port,
    PRIMARY,
    operator,
    "DELETE",
    "/api/instance/projects/b",
    {
      confirm: "b",
    },
  );
  expect(deleted.status).toBe(200);
  const kept = await subscriber(PRIMARY, shared);
  expect(await deliver(notice(shared, `<${crypto.randomUUID()}@${B}>`))).toBe(200);
  expect(await statusOf(PRIMARY, kept.id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(1);
});

test("an instance upgraded after it deleted a project drops the lookup: its snapshot is the proof", async () => {
  if (server) {
    await stop();
  }
  dataDir = upgradedDataDir("upgraded-deleted", [{ slug: "main", host: PRIMARY, primary: true }]);
  // v2.0.0's delete left the project's final snapshot here (D157).
  mkdirSync(join(dataDir, "backups", "deleted"), { recursive: true });
  writeFileSync(join(dataDir, "backups", "deleted", "b-20261101T000000Z.db"), "");
  await start();
  await configure();
  const kept = await subscriber(PRIMARY, shared);
  expect(await deliver(notice(shared, `<${crypto.randomUUID()}@${B}>`))).toBe(200);
  expect(await deliver(notice(shared))).toBe(200);
  expect(await statusOf(PRIMARY, kept.id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(2);
});

/** A fresh install in its own data directory: the primary project alone, the SES keys on. */
async function freshInstall(name: string) {
  if (server) {
    await stop();
  }
  dataDir = join(prepared.directory, name);
  await start();
  await configure();
}
/** The primary's transactional send to `email`: its Message-ID. */
async function txMessageId(email: string) {
  const templates = await call<Array<{ id: number; type: string }>>(
    PRIMARY,
    "GET",
    "/api/templates",
  );
  await call(PRIMARY, "POST", "/api/tx", {
    subscriber_email: email,
    template_id: templates.find((item) => item.type === "tx")?.id,
    async: true,
  });
  const sends = await call<{
    results: Array<{ uuid: string; to_email: string }>;
  }>(PRIMARY, "GET", "/api/sends?per_page=100");
  return `<${must(sends.results.find((row) => row.to_email === email)).uuid}@${PRIMARY}>`;
}
/** A new API user for the primary project serving now (its key replaces the earlier one). */
async function newPrimaryKey(name: string) {
  keys.set(PRIMARY, await createApiUser(port, PRIMARY, await logIn(port, PRIMARY, admin), name));
}

test("deleting the only project and creating a new primary drops the lookup at once, with no restart", async () => {
  await freshInstall("recreated");
  await subscriber(PRIMARY, shared);
  const old = await txMessageId(shared);
  const operator = must((await instanceLogin(port, PRIMARY, admin)).session);
  const deleted = await instanceCall(
    port,
    PRIMARY,
    operator,
    "DELETE",
    "/api/instance/projects/main",
    { confirm: "main" },
  );
  expect(deleted.status).toBe(200);
  const created = await instanceCall(port, PRIMARY, operator, "POST", "/api/instance/projects", {
    slug: "fresh",
    name: "Fresh",
    hostname: PRIMARY,
    primary: true,
  });
  expect({ status: created.status, text: created.text }).toEqual({
    status: 200,
    text: created.text,
  });
  await newPrimaryKey("api-fresh");
  const kept = await subscriber(PRIMARY, shared);
  // The deleted primary's late notices, with and without a Message-ID: neither is fresh's.
  expect(await deliver(notice(shared, old))).toBe(200);
  expect(await deliver(notice(shared))).toBe(200);
  expect(await statusOf(PRIMARY, kept.id)).toBe("enabled");
  expect(await bounceCount(PRIMARY)).toBe(0);
  expect(countLines(await stop(), UNMATCHED)).toBe(2);
});

test("a project removed and a new primary registered offline drop the lookup too", async () => {
  await freshInstall("offline-recreated");
  await stop();
  // While the server is stopped: the primary's registry rows go, a new primary is registered.
  const clock = createRealClock();
  const db = openInstanceDatabase(dataDir, clock);
  try {
    const registry = createRegistry(db, clock);
    try {
      expect(registry.remove("main")).toBe(true);
      registry.add({
        slug: "fresh",
        name: "Fresh",
        hostname: PRIMARY,
        primary: true,
      });
    } finally {
      registry.close();
    }
  } finally {
    db.close();
  }
  await start();
  await newPrimaryKey("api-offline-fresh");
  const kept = await subscriber(PRIMARY, shared);
  expect(await deliver(notice(shared, `<${crypto.randomUUID()}@${PRIMARY}>`))).toBe(200);
  expect(await deliver(notice(shared))).toBe(200);
  expect(await statusOf(PRIMARY, kept.id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(2);
});

const UNLISTED = "[instance] backups/deleted cannot be listed";

/**
 * A start whose `backups/deleted` cannot be listed: it serves, and the lookup is off. Once the
 * operator repairs it, the next start lists it and the lookup is back (B155a item 4, D176): the
 * refused listing wrote nothing permanent.
 */
async function unlistable(
  name: string,
  prepare: (path: string) => void,
  undo: (path: string) => void,
) {
  if (server) {
    await stop();
  }
  dataDir = join(prepared.directory, name);
  const path = join(dataDir, "backups", "deleted");
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  prepare(path);
  try {
    await start();
    await configure();
    const kept = await subscriber(PRIMARY, shared);
    expect(await deliver(notice(shared))).toBe(200);
    expect(await statusOf(PRIMARY, kept.id)).toBe("enabled");
    const stderr = await stop();
    expect(countLines(stderr, UNMATCHED)).toBe(1);
    expect(countLines(stderr, UNLISTED)).toBe(1);
  } finally {
    undo(path);
  }
  await start();
  const repaired = await subscriber(PRIMARY, "repaired@example.com");
  expect(await deliver(notice(repaired.email))).toBe(200);
  expect(await statusOf(PRIMARY, repaired.id)).toBe("blocklisted");
  const stderr = await stop();
  expect(countLines(stderr, UNMATCHED)).toBe(0);
  expect(countLines(stderr, UNLISTED)).toBe(0);
}

test("a regular file at backups/deleted fails no start and counts as several projects until it is moved", async () => {
  await unlistable(
    "deleted-file",
    (path) => writeFileSync(path, "not a directory"),
    (path) => rmSync(path),
  );
});

test("a v2.0.0 leftover project directory with no registry row drops the lookup", async () => {
  // B155a item 2 (D176): on v2.0.0 a delete whose archive failed before its rename left
  // projects/<slug>/ with no row. Its late notices must not reach this project's address lookup.
  if (server) {
    await stop();
  }
  dataDir = upgradedDataDir("upgraded-leftover", [{ slug: "main", host: PRIMARY, primary: true }]);
  mkdirSync(join(dataDir, "projects", "old"), { recursive: true });
  writeFileSync(join(dataDir, "projects", "old", "iglo-email.db"), "");
  await start();
  await configure();
  const kept = await subscriber(PRIMARY, shared);
  expect(await deliver(notice(shared, `<${crypto.randomUUID()}@${B}>`))).toBe(200);
  expect(await deliver(notice(shared))).toBe(200);
  expect(await statusOf(PRIMARY, kept.id)).toBe("enabled");
  const stderr = await stop();
  expect(countLines(stderr, UNMATCHED)).toBe(2);
  expect(countLines(stderr, "[instance] projects/old has no registry row")).toBe(1);
});

// Root reads a mode-000 directory anyway, so the case cannot be made there.
test.skipIf(process.getuid?.() === 0)(
  "an unreadable backups/deleted fails no start and counts as several projects until it is readable",
  async () => {
    await unlistable(
      "deleted-unreadable",
      (path) => {
        mkdirSync(path);
        writeFileSync(join(path, "x.txt"), "");
        chmodSync(path, 0o000);
      },
      (path) => chmodSync(path, 0o700),
    );
  },
);
