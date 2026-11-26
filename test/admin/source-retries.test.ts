// B155f item 1 (15-external-sources section 4, D181): the source stream's retry queue, read-only,
// through the compiled executable and the real PocketBase 0.40.5 binary. A user in a blocklisted
// domain makes a terminal row; a reset of the handler's recipients read (the one transport fault
// the binary cannot produce, through the cut proxy) makes a queued one. The queue needs
// settings:manage, and each project lists only its own stream's rows. The private-address block
// stays on; PocketBase is reached through `sources.private_hosts` (D169 amended).
//
// B159c (D184): two projects with a source each, on two PocketBase instances, list only their own
// rows; past 1000 rows the answer holds the oldest 1000 and `more`; and a queued row whose retry
// meets a settings mismatch (a renamed events field) is `waiting`. That last case runs the instance
// in this process on a `TestClock`, since the compiled executable's clock is real and the first
// retry is a minute away.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { openLifecycle, PRIMARY } from "@/test/projects/lifecycle-fixture";
import { TestClock } from "@/test/server/fixture";
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
/** The other project's source (B159c item 2): another PocketBase, so no record ID is shared. */
let otherPb: PocketBase;
let proxy: CutProxy;
let admin: Credentials;
let port = 0;
let key = "";
let otherKey = "";
/** The other project's first row (B159c item 2), older than every row of item 1's case. */
let otherFirst = 0;

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
const queueAt = async (at: number, host: string, auth: string) => {
  const response = await api(at, host, auth, "GET", RETRIES);
  expect(response.status).toBe(200);
  return asBody<Queue>(JSON.parse(response.text).data);
};
const queue = (host = HOST, auth = host === HOST ? key : otherKey) => queueAt(port, host, auth);

/** Polls (real time; only the in-process case's clock is a test clock) until `check` holds. */
async function eventually(check: () => Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(100);
  }
}

/** Makes `name` events for `user` in `source` until a row for one of them is in `read`'s queue. */
async function rowFor(
  user: string,
  name: string,
  source = pb,
  read: () => Promise<Queue> = () => queue(),
): Promise<Row> {
  const made = new Set<string>();
  let found: Row | undefined;
  await eventually(async () => {
    found = (await read()).results.find((row) => made.has(row.record_id));
    if (found) {
      return true;
    }
    made.add((await source.event(user, name)).id);
    await Bun.sleep(400);
    found = (await read()).results.find((row) => made.has(row.record_id));
    return found !== undefined;
  }, `a queue row for ${name}`);
  return found!;
}

/** The source settings of a project on `source` (the fixture schema), granting `list` on signup. */
const sourceSettings = (url: string, source: PocketBase, list: number, blocked: string) => ({
  "privacy.domain_blocklist": [blocked],
  "source.url": url,
  "source.identity": source.service.identity,
  "source.password": source.service.password,
  "source.grant_lists": [{ event: "signup", where: {}, lists: [list] }],
});

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  pb = await startPocketBase();
  otherPb = await startPocketBase();
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
  await otherPb?.close();
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

test("two projects with a source each list only their own stream's rows", async () => {
  // B159c item 2 (D184): the other project reads its own PocketBase; the main project's rows above
  // stay where they are.
  const list = await call(
    "POST",
    "/api/lists",
    { name: "Other news", type: "public", optin: "single" },
    OTHER,
    otherKey,
  );
  expect(list.status).toBe(200);
  const current = await call("GET", "/api/settings", undefined, OTHER, otherKey);
  const saved = await call(
    "PUT",
    "/api/settings",
    {
      ...current.body.data,
      ...sourceSettings(
        otherPb.url.replace("127.0.0.1", "localhost"),
        otherPb,
        list.body.data.id,
        "other-blocked.example.test",
      ),
    },
    OTHER,
    otherKey,
  );
  expect(saved.status).toBe(200);
  await eventually(async () => (await queue(OTHER)).stream !== null, "the other project's stream");
  const blocked = await otherPb.user({ email: `blocked-${Date.now()}@other-blocked.example.test` });
  const own = await rowFor(blocked.id, "signup", otherPb, () => queue(OTHER));
  expect(own).toMatchObject({ kind: "event", status: "terminal" });
  otherFirst = own.id;

  const mainIds = (await queue()).results.map((row) => row.record_id);
  const otherIds = (await queue(OTHER)).results.map((row) => row.record_id);
  expect(mainIds.length).toBeGreaterThan(0);
  expect(otherIds).toContain(own.record_id);
  expect(mainIds).not.toContain(own.record_id);
  expect(otherIds.filter((id) => mainIds.includes(id))).toEqual([]);
});

test("past 1000 rows the queue lists the oldest 1000 and says there are more", async () => {
  // B159c item 1 (D184): 1001 more events of the other project's blocklisted user, each a terminal
  // row at once, on top of the one above.
  const blocked = await otherPb.user({ email: `many-${Date.now()}@other-blocked.example.test` });
  const total = 1001;
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < total) {
        next++;
        await otherPb.event(blocked.id, "signup");
      }
    }),
  );
  await eventually(async () => (await queue(OTHER)).more, "more than 1000 rows", 60_000);
  const answer = await queue(OTHER);
  expect(answer.more).toBe(true);
  expect(answer.results).toHaveLength(1000);
  // Oldest first: ascending IDs, the earlier case's row among them.
  const ids = answer.results.map((row) => row.id);
  expect(ids).toEqual(ids.toSorted((a, b) => a - b));
  expect(ids).toContain(otherFirst);
  expect(answer.results[0]!.last_error).toContain("blocklisted domain");
  // The main project's queue is untouched by them.
  expect((await queue()).more).toBe(false);
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

test("a queued row whose retry meets a settings mismatch is waiting, its window started again", async () => {
  // B159c item 3 (D184): the instance in this process on a test clock, with its own PocketBase (the
  // rename below would break the other cases' source) behind its own cut proxy.
  const clock = new TestClock();
  const source = await startPocketBase();
  const cut = startCutProxy(source.port);
  const f = await openLifecycle(clock);
  try {
    const shared = await readJson<any>(await f.call("GET", "/api/instance/settings"));
    const allowed = await f.call("PUT", "/api/instance/settings", {
      ...shared.data,
      "sources.private_hosts": ["localhost"],
    });
    expect(allowed.status).toBe(200);
    const auth = await createApiUser(
      f.port,
      PRIMARY,
      await logIn(f.port, PRIMARY, f.admin),
      "api-waiting",
    );
    const local = async (method: string, path: string, body?: unknown) => {
      const response = await api(f.port, PRIMARY, auth, method, path, body);
      return { status: response.status, data: asBody<any>(JSON.parse(response.text).data) };
    };
    const read = () => queueAt(f.port, PRIMARY, auth);
    const list = await local("POST", "/api/lists", {
      name: "News",
      type: "public",
      optin: "single",
    });
    expect(list.status).toBe(200);
    const current = await local("GET", "/api/settings");
    const saved = await local("PUT", "/api/settings", {
      ...current.data,
      ...sourceSettings(
        `http://localhost:${new URL(cut.url).port}`,
        source,
        list.data.id,
        "blocked.example.test",
      ),
    });
    expect(saved.status).toBe(200);
    await eventually(async () => (await read()).stream === "live", "the stream");

    // A reset of the handler's recipients read queues the record, its retry a minute away.
    cut.cutWhen((line) => line.includes("/collections/recipients/"));
    let queued: Row;
    try {
      const ana = await source.user({ name: "Ana" });
      queued = await rowFor(ana.id, "signup", source, read);
    } finally {
      cut.cutWhen(undefined);
    }
    expect(queued).toMatchObject({ kind: "event", status: "queued", attempts: 1 });

    // The events' `data` field renamed: the retry's re-read lacks a configured field.
    await source.renameField("events", "data", "payload");
    clock.advance(Date.parse(queued.next_attempt_at!) - clock.now().getTime() + 15_000);
    let waiting: Row | undefined;
    await eventually(async () => {
      waiting = (await read()).results.find((row) => row.id === queued.id);
      return waiting?.status === "waiting";
    }, "the waiting row");
    expect(waiting).toMatchObject({ status: "waiting", attempts: 2 });
    expect(waiting!.last_error).toContain('no field "data"');
    expect(Date.parse(waiting!.first_failed_at)).toBe(clock.now().getTime());
    expect(Date.parse(waiting!.next_attempt_at!)).toBeGreaterThan(clock.now().getTime());
  } finally {
    await f.close();
    cut.stop();
    await source.close();
  }
  expect(f.failures).toEqual([]);
});
