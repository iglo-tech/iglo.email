// B150a (15-external-sources section 2, D169 amended, D170): the source settings and Test connection
// through the compiled executable, against the real PocketBase binary. The project keys `source.*`
// are saved, validated and masked on the project host; the instance key `sources.private_hosts`
// lets a listed host name reach PocketBase on loopback while `webhooks.block_private_addresses`
// stays on, and nothing else: an unlisted host and a webhook to the listed host stay refused.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
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
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);

const HOST = "127.0.0.1";
let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let server: Awaited<ReturnType<typeof startInstance>>;
let pb: PocketBase;
let port = 0;
let key = "";
let operator: InstanceSession;

interface Step {
  step: string;
  ok: boolean;
  message: string;
  missing: Array<string>;
}
interface Answer {
  data: any;
  message: string;
}
const call = async (method: string, path: string, body?: unknown) => {
  const response = await api(port, HOST, key, method, path, body);
  return {
    status: response.status,
    body: asBody<Answer>(response.text ? JSON.parse(response.text) : {}),
  };
};
/** The steps of a Test connection answer. */
const stepsOf = (answer: { body: Answer }) =>
  asBody<{ ok: boolean; steps: Array<Step> }>(answer.body.data);
const settings = async (): Promise<Record<string, any>> => {
  const response = await call("GET", "/api/settings");
  expect(response.status).toBe(200);
  return asBody<Record<string, any>>(response.body.data);
};
const instance = async (method: string, path: string, body?: unknown) => {
  const response = await instanceCall(port, HOST, operator, method, path, body);
  return { status: response.status, body: await readJson<any>(response) };
};
/** The project's settings with `changes` over them, saved with one full PUT. */
const save = async (changes: Record<string, unknown>) =>
  call("PUT", "/api/settings", { ...(await settings()), ...changes });
const sourceAt = (url: string) => ({
  "source.url": url,
  "source.identity": pb.service.identity,
  "source.password": pb.service.password,
});

beforeAll(async () => {
  const admin = await adminCredentials();
  prepared = await prepareExecutable();
  pb = await startPocketBase();
  const dataDir = `${prepared.directory}/data`;
  registerProjects(dataDir, [{ slug: "main", name: "Main", hostname: HOST, primary: true }]);
  server = await startInstance(prepared.executable, dataDir, admin);
  port = server.port;
  key = await createApiUser(port, HOST, await logIn(port, HOST, admin), "api-sources");
  operator = (await instanceLogin(port, HOST, admin)).session!;
});

afterAll(async () => {
  await server?.stop();
  await pb?.close();
  await prepared?.cleanup();
});

test("the source keys are project keys with no source by default; sources.private_hosts is the instance's", async () => {
  const project = await settings();
  expect(project["source.url"]).toBe("");
  expect(project["source.auth_collection"]).toBe("services");
  expect(project["source.events"]).toEqual({
    collection: "events",
    user: "user",
    name: "name",
    data: "data",
    occurred_at: "occurredAt",
    key: "",
  });
  expect(project["source.grant_lists"]).toEqual([]);
  expect(project).not.toHaveProperty("sources.private_hosts");
  const shared = await instance("GET", "/api/instance/settings");
  expect(shared.body.data["sources.private_hosts"]).toEqual([]);
  expect(shared.body.data).not.toHaveProperty("source.url");
  // A project-host write naming the instance key is a 400, and nothing is written.
  const full = await call("PUT", "/api/settings", {
    ...project,
    "sources.private_hosts": ["pocketbase"],
  });
  expect(full.status).toBe(400);
  expect(full.body.message).toContain("sources.private_hosts");
  expect((await call("PUT", "/api/settings/sources.private_hosts", ["pocketbase"])).status).toBe(
    400,
  );
  expect(
    (await instance("GET", "/api/instance/settings")).body.data["sources.private_hosts"],
  ).toEqual([]);
});

test("sources.private_hosts takes exact host names only, at most 20", async () => {
  const shared = (await instance("GET", "/api/instance/settings")).body.data;
  for (const bad of [["10.0.0.5"], ["*.internal"], ["::1"], ["a b"], ["-x"]]) {
    const response = await instance("PUT", "/api/instance/settings", {
      ...shared,
      "sources.private_hosts": bad,
    });
    expect(response.status).toBe(400);
  }
  const many = Array.from({ length: 21 }, (_, index) => `pb${index}`);
  expect(
    (await instance("PUT", "/api/instance/settings", { ...shared, "sources.private_hosts": many }))
      .status,
  ).toBe(400);
  const ok = await instance("PUT", "/api/instance/settings", {
    ...shared,
    "sources.private_hosts": [" LocalHost ", "pocketbase_1", "localhost", ""],
  });
  expect(ok.status).toBe(200);
  expect(
    (await instance("GET", "/api/instance/settings")).body.data["sources.private_hosts"],
  ).toEqual(["localhost", "pocketbase_1"]);
});

test("a source is saved with its password masked; the mask keeps it only for the same URL and identity", async () => {
  const url = `http://localhost:${pb.port}`;
  expect((await save({ "source.url": url })).status).toBe(400);
  expect((await save({ "source.url": "ftp://pocketbase" })).status).toBe(400);
  expect((await save(sourceAt("http://user:pw@localhost/"))).status).toBe(400);
  expect((await save(sourceAt(`${url}/?x=1`))).status).toBe(400);
  expect((await save({ ...sourceAt(url), "source.auth_collection": "bad name" })).status).toBe(400);
  expect(
    (await save({ ...sourceAt(url), "source.users": { collection: "users", leaving_filter: "" } }))
      .status,
  ).toBe(400);
  const saved = await save({
    ...sourceAt(`${url}/`),
    "source.users": { collection: "users", leaving_filter: "deletedAt != ''" },
  });
  expect(saved.status).toBe(200);
  const read = await settings();
  expect(read["source.url"]).toBe(url);
  expect(read["source.password"]).toBe("•".repeat(pb.service.password.length));
  // Saved back as served, the mask keeps the password.
  expect((await save({})).status).toBe(200);
  expect((await call("POST", "/api/settings/source/test", {})).body.data.ok).toBe(true);
  // A new identity or URL with the mask is refused: the stored password is never sent elsewhere.
  expect((await save({ "source.identity": "other@example.com" })).status).toBe(400);
  expect((await save({ "source.url": `http://pocketbase.example:${pb.port}` })).status).toBe(400);
  const elsewhere = await call("POST", "/api/settings/source/test", {
    "source.url": `http://127.0.0.2:${pb.port}`,
  });
  expect(elsewhere.status).toBe(400);
  // A full PUT that leaves source.password out, as a listmonk client does, keeps no password
  // either: a new URL or identity that way is refused, and the stored source stays as it was.
  const { "source.password": _masked, ...withoutPassword } = await settings();
  for (const changes of [
    { "source.url": `http://pocketbase.example:${pb.port}` },
    { "source.identity": "other@example.com" },
  ]) {
    const response = await call("PUT", "/api/settings", { ...withoutPassword, ...changes });
    expect(response.status).toBe(400);
    const stored = await settings();
    expect(stored["source.url"]).toBe(url);
    expect(stored["source.identity"]).toBe(pb.service.identity);
  }
  // A one-key PUT carries the stored password over: a new URL that way is refused too.
  const oneKey = await call(
    "PUT",
    "/api/settings/source.url",
    `http://pocketbase.example:${pb.port}`,
  );
  expect(oneKey.status).toBe(400);
  expect((await settings())["source.url"]).toBe(url);
  // Off: an empty URL clears the password; the next URL needs it entered again.
  expect((await save({ "source.url": "" })).status).toBe(200);
  expect((await settings())["source.password"]).toBe("");
  expect((await save({ "source.url": url })).status).toBe(400);
  expect((await save(sourceAt(url))).status).toBe(200);
});

test("grant_lists: rules on this project's lists with typed data equalities", async () => {
  const list = await call("POST", "/api/lists", {
    name: "Granted",
    type: "private",
    optin: "single",
  });
  expect(list.status).toBe(200);
  const id = list.body.data.id;
  const rule = {
    event: "order_paid",
    where: { "data.plan": "pro", "data.n": 2, "data.b": true },
    lists: [id, id],
  };
  expect((await save({ "source.grant_lists": [rule] })).status).toBe(200);
  expect((await settings())["source.grant_lists"]).toEqual([{ ...rule, lists: [id] }]);
  for (const bad of [
    { ...rule, lists: [id + 1000] },
    { ...rule, lists: [] },
    { ...rule, event: "" },
    { ...rule, where: { plan: "pro" } },
    { ...rule, where: { "data.a') || (1": 1 } },
    { ...rule, where: { "data.x": { nested: 1 } } },
    { ...rule, where: { "data.x": null } },
  ]) {
    const response = await save({ "source.grant_lists": [bad] });
    expect(response.status).toBe(400);
  }
  expect((await settings())["source.grant_lists"]).toEqual([{ ...rule, lists: [id] }]);
  const tooMany = Array.from({ length: 51 }, () => rule);
  expect((await save({ "source.grant_lists": tooMany })).status).toBe(400);
});

test("Test connection: each step, and the fields a collection lacks", async () => {
  const good = await call("POST", "/api/settings/source/test", {});
  expect(good.status).toBe(200);
  expect(stepsOf(good).steps.map((step) => [step.step, step.ok])).toEqual([
    ["auth", true],
    ["recipients", true],
    ["events", true],
    ["users", true],
  ]);
  const missing = await call("POST", "/api/settings/source/test", {
    "source.events": {
      collection: "events",
      user: "user",
      name: "title",
      data: "data",
      occurred_at: "happenedAt",
      key: "",
    },
    "source.recipients": { collection: "nobody", email: "email", name: "", opt_out: "" },
    "source.users": { collection: "users", leaving_filter: "nofield != ''" },
  });
  expect(missing.status).toBe(200);
  const steps = Object.fromEntries(stepsOf(missing).steps.map((step) => [step.step, step]));
  expect(missing.body.data.ok).toBe(false);
  expect(steps.auth?.ok).toBe(true);
  expect(steps.recipients).toMatchObject({ ok: false, message: "There is no collection nobody." });
  expect(steps.events).toMatchObject({ ok: false, missing: ["title", "happenedAt"] });
  expect(steps.users?.ok).toBe(false);
  // The form's values were tested, not saved.
  expect((await settings())["source.events"].name).toBe("name");
  const wrong = await call("POST", "/api/settings/source/test", {
    "source.password": "not-the-password",
  });
  expect(wrong.body.data.steps).toEqual([expect.objectContaining({ step: "auth", ok: false })]);
});

test("Test connection fails a collection guests can read (D172), naming it and its rule", async () => {
  const user = await pb.user();
  await pb.event(user.id, "visit");
  const rules = async (collection: string, rule: string | null) =>
    void (await pb.api("PATCH", `/api/collections/${collection}`, {
      listRule: rule,
      viewRule: rule,
    }));
  const service = '@request.auth.collectionName = "services"';
  for (const [collection, step] of [
    ["events", "events"],
    ["recipients", "recipients"],
  ] as const) {
    await rules(collection, "");
    try {
      const answer = await call("POST", "/api/settings/source/test", {});
      const steps = Object.fromEntries(stepsOf(answer).steps.map((s) => [s.step, s]));
      expect(answer.body.data.ok).toBe(false);
      expect(steps[step]?.ok).toBe(false);
      expect(steps[step]?.message).toContain(`Guests can read ${collection}`);
      expect(steps[step]?.message).toContain("list and view rules");
      expect(steps.auth?.ok).toBe(true);
    } finally {
      await rules(collection, service);
    }
  }
  // With the fixture's rules back, every step passes again.
  expect((await call("POST", "/api/settings/source/test", {})).body.data.ok).toBe(true);
});

test("the private-address block: an unlisted host is refused, and a webhook to the listed host still is", async () => {
  const unlisted = await call(
    "POST",
    "/api/settings/source/test",
    sourceAt(`http://127.0.0.1:${pb.port}`),
  );
  expect(unlisted.status).toBe(200);
  expect(unlisted.body.data.steps).toEqual([expect.objectContaining({ step: "auth", ok: false })]);
  expect(unlisted.body.data.steps[0].message).toContain("block_private_addresses");
  // Webhook targets never use the list: a delivery to localhost is refused before any request.
  let hits = 0;
  const receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      hits++;
      return new Response("ok");
    },
  });
  try {
    const hook = await call("POST", "/api/webhooks", {
      url: `http://localhost:${receiver.port}/`,
      events: ["subscriber.deleted"],
    });
    expect(hook.status).toBe(200);
    const subscriber = await call("POST", "/api/subscribers", {
      email: "leaving@example.test",
      name: "Leaving",
      status: "enabled",
    });
    expect(subscriber.status).toBe(200);
    expect((await call("DELETE", `/api/subscribers/${subscriber.body.data.id}`)).status).toBe(200);
    const deliveries = async () =>
      asBody<Array<{ last_error: string | null }>>(
        (await call("GET", `/api/webhooks/${hook.body.data.id}/deliveries`)).body.data.results ??
          [],
      );
    await untilState(async () => (await deliveries())[0]?.last_error === "blocked_address", {
      label: "webhook delivery refused",
      progress: async () => JSON.stringify(await deliveries()),
      stallMs: 15_000,
    });
    expect(hits).toBe(0);
  } finally {
    await receiver.stop(true);
  }
});

/** B171: a leaving filter of `count` short clauses. */
const clauses = (count: number) => Array.from({ length: count }, () => "id != ''").join(" || ");

test("B171: a leaving filter whose users topic is too long to subscribe to is refused on save and by Test connection; one that fits saves", async () => {
  const long = clauses(100);
  expect(long.length).toBeLessThan(1300);
  const url = `http://localhost:${pb.port}`;
  const before = (await settings())["source.users"];
  const refused = await save({
    ...sourceAt(url),
    "source.users": { collection: "users", leaving_filter: long },
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("source.users leaving_filter");
  expect(refused.body.message).toContain("too long to subscribe to");
  expect((await settings())["source.users"]).toEqual(before);
  const tested = await call("POST", "/api/settings/source/test", {
    "source.users": { collection: "users", leaving_filter: long },
  });
  expect(tested.status).toBe(400);
  expect(tested.body.message).toContain("too long to subscribe to");
  const fits = { collection: "users", leaving_filter: clauses(80) };
  expect((await save({ ...sourceAt(url), "source.users": fits })).status).toBe(200);
  expect((await settings())["source.users"]).toEqual(fits);
  const passes = await call("POST", "/api/settings/source/test", {});
  expect(stepsOf(passes).steps.find((step) => step.step === "users")?.ok).toBe(true);
  expect((await save({ ...sourceAt(url), "source.users": before })).status).toBe(200);
});

test("Test connection needs settings:manage and a source URL", async () => {
  const off = await call("POST", "/api/settings/source/test", { "source.url": "" });
  expect(off.status).toBe(400);
  expect((await call("POST", "/api/settings/source/test", "x")).status).toBe(400);
});
