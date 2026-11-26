// B155f item 1 (15-external-sources section 4, D181): the source stream's retry queue, read-only,
// through the compiled executable and the real PocketBase 0.40.5 binary. A user in a blocklisted
// domain makes a terminal row; a reset of the handler's recipients read (the one transport fault
// the binary cannot produce, through the cut proxy) makes a queued one. The queue needs
// settings:manage, and each project lists only its own stream's rows. The private-address block
// stays on; PocketBase is reached through `sources.private_hosts` (D169 amended).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  sessionHeaders,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";
import { asBody, readJson } from "@/test/read-body";
import { startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";
import { startCutProxy } from "@/test/sources/stream-proxy";
import type { CutProxy } from "@/test/sources/stream-proxy";

setDefaultTimeout(90_000);

const HOST = "127.0.0.1";
const OTHER = "other.example.test";
const RETRIES = "/api/settings/source/retries";
let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let server: Awaited<ReturnType<typeof startInstance>>;
let pb: PocketBase;
let proxy: CutProxy;
let admin: Credentials;
let port = 0;
let key = "";
let otherKey = "";

interface Row {
  id: number;
  kind: string;
  record_id: string;
  stamp: string;
  status: string;
  attempts: number;
  first_failed_at: string;
  next_attempt_at: string | null;
  last_error: string;
}
interface Queue {
  stream: string | null;
  more: boolean;
  results: Array<Row>;
}

const call = async (method: string, path: string, body?: unknown, host = HOST, auth = key) => {
  const response = await api(port, host, auth, method, path, body);
  return {
    status: response.status,
    body: asBody<{ data: any; message: string }>(response.text ? JSON.parse(response.text) : {}),
  };
};
const queue = async (host = HOST, auth = host === HOST ? key : otherKey) => {
  const answer = await call("GET", RETRIES, undefined, host, auth);
  expect(answer.status).toBe(200);
  return asBody<Queue>(answer.body.data);
};

/** Polls (real time, the server's clock is real) until `check` holds. */
async function eventually(check: () => Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await queue())}`);
    }
    await Bun.sleep(100);
  }
}

/** Makes `name` events for `user` until a row for one of them is in the queue. */
async function rowFor(user: string, name: string): Promise<Row> {
  const made = new Set<string>();
  let found: Row | undefined;
  await eventually(async () => {
    found = (await queue()).results.find((row) => made.has(row.record_id));
    if (found) {
      return true;
    }
    made.add((await pb.event(user, name)).id);
    await Bun.sleep(400);
    found = (await queue()).results.find((row) => made.has(row.record_id));
    return found !== undefined;
  }, `a queue row for ${name}`);
  return found!;
}

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  pb = await startPocketBase();
  proxy = startCutProxy(pb.port);
  const dataDir = `${prepared.directory}/data`;
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: HOST, primary: true },
    { slug: "other", name: "Other", hostname: OTHER },
  ]);
  server = await startInstance(prepared.executable, dataDir, admin);
  port = server.port;
  key = await createApiUser(port, HOST, await logIn(port, HOST, admin), "api-retries");
  otherKey = await createApiUser(port, OTHER, await logIn(port, OTHER, admin), "api-other");
  const operator = (await instanceLogin(port, HOST, admin)).session!;
  const shared = await readJson<any>(
    await instanceCall(port, HOST, operator, "GET", "/api/instance/settings"),
  );
  const allowed = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
    ...shared.data,
    "sources.private_hosts": ["localhost"],
  });
  expect(allowed.status).toBe(200);
});

afterAll(async () => {
  await server?.stop();
  proxy?.stop();
  await pb?.close();
  await prepared?.cleanup();
});

test("without a source there is no stream and no row", async () => {
  expect(await queue()).toEqual({ stream: null, more: false, results: [] });
});

test("a terminal row and a queued row, each with its status and times; another project lists neither", async () => {
  const list = await call("POST", "/api/lists", { name: "News", type: "public", optin: "single" });
  expect(list.status).toBe(200);
  const current = await call("GET", "/api/settings");
  const saved = await call("PUT", "/api/settings", {
    ...current.body.data,
    "privacy.domain_blocklist": ["blocked.example.test"],
    "source.url": `http://localhost:${new URL(proxy.url).port}`,
    "source.identity": pb.service.identity,
    "source.password": pb.service.password,
    "source.grant_lists": [{ event: "signup", where: {}, lists: [list.body.data.id] }],
  });
  expect(saved.status).toBe(200);
  await eventually(async () => (await queue()).stream !== null, "the stream");

  // A new address in a blocklisted domain is permanent: terminal at once.
  const blocked = await pb.user({ email: `blocked-${Date.now()}@blocked.example.test` });
  const terminal = await rowFor(blocked.id, "signup");
  expect(terminal).toMatchObject({
    kind: "event",
    status: "terminal",
    attempts: 1,
    next_attempt_at: null,
  });
  expect(terminal.last_error).toContain("blocklisted domain");
  expect(Number.isNaN(Date.parse(terminal.first_failed_at))).toBe(false);

  // A reset of the handler's own recipients read is transient: queued, with its next attempt.
  proxy.cutWhen((line) => line.includes("/collections/recipients/"));
  try {
    const ana = await pb.user({ name: "Ana" });
    const queued = await rowFor(ana.id, "signup");
    expect(queued).toMatchObject({ kind: "event", status: "queued" });
    expect(Date.parse(queued.next_attempt_at!)).toBeGreaterThan(Date.parse(queued.first_failed_at));
  } finally {
    proxy.cutWhen(undefined);
  }
  expect((await queue()).stream).not.toBeNull();

  // The other project has no source: its own queue is empty.
  expect(await queue(OTHER)).toEqual({ stream: null, more: false, results: [] });
});

test("the queue and its page need settings:manage", async () => {
  const session = await logIn(port, HOST, admin);
  const role = await call("POST", "/api/roles/users", {
    name: "settings reader",
    permissions: ["settings:get"],
  });
  expect(role.status).toBe(200);
  const reader = await call("POST", "/api/users", {
    username: "retries-reader",
    email: "retries-reader@example.test",
    name: "Reader",
    password: "retries-reader-password",
    type: "user",
    status: "enabled",
    password_login: true,
    password2: "retries-reader-password",
    user_role_id: role.body.data.id,
  });
  expect(reader.status).toBe(200);
  const readerSession = await logIn(port, HOST, {
    user: "retries-reader",
    password: "retries-reader-password",
  });
  const asReader = await request(port, HOST, RETRIES, { headers: sessionHeaders(readerSession) });
  expect(asReader.status).toBe(403);
  const readerPage = await request(port, HOST, "/admin/settings/source-retries", {
    headers: { cookie: readerSession.cookie },
  });
  expect(readerPage.status).toBe(403);
  // The settings reader's menu has no link to it; an admin's has, and the page renders.
  const readerMenu = await (
    await request(port, HOST, "/admin/settings/logs", { headers: { cookie: readerSession.cookie } })
  ).text();
  expect(readerMenu).not.toContain('href="/admin/settings/source-retries"');
  const page = await request(port, HOST, "/admin/settings/source-retries", {
    headers: { cookie: session.cookie },
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Source retry queue");
  expect(html).toContain('href="/admin/settings/source-retries"');
  // No session: refused before anything is read.
  expect((await request(port, HOST, RETRIES)).status).toBe(403);
});
