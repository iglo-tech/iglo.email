// B138b (14-projects sections 1, 2, 9, 10, 15): the instance data directory, the refusal of the
// earlier layout, an instance without a primary project, and the routing table changing while it
// runs. The layout and no-primary cases run the compiled executable on port 0; the routing table is
// changed through the instance's own function in process, since nothing outside it changes it yet.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstance } from "@/projects/instance";
import type { Instance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { readJson } from "@/test/read-body";
import {
  adminCredentials,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  sessionHeaders,
  spawnInstance,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";

setDefaultTimeout(30_000);

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let admin: Credentials;

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
});

afterAll(async () => {
  await prepared?.cleanup();
});

const dataDirectory = () => join(prepared.directory, crypto.randomUUID());

test("a fresh install is an instance with one primary project, and behaves as one install", async () => {
  const dataDir = dataDirectory();
  const server = await startInstance(prepared.executable, dataDir, admin);
  try {
    const health = await request(server.port, "127.0.0.1", "/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ data: true });
    // The admin seeded from the environment logs in on the instance host and on any other host.
    await logIn(server.port, "127.0.0.1", admin);
    await logIn(server.port, "anything.example.test", admin);
  } finally {
    expect((await server.stop()).code).toBe(0);
  }
  expect(readdirSync(dataDir).sort()).toEqual(["iglo-email.lock", "instance.db", "projects"]);
  expect(readdirSync(join(dataDir, "projects"))).toEqual(["main"]);
  expect(existsSync(join(dataDir, "projects", "main", "iglo-email.db"))).toBe(true);
  // A second start finds the same instance and project.
  const again = await startInstance(prepared.executable, dataDir, admin);
  try {
    await logIn(again.port, "127.0.0.1", admin);
  } finally {
    expect((await again.stop()).code).toBe(0);
  }
  expect(readdirSync(join(dataDir, "projects"))).toEqual(["main"]);
});

test("a data directory of the earlier layout is refused, and nothing is written to it", async () => {
  const dataDir = dataDirectory();
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "iglo-email.db"), "");
  const child = spawnInstance(prepared.executable, dataDir, admin);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe(
    `${dataDir} is a data directory from an earlier iglo.email: it has iglo-email.db at its root. ` +
      "The data directory layout changed and nothing is converted; start with an empty data directory. " +
      "An earlier backup is restored into projects/main/ of the new data directory.\n",
  );
  expect(readdirSync(dataDir)).toEqual(["iglo-email.db"]);
});

test("without a primary project: health answers, /admin redirects, anything else is a plain 404", async () => {
  const dataDir = dataDirectory();
  registerProjects(dataDir, [{ slug: "a", name: "A", hostname: "a.example.test" }]);
  const server = await startInstance(prepared.executable, dataDir, admin);
  try {
    for (const host of ["127.0.0.1", "unclaimed.example.test"]) {
      const health = await request(server.port, host, "/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ data: true });
      for (const path of ["/admin", "/admin/campaigns"]) {
        const admin = await request(server.port, host, path);
        expect(admin.status).toBe(302);
        expect(admin.headers.get("location")).toBe("http://127.0.0.1/admin/instance/projects");
      }
      // The Projects page (B143a) is the instance's: without a session it goes to the login.
      const projects = await request(server.port, host, "/admin/instance/projects");
      expect(projects.status).toBe(307);
      expect(projects.headers.get("location")).toStartWith("/admin/instance/login?");
      for (const path of ["/api/lists", "/", "/subscription/form", "/admin/instance/nothing"]) {
        const missing = await request(server.port, host, path);
        expect(missing.status).toBe(404);
        expect(missing.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(await missing.text()).toBe("404 page not found\n");
      }
    }
    // The project on its own host is served as ever.
    await logIn(server.port, "a.example.test", admin);
  } finally {
    await server.stop();
  }
  const stopped = await server.stop();
  expect(stopped.code).toBe(0);
  // No line per refused request.
  expect(stopped.stderr).toBe("");
});

test("a project added and removed while the instance runs is served, then answers as an unclaimed host", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-routing-"));
  let instance: Instance | undefined;
  let server: ReturnType<typeof serveRouted> | undefined;
  const failures: Array<unknown> = [];
  try {
    instance = await openInstance(
      {
        dataDir,
        rootUrl: "http://127.0.0.1",
        listen: { host: "127.0.0.1", port: 0 },
        seed: { admin: { user: admin.user, password: admin.password } },
      },
      createRealClock(),
    );
    const opened = instance;
    server = serveRouted({ host: "127.0.0.1", port: 0 }, (incoming, peer) =>
      opened.dispatch(incoming, peer),
    );
    instance.attach(server);
    instance.start((failure) => failures.push(failure));
    const port = server.port!;
    const host = "c.example.test";

    const record = await instance.add({ slug: "c", name: "C", hostname: host });
    expect(record.hostname).toBe(host);
    expect(existsSync(join(dataDir, "projects", "c", "iglo-email.db"))).toBe(true);
    const session = await logIn(port, host, admin);
    const settings = await request(port, host, "/api/settings", {
      headers: sessionHeaders(session),
    });
    expect(settings.status).toBe(200);
    const body = await readJson<{ data: Record<string, unknown> }>(settings);
    expect(body.data["app.root_url"]).toBe(`http://${host}`);
    // The primary does not know c's session.
    const onPrimary = await request(port, "127.0.0.1", "/api/settings", {
      headers: sessionHeaders(session),
    });
    expect([401, 403]).toContain(onPrimary.status);

    expect(await instance.remove("c")).not.toBeNull();
    // c's host now reaches the primary, which knows nothing of c's session.
    const after = await request(port, host, "/api/settings", { headers: sessionHeaders(session) });
    expect([401, 403]).toContain(after.status);
    const primary = await logIn(port, host, admin);
    const primarySettings = await request(port, host, "/api/settings", {
      headers: sessionHeaders(primary),
    });
    expect((await readJson<{ data: Record<string, unknown> }>(primarySettings)).data).toMatchObject(
      { "app.root_url": "http://127.0.0.1" },
    );
    expect(instance.projects().map((project) => project.slug)).toEqual(["main"]);
    expect(await instance.remove("c")).toBeNull();
  } finally {
    if (instance) {
      await Promise.allSettled(instance.stop());
    }
    await server?.stop(true);
    await instance?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  expect(failures).toEqual([]);
});

test("a project cannot take the instance host, a second primary or a taken hostname", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-routing-"));
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: "http://127.0.0.1",
      listen: { host: "127.0.0.1", port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    createRealClock(),
  );
  /** The message a refused add gives, or "" when it was accepted. */
  const refusal = (input: Parameters<Instance["add"]>[0]) =>
    instance.add(input).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  try {
    expect(await refusal({ slug: "x", name: "X", hostname: "127.0.0.1" })).toContain(
      "can only be the primary project's",
    );
    expect(await refusal({ slug: "y", name: "Y", hostname: "127.0.0.1", primary: true })).toBe(
      "There is a primary project already",
    );
    expect(await refusal({ slug: "Bad", name: "Z", hostname: "z.example.test" })).toContain(
      "Invalid project slug",
    );
    await instance.add({ slug: "d", name: "D", hostname: "d.example.test" });
    expect(await refusal({ slug: "e", name: "E", hostname: "D.example.test" })).toBe(
      "A hostname belongs to another project",
    );
    // A refused project leaves no directory behind.
    expect(readdirSync(join(dataDir, "projects")).sort()).toEqual(["d", "main"]);
  } finally {
    await Promise.allSettled(instance.stop());
    await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
