// B162a (15-external-sources sections 1 and 2, D187, D188): the instance's sources module and the
// project's connector. Through the compiled executable: a new instance starts with the module off,
// so the source keys, routes, MCP tools and admin screens are absent and an external sequence is
// refused; turned on, they are back and a source needs a connector, whose name the validation
// messages carry; an upgrade from a build before the switch turns it on for a project that read a
// source, sets its connector and resumes its stream. Through an instance in this process on a test
// clock: an external sequence's enrollment is held across days while the module is off, records
// made meanwhile reach nothing, and turning it on catches them up exactly once and the held
// enrollment goes on.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { openDatabase } from "@/db/connection";
import { TestClock } from "@/test/server/fixture";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
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
import { openLifecycle, PRIMARY } from "@/test/projects/lifecycle-fixture";
import { asBody, readJson } from "@/test/read-body";
import { startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

setDefaultTimeout(120_000);

const HOST = "127.0.0.1";
const SOURCE_TOOLS = ["test_source_settings", "get_source_retries"];

let pb: PocketBase;
beforeAll(async () => {
  pb = await startPocketBase();
});
afterAll(async () => {
  await pb?.close();
});

/** Polls (real time) until `check` holds. */
async function eventually(check: () => Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(100);
  }
}

interface Answer {
  status: number;
  body: any;
}

/** A project API caller on `port` with an API user's Basic header. */
function caller(port: number, key: string) {
  return async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await api(port, HOST, key, method, path, body);
    return { status: response.status, body: response.text ? JSON.parse(response.text) : {} };
  };
}

/** An instance API caller with the operator's session. */
function instanceCaller(port: number, operator: InstanceSession) {
  return async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await instanceCall(port, HOST, operator, method, path, body);
    return { status: response.status, body: await readJson<any>(response) };
  };
}

/** Sets instance keys over the current ones with one full PUT. */
async function setInstance(
  instance: ReturnType<typeof instanceCaller>,
  changes: Record<string, unknown>,
) {
  const shared = (await instance("GET", "/api/instance/settings")).body.data;
  const saved = await instance("PUT", "/api/instance/settings", { ...shared, ...changes });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

/** The source settings of the fixture schema at `url`, granting `list` on signup. */
const sourceKeys = (url: string, list?: number) => ({
  "source.connector": "pocketbase",
  "source.url": url,
  "source.identity": pb.service.identity,
  "source.password": pb.service.password,
  ...(list === undefined
    ? {}
    : { "source.grant_lists": [{ event: "signup", where: {}, lists: [list] }] }),
});

/** A JSON-RPC call to the MCP endpoint. */
async function rpc(port: number, key: string, method: string, params?: unknown) {
  const response = await request(port, HOST, "/api/mcp", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return asBody<{ result?: any; error?: { code: number; message: string } }>(await response.json());
}
const toolNames = async (port: number, key: string) =>
  asBody<Array<{ name: string }>>((await rpc(port, key, "tools/list")).result.tools).map(
    (tool) => tool.name,
  );

describe("the compiled executable", () => {
  let admin: Credentials;
  let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
  let server: Awaited<ReturnType<typeof startInstance>> | undefined;
  let dataDir = "";
  let port = 0;
  let key = "";
  let call: ReturnType<typeof caller>;
  let instance: ReturnType<typeof instanceCaller>;

  async function start() {
    server = await startInstance(prepared.executable, dataDir, admin);
    port = server.port;
    const operator = (await instanceLogin(port, HOST, admin)).session!;
    instance = instanceCaller(port, operator);
    call = caller(port, key);
  }

  beforeAll(async () => {
    admin = await adminCredentials();
    prepared = await prepareExecutable();
    dataDir = `${prepared.directory}/data`;
    registerProjects(dataDir, [{ slug: "main", name: "Main", hostname: HOST, primary: true }]);
    await start();
    key = await createApiUser(port, HOST, await logIn(port, HOST, admin), "api-module");
    call = caller(port, key);
  });
  afterAll(async () => {
    await server?.stop();
    await prepared?.cleanup();
  });

  test("a new instance has the module off: no source key, route, tool, screen or external sequence", async () => {
    expect((await instance("GET", "/api/instance/settings")).body.data["sources.enabled"]).toBe(
      false,
    );
    const project = (await call("GET", "/api/settings")).body.data;
    expect(Object.keys(project).filter((name) => name.startsWith("source"))).toEqual([]);
    // A write naming a source key is a 400 that says the module is off; nothing else is refused.
    for (const body of [
      { ...project, "source.url": `http://localhost:${pb.port}` },
      { ...project, "source.connector": "pocketbase" },
      { ...project, "source.grant_lists": [] },
    ]) {
      const refused = await call("PUT", "/api/settings", body);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain("External sources are off");
    }
    const oneKey = await call("PUT", "/api/settings/source.url", `http://localhost:${pb.port}`);
    expect(oneKey.status).toBe(400);
    expect(oneKey.body.message).toContain("External sources are off");
    expect((await call("PUT", "/api/settings", project)).status).toBe(200);
    // The switch is the instance's: a project write naming it is a 400.
    const named = await call("PUT", "/api/settings", { ...project, "sources.enabled": true });
    expect(named.status).toBe(400);
    expect(named.body.message).toContain("sources.enabled");
    expect((await call("PUT", "/api/settings/sources.enabled", true)).status).toBe(400);
    expect((await instance("GET", "/api/instance/settings")).body.data["sources.enabled"]).toBe(
      false,
    );
    // The source routes answer as an unknown route does, signed in or not.
    const unknown = await request(port, HOST, "/api/settings/source/nothing", { method: "POST" });
    const unknownBody = await unknown.text();
    expect(unknown.status).toBe(404);
    for (const [method, path] of [
      ["POST", "/api/settings/source/test"],
      ["GET", "/api/settings/source/retries"],
    ] as const) {
      for (const headers of [{ authorization: key }, {}]) {
        const absent = await request(port, HOST, path, { method, headers });
        expect(absent.status, `${method} ${path}`).toBe(404);
        expect(await absent.text()).toBe(unknownBody);
      }
    }
    // The source tools are not listed, and calling one is an unknown tool.
    const tools = await toolNames(port, key);
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.filter((name) => SOURCE_TOOLS.includes(name))).toEqual([]);
    const called = await rpc(port, key, "tools/call", { name: SOURCE_TOOLS[0], arguments: {} });
    expect(called.error?.message).toBe(`Unknown tool: ${SOURCE_TOOLS[0]}`);
    // The Settings page has no source tab and no retry queue link; the queue page is absent.
    const session = await logIn(port, HOST, admin);
    const page = await request(port, HOST, "/admin/settings", {
      headers: { cookie: session.cookie },
    });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('data-testid="settings-project"');
    expect(html).not.toContain('data-testid="source-settings"');
    expect(html).not.toContain("/admin/settings/source-retries");
    const retries = await request(port, HOST, "/admin/settings/source-retries", {
      headers: { cookie: session.cookie },
    });
    expect(retries.status).toBe(404);
    // An external sequence cannot be created; one on pushed events can.
    const template = await call("POST", "/api/templates", {
      name: "Module tx",
      type: "tx",
      subject: "Hi",
      body: "<p>Hi</p>",
    });
    expect(template.status).toBe(200);
    const definition = {
      name: "Off",
      trigger: { event: "signup" },
      steps: [{ wait: "P1D", kind: "transactional", template_id: template.body.data.id }],
    };
    const external = await call("POST", "/api/sequences", { ...definition, source: "external" });
    expect(external.status).toBe(400);
    expect(JSON.stringify(external.body)).toContain("sources.enabled");
    const pushed = await call("POST", "/api/sequences", definition);
    expect(pushed.status).toBe(200);
    // Changing it to external is refused too.
    const changed = await call("PUT", `/api/sequences/${pushed.body.data.id}`, {
      ...definition,
      source: "external",
    });
    expect(changed.status).toBe(400);
    expect(JSON.stringify(changed.body)).toContain("sources.enabled");
  });

  test("turned on: the source keys, routes and tools are back, and a source needs a connector its messages name", async () => {
    await setInstance(instance, {
      "sources.enabled": true,
      "sources.private_hosts": ["localhost"],
    });
    const project = (await call("GET", "/api/settings")).body.data;
    expect(project["source.connector"]).toBe("");
    expect(project["source.url"]).toBe("");
    const url = `http://localhost:${pb.port}`;
    // No connector: a URL is refused, naming the connectors.
    const bare = await call("PUT", "/api/settings", {
      ...project,
      ...sourceKeys(url),
      "source.connector": "",
    });
    expect(bare.status).toBe(400);
    expect(bare.body.message).toContain("source.connector");
    expect(bare.body.message).toContain("pocketbase");
    // An unknown connector is refused.
    const unknown = await call("PUT", "/api/settings", {
      ...project,
      ...sourceKeys(url),
      "source.connector": "elsewhere",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain("Invalid source.connector");
    // The chosen connector's display name is in the messages.
    const badUrl = await call("PUT", "/api/settings", { ...project, ...sourceKeys("ftp://x") });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.message).toContain("PocketBase");
    const badName = await call("PUT", "/api/settings", {
      ...project,
      ...sourceKeys(url),
      "source.auth_collection": "bad name",
    });
    expect(badName.status).toBe(400);
    expect(badName.body.message).toContain("use a PocketBase name");
    // Saved with its connector, the source reads.
    expect((await call("PUT", "/api/settings", { ...project, ...sourceKeys(url) })).status).toBe(
      200,
    );
    const saved = (await call("GET", "/api/settings")).body.data;
    expect(saved["source.connector"]).toBe("pocketbase");
    const tested = await call("POST", "/api/settings/source/test", {});
    expect(tested.status).toBe(200);
    expect(tested.body.data.ok).toBe(true);
    expect((await call("GET", "/api/settings/source/retries")).status).toBe(200);
    expect(
      (await toolNames(port, key)).filter((name) => SOURCE_TOOLS.includes(name)).sort(),
    ).toEqual([...SOURCE_TOOLS].sort());
    const session = await logIn(port, HOST, admin);
    const html = await (
      await request(port, HOST, "/admin/settings", { headers: { cookie: session.cookie } })
    ).text();
    expect(html).toContain('data-testid="source-settings"');
    expect(html).toContain('data-testid="source-connector"');
    expect(html).toContain("/admin/settings/source-retries");
    // Off again: the stored settings are kept and come back unchanged.
    await setInstance(instance, { "sources.enabled": false });
    expect(Object.keys((await call("GET", "/api/settings")).body.data)).not.toContain("source.url");
    await setInstance(instance, { "sources.enabled": true });
    const kept = (await call("GET", "/api/settings")).body.data;
    expect(kept["source.url"]).toBe(url);
    expect(kept["source.connector"]).toBe("pocketbase");
    expect(kept["source.password"]).toBe("•".repeat(pb.service.password.length));
  });

  test("an upgrade from a build before the switch turns it on, sets the connector and resumes the stream", async () => {
    const list = await call("POST", "/api/lists", {
      name: "Signed",
      type: "public",
      optin: "single",
    });
    expect(list.status).toBe(200);
    const project = (await call("GET", "/api/settings")).body.data;
    expect(
      (
        await call("PUT", "/api/settings", {
          ...project,
          ...sourceKeys(`http://localhost:${pb.port}`, list.body.data.id),
        })
      ).status,
    ).toBe(200);
    // The stream is live once a record reaches the subscriber list.
    const ana = await pb.user({ name: "Ana" });
    await eventually(async () => {
      if ((await call("GET", `/api/subscribers/external/${ana.id}`)).status === 200) {
        return true;
      }
      await pb.event(ana.id, "signup");
      await Bun.sleep(300);
      return false;
    }, "the stream to deliver a record");
    await server!.stop();
    server = undefined;
    // As a 2.2.1 data directory: no switch, no connector, the schema versions before B162a.
    const shared = openDatabase(dataDir, "instance.db");
    try {
      shared.run(
        "DELETE FROM settings WHERE key IN ('sources.enabled', 'sources.enabled_upgrade')",
      );
      shared.run("PRAGMA user_version = 4");
    } finally {
      shared.close();
    }
    const own = openDatabase(`${dataDir}/projects/main`);
    try {
      own.run("DELETE FROM settings WHERE key = 'source.connector'");
      own.run("PRAGMA user_version = 39");
    } finally {
      own.close();
    }
    // A record made while the instance is down is caught up from the stream's marker.
    const bea = await pb.user({ name: "Bea" });
    await pb.event(bea.id, "signup");
    await start();
    expect((await instance("GET", "/api/instance/settings")).body.data["sources.enabled"]).toBe(
      true,
    );
    const upgraded = (await call("GET", "/api/settings")).body.data;
    expect(upgraded["source.connector"]).toBe("pocketbase");
    expect(upgraded["source.url"]).toBe(`http://localhost:${pb.port}`);
    await eventually(
      async () => (await call("GET", `/api/subscribers/external/${bea.id}`)).status === 200,
      "the caught-up record",
    );
    const lists = asBody<Array<{ id: number }>>(
      (await call("GET", `/api/subscribers/external/${bea.id}`)).body.data.lists,
    );
    expect(lists.map((entry) => entry.id)).toContain(list.body.data.id);
  });
});

test("an upgrade with no project naming a source keeps the module off", async () => {
  const admin = await adminCredentials();
  const prepared = await prepareExecutable();
  try {
    const dataDir = `${prepared.directory}/data`;
    registerProjects(dataDir, [{ slug: "main", name: "Main", hostname: HOST, primary: true }]);
    // Upgraded from a build before the switch with no source anywhere: the switch stays off.
    let server = await startInstance(prepared.executable, dataDir, admin);
    await server.stop();
    const shared = openDatabase(dataDir, "instance.db");
    try {
      shared.run("DELETE FROM settings WHERE key = 'sources.enabled'");
      shared.run("PRAGMA user_version = 4");
    } finally {
      shared.close();
    }
    server = await startInstance(prepared.executable, dataDir, admin);
    try {
      const operator = (await instanceLogin(server.port, HOST, admin)).session!;
      const instance = instanceCaller(server.port, operator);
      expect((await instance("GET", "/api/instance/settings")).body.data["sources.enabled"]).toBe(
        false,
      );
    } finally {
      await server.stop();
    }
  } finally {
    await prepared.cleanup();
  }
});

test("off, an external enrollment is held for days and new records reach nothing; on, they are caught up once and the enrollment goes on", async () => {
  const clock = new TestClock();
  const f = await openLifecycle(clock);
  try {
    const instance = async (method: string, path: string, body?: unknown) => {
      const response = await f.call(method, path, body);
      return { status: response.status, body: await readJson<any>(response) };
    };
    await setInstance(instance, {
      "sources.enabled": true,
      "sources.private_hosts": ["localhost"],
    });
    const key = await createApiUser(
      f.port,
      PRIMARY,
      await logIn(f.port, PRIMARY, f.admin),
      "api-held",
    );
    const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
      const response = await api(f.port, PRIMARY, key, method, path, body);
      return { status: response.status, body: response.text ? JSON.parse(response.text) : {} };
    };
    const list = await call("POST", "/api/lists", {
      name: "News",
      type: "public",
      optin: "single",
    });
    const project = (await call("GET", "/api/settings")).body.data;
    expect(
      (
        await call("PUT", "/api/settings", {
          ...project,
          ...sourceKeys(`http://localhost:${pb.port}`, list.body.data.id),
        })
      ).status,
    ).toBe(200);
    const template = await call("POST", "/api/templates", {
      name: "Held tx",
      type: "tx",
      subject: "Hi",
      body: "<p>Hi</p>",
    });
    const sequence = await call("POST", "/api/sequences", {
      name: "Held",
      status: "active",
      source: "external",
      reentry: "never",
      trigger: { event: "signup" },
      steps: [{ wait: "P1D", kind: "transactional", template_id: template.body.data.id }],
    });
    expect(sequence.status, JSON.stringify(sequence.body)).toBe(200);
    const sequenceId = sequence.body.data.id;
    const enrollmentsOf = async (externalId: string) => {
      const subscriber = await call("GET", `/api/subscribers/external/${externalId}`);
      if (subscriber.status !== 200) {
        return null;
      }
      const page = await call(
        "GET",
        `/api/enrollments?sequence_id=${sequenceId}&subscriber_id=${subscriber.body.data.id}`,
      );
      return asBody<Array<Record<string, any>>>(page.body.data.results);
    };
    // A record reaches the stream once it is live: Ana enrolls.
    const ana = await pb.user({ name: "Ana" });
    await eventually(async () => {
      if (((await enrollmentsOf(ana.id)) ?? []).length) {
        return true;
      }
      await pb.event(ana.id, "signup");
      await Bun.sleep(300);
      return false;
    }, "Ana's enrollment");
    const [enrolled] = (await enrollmentsOf(ana.id))!;
    expect(enrolled).toMatchObject({ status: "active", exit_reason: null, error_since: null });
    // The step comes due while the source is down: its send-time read fails for now, so the
    // enrollment waits with its outage window open (D172).
    await pb.stop();
    clock.advance(86_400_000);
    let held: Record<string, any> = enrolled!;
    await eventually(async () => {
      clock.advance(60_000);
      held = (await call("GET", `/api/enrollments/${enrolled!.id}`)).body.data;
      return held.error_since !== null;
    }, "the step to wait for the source");
    expect(held).toMatchObject({ status: "active", exit_reason: null, step_id: enrolled!.step_id });

    // Off: the source routes go, and records made meanwhile reach nothing.
    await setInstance(instance, { "sources.enabled": false });
    expect((await call("GET", "/api/settings/source/retries")).status).toBe(404);
    await pb.start();
    const bob = await pb.user({ name: "Bob" });
    await pb.event(bob.id, "signup");
    // Four days on the test clock, an hour at a time: the held enrollment is never claimed, and its
    // 72-hour window never ends it.
    for (let hour = 0; hour < 96; hour++) {
      clock.advance(3_600_000);
      await Bun.sleep(5);
    }
    await Bun.sleep(500);
    expect((await call("GET", `/api/subscribers/external/${bob.id}`)).status).toBe(404);
    // With its source still stored, no external sequence can be created while off.
    const refused = await call("POST", "/api/sequences", {
      name: "While off",
      source: "external",
      trigger: { event: "signup" },
      steps: [{ wait: "P1D", kind: "transactional", template_id: template.body.data.id }],
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("sources.enabled");
    const during = (await call("GET", `/api/enrollments/${held.id}`)).body.data;
    expect(during).toMatchObject({
      status: "active",
      exit_reason: null,
      error_since: held.error_since,
      step_id: held.step_id,
      updated_at: held.updated_at,
    });
    // The sequence page says the module is off.
    const session = await logIn(f.port, PRIMARY, f.admin);
    const page = await request(f.port, PRIMARY, `/admin/sequences/${sequenceId}`, {
      headers: { cookie: session.cookie },
    });
    expect(await page.text()).toContain('data-testid="sources-off"');

    // On again: the held enrollment's outage window starts anew, Bob's record is caught up once,
    // and the held enrollment goes on.
    await setInstance(instance, { "sources.enabled": true });
    expect((await call("GET", `/api/enrollments/${held.id}`)).body.data).toMatchObject({
      status: "active",
      error_since: null,
    });
    await eventually(async () => ((await enrollmentsOf(bob.id)) ?? []).length > 0, "Bob's record");
    expect((await call("GET", `/api/subscribers/external/${bob.id}`)).body.data.lists).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: list.body.data.id })]),
    );
    await eventually(async () => {
      clock.advance(60_000);
      const now = (await call("GET", `/api/enrollments/${held.id}`)).body.data;
      return now.status !== "active";
    }, "the held enrollment to go on");
    const after = (await call("GET", `/api/enrollments/${held.id}`)).body.data;
    expect(after.status).toBe("completed");
    expect(after.exit_reason).toBeNull();
    // Off and on once more: nothing is delivered twice.
    await setInstance(instance, { "sources.enabled": false });
    await setInstance(instance, { "sources.enabled": true });
    await eventually(
      async () => (await call("GET", "/api/settings/source/retries")).body.data?.stream === "live",
      "the stream live again",
    );
    await Bun.sleep(1000);
    expect((await enrollmentsOf(bob.id))!.length).toBe(1);
    expect((await enrollmentsOf(ana.id))!.length).toBe(1);
  } finally {
    await f.close();
  }
  expect(f.failures).toEqual([]);
});
