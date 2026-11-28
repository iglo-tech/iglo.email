// B150d (15-external-sources sections 4, 5 and 7, D173): the server runs a project's source stream
// with the record handler. Through the compiled executable and the real PocketBase 0.40.5 binary:
// saving a source starts the stream at once (a settings save is compared immediately), a record
// under a grant rule's event creates the subscriber with the grant, a users record matching the
// leaving filter removes it, and clearing the source stops the stream. The private-address block
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
  startInstance,
} from "@/test/projects/fixture";
import { asBody, readJson } from "@/test/read-body";
import { startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

setDefaultTimeout(90_000);

const HOST = "127.0.0.1";
let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let server: Awaited<ReturnType<typeof startInstance>>;
let pb: PocketBase;
let port = 0;
let key = "";

const call = async (method: string, path: string, body?: unknown) => {
  const response = await api(port, HOST, key, method, path, body);
  return {
    status: response.status,
    body: asBody<{ data: any; message: string }>(response.text ? JSON.parse(response.text) : {}),
  };
};

/** Polls (real time, the server's clock is real) until `check` holds. */
async function eventually(check: () => Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  const admin = await adminCredentials();
  prepared = await prepareExecutable();
  pb = await startPocketBase();
  const dataDir = `${prepared.directory}/data`;
  registerProjects(dataDir, [{ slug: "main", name: "Main", hostname: HOST, primary: true }]);
  server = await startInstance(prepared.executable, dataDir, admin);
  port = server.port;
  key = await createApiUser(port, HOST, await logIn(port, HOST, admin), "api-records");
  const operator = (await instanceLogin(port, HOST, admin)).session!;
  const shared = await readJson<any>(
    await instanceCall(port, HOST, operator, "GET", "/api/instance/settings"),
  );
  const allowed = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
    ...shared.data,
    "sources.private_hosts": ["localhost"],
    "sources.enabled": true,
  });
  expect(allowed.status).toBe(200);
});

afterAll(async () => {
  await server?.stop();
  await pb?.close();
  await prepared?.cleanup();
});

test("a saved source starts the stream: a record grants and creates the subscriber, a leaving user removes it", async () => {
  const list = await call("POST", "/api/lists", { name: "News", type: "public", optin: "single" });
  expect(list.status).toBe(200);
  const news = asBody<number>(list.body.data.id);
  const current = await call("GET", "/api/settings");
  const saved = await call("PUT", "/api/settings", {
    ...current.body.data,
    "source.connector": "pocketbase",
    "source.url": `http://localhost:${pb.port}`,
    "source.identity": pb.service.identity,
    "source.password": pb.service.password,
    "source.users": { collection: "users", leaving_filter: "deletedAt != ''" },
    "source.grant_lists": [{ event: "signup", where: {}, lists: [news] }],
  });
  expect(saved.status).toBe(200);

  const ana = await pb.user({ name: "Ana" });
  const linked = () => call("GET", `/api/subscribers/external/${ana.id}`);
  // The stream subscribes a moment after the save; a record made before it is caught up only
  // from the connection's time, so the record is made again until one arrives.
  await eventually(async () => {
    if ((await linked()).status === 200) {
      return true;
    }
    await pb.event(ana.id, "signup");
    await Bun.sleep(400);
    return (await linked()).status === 200;
  }, "the subscriber");
  const subscriber = (await linked()).body.data;
  expect(subscriber).toMatchObject({ email: ana.email, name: "Ana", external_id: ana.id });
  expect(
    asBody<Array<{ id: number; subscription_status: string }>>(subscriber.lists).map((l) => [
      l.id,
      l.subscription_status,
    ]),
  ).toEqual([[news, "confirmed"]]);

  await pb.update("users", ana.id, { deletedAt: new Date().toISOString() });
  await eventually(async () => (await linked()).status === 404, "the subscriber's removal");

  // No source: the stream stops, and a new record creates nothing.
  const off = await call("GET", "/api/settings");
  expect((await call("PUT", "/api/settings", { ...off.body.data, "source.url": "" })).status).toBe(
    200,
  );
  const bob = await pb.user();
  await pb.event(bob.id, "signup");
  await Bun.sleep(1000);
  expect((await call("GET", `/api/subscribers/external/${bob.id}`)).status).toBe(404);
});
