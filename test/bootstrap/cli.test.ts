import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { healthWhenReady, restartOnPort, startOnFreePort, stopChild } from "@/test/serve-port";
import { ensureProductionBuild } from "@/test/production-build";
import { startDbFixture } from "@/test/db/fixture";
import { startSchemaFixture } from "@/test/schema/fixture";

const repository = resolve(import.meta.dir, "../..");
setDefaultTimeout(15_000);
let temporaryDirectory = "";
let executable = "";
let adminUser = "";
let adminPassword = "";

beforeAll(async () => {
  const fixture = await Bun.file(join(repository, "test/bootstrap/fixtures.md")).text();
  adminUser = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1] ?? "";
  adminPassword = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1] ?? "";
  if (!adminUser || !adminPassword) {
    throw new Error("Bootstrap test credentials are missing");
  }

  await ensureProductionBuild();

  temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-bootstrap-"));
  executable = join(temporaryDirectory, "iglo.email");
  await copyFile(join(repository, "dist", "iglo.email"), executable);
  await chmod(executable, 0o755);
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function start(args: Array<string>, env: Record<string, string> = {}) {
  return Bun.spawn([executable, ...args], {
    cwd: temporaryDirectory,
    env: { PATH: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(args: Array<string>, env: Record<string, string> = {}) {
  const child = start(args, env);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 3000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) {
      throw new Error(`CLI did not exit: ${args.join(" ")}`);
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One start on `port`: the executable answers /health on it and listens on it, or the child is
 * killed and the start fails. `build` gives the arguments for the port.
 */
async function launch(
  port: number,
  build: (port: number) => { args: Array<string>; env?: Record<string, string> },
) {
  const { args, env = {} } = build(port);
  const child = start(args, env);
  try {
    await healthWhenReady(child, port);
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  }
  return child;
}

/**
 * The executable started on a free port. `build` gives the arguments from the port; a start that
 * reports its port in use is retried on another port.
 */
function startOnPort(
  build: (port: number) => { args: Array<string>; env?: Record<string, string> },
) {
  return startOnFreePort(async (port) => ({ child: await launch(port, build), port }));
}

/**
 * Stops a child and returns its exit code. A non-zero exit fails with the stderr the child wrote,
 * so a failure says why the process ended and not only its code.
 */
async function shutDown(child: ReturnType<typeof start>, signal: "SIGTERM" | "SIGINT") {
  // 3 s, not the helper's 5 s: a serial `bun test` gives each test 5 s, so SIGKILL must come first.
  const code = await stopChild(child, signal, 3000);
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(
      `Server exited with ${code} after ${signal} (signal ${child.signalCode}): ${stderr}`,
    );
  }
  return code;
}

async function login(
  port: number,
  username: string,
  password: string,
  headers: Record<string, string> = {},
) {
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(`${base}/admin/login?next=%2Fapi%2Fprofile`, { headers });
  const html = await page.text();
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1];
  const cookie = page.headers
    .getSetCookie()
    .find((item) => item.startsWith("nonce="))
    ?.split(";", 1)[0];
  if (!nonce || !cookie) {
    throw new Error("Login form is missing its nonce");
  }
  return fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ username, password, nonce, next: "/api/profile" }),
  });
}

const tokenAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** A synthetic API token in the format generated tokens have: 48 letters and digits. */
const apiTokenValue = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(48)), (byte) => tokenAlphabet[byte % 62]).join(
    "",
  );

/** Reads a guarded endpoint with an API credential, as an app integration does. */
function apiGet(port: number, user: string, token: string) {
  return fetch(`http://127.0.0.1:${port}/api/settings`, {
    headers: { authorization: `token ${user}:${token}` },
  });
}

describe("compiled executable", () => {
  test("unprovisioned startup denies login and partial bootstrap pairs fail", async () => {
    const dataDir = join(temporaryDirectory, "unprovisioned-auth");
    const { child, port } = await startOnPort((listenPort) => ({
      args: ["--port", String(listenPort), "--data-dir", dataDir],
    }));
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
      const attempt = await login(port, adminUser, adminPassword);
      expect(attempt.status).toBe(200);
      expect(await attempt.text()).toContain("Invalid login or password");
      expect(attempt.headers.getSetCookie().some((item) => item.startsWith("session="))).toBe(
        false,
      );
      const api = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(api.status).toBe(403);
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
    for (const env of [
      { IGLO_EMAIL_ADMIN_USER: adminUser },
      { IGLO_EMAIL_ADMIN_PASSWORD: adminPassword },
      { IGLO_EMAIL_ADMIN_USER: "", IGLO_EMAIL_ADMIN_PASSWORD: "" },
    ]) {
      const result = await runCli(
        ["--data-dir", join(temporaryDirectory, `partial-${crypto.randomUUID()}`)],
        env,
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("requires both");
      expect(result.stderr).not.toContain(adminPassword);
    }
  });

  test("compiled sessions survive restart and existing users ignore bootstrap inputs", async () => {
    const dataDir = join(temporaryDirectory, "persistent-auth");
    const args = (listenPort: number) => [
      "--port",
      String(listenPort),
      "--data-dir",
      dataDir,
      "--root-url",
      `https://127.0.0.1:${listenPort}`,
    ];
    const { child: first, port } = await startOnPort((listenPort) => ({
      args: args(listenPort),
      env: { IGLO_EMAIL_ADMIN_USER: adminUser, IGLO_EMAIL_ADMIN_PASSWORD: adminPassword },
    }));
    let session = "";
    try {
      expect((await healthWhenReady(first, port)).status).toBe(200);
      const result = await login(port, adminUser, adminPassword);
      expect(result.status).toBe(302);
      const cookies = result.headers.getSetCookie();
      const sessionCookie = cookies.find((item) => item.startsWith("session=")) ?? "";
      expect(sessionCookie).toContain("Secure");
      expect(sessionCookie).toContain("HttpOnly");
      expect(sessionCookie).toContain("SameSite=Lax");
      session = sessionCookie.split(";", 1)[0] ?? "";
      expect(session).not.toBe("");
    } finally {
      expect(await shutDown(first, "SIGTERM")).toBe(0);
    }
    // The restart reuses the port its predecessor released, with the same retry as a fresh start.
    const second = await restartOnPort(port, (listenPort) =>
      launch(listenPort, () => ({
        args: args(listenPort),
        env: { IGLO_EMAIL_ADMIN_USER: "replacement-admin" },
      })),
    );
    try {
      expect((await healthWhenReady(second, port)).status).toBe(200);
      const profile = await fetch(`http://127.0.0.1:${port}/api/profile`, {
        headers: { cookie: session },
      });
      expect(profile.status).toBe(200);
      expect(((await profile.json()) as { data: { username: string } }).data.username).toBe(
        adminUser,
      );
      expect((await login(port, adminUser, adminPassword)).status).toBe(302);
      expect((await login(port, "replacement-admin", adminPassword)).status).toBe(200);
    } finally {
      expect(await shutDown(second, "SIGTERM")).toBe(0);
    }
  });
  test("serves the upstream health response outside the checkout and stops on SIGTERM", async () => {
    const { child, port } = await startOnPort((listenPort) => ({
      args: ["serve", "--port", String(listenPort)],
      env: { IGLO_EMAIL_ADMIN_USER: adminUser, IGLO_EMAIL_ADMIN_PASSWORD: adminPassword },
    }));
    try {
      const response = await healthWhenReady(child, port);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      const body = await response.text();
      expect(body).toBe('{"data":true}\n');
      expect(body).not.toContain(adminUser);
      expect(body).not.toContain(adminPassword);
      const wrongMethod = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "POST",
        signal: AbortSignal.timeout(1000),
      });
      expect(wrongMethod.status).not.toBe(200);
      const unknownPath = await fetch(`http://127.0.0.1:${port}/missing`, {
        signal: AbortSignal.timeout(1000),
      });
      expect(unknownPath.status).toBe(404);
      for (const path of ["/api/not-present", "/api/lang/en"]) {
        const apiResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(1000),
        });
        expect(apiResponse.status).toBe(404);
        expect(apiResponse.headers.get("content-type")).toBe("application/json");
        expect(await apiResponse.text()).toBe('{"message":"404 unknown endpoint"}\n');
      }
      const protectedHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(protectedHealth.status).toBe(403);
      expect(await protectedHealth.text()).toBe('{"message":"invalid session"}\n');
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("flags override environment values and SIGINT closes the server", async () => {
    const { child, port } = await startOnPort((listenPort) => ({
      args: [
        "serve",
        `--port=${listenPort}`,
        "--host",
        "127.0.0.1",
        "--data-dir",
        "./chosen-data",
        "--root-url=https://example.test/root",
      ],
      env: {
        IGLO_EMAIL_PORT: "invalid",
        IGLO_EMAIL_HOST: "invalid host",
        IGLO_EMAIL_DATA_DIR: "",
        IGLO_EMAIL_ROOT_URL: "not-a-url",
      },
    }));
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
    } finally {
      expect(await shutDown(child, "SIGINT")).toBe(0);
    }
  });

  test("environment bootstrap values work without flags or admin credentials", async () => {
    const { child, port } = await startOnPort((listenPort) => ({
      args: [],
      env: {
        IGLO_EMAIL_PORT: String(listenPort),
        IGLO_EMAIL_HOST: "127.0.0.1",
        IGLO_EMAIL_DATA_DIR: "./env-data",
        IGLO_EMAIL_ROOT_URL: "https://example.test",
      },
    }));
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
  });

  test("opens the persistent version-two production schema on standalone restart", async () => {
    const dataDir = join(temporaryDirectory, "persistent-db");
    for (let i = 0; i < 2; i++) {
      const { child, port } = await startOnPort((listenPort) => ({
        args: ["--port", String(listenPort), "--data-dir", dataDir],
      }));
      try {
        expect((await healthWhenReady(child, port)).status).toBe(200);
      } finally {
        expect(await shutDown(child, "SIGTERM")).toBe(0);
      }
      if (i === 0) {
        const seed = startSchemaFixture(dataDir);
        try {
          const result = await fetch(seed.origin, {
            method: "POST",
            body: JSON.stringify({ action: "persist" }),
          });
          expect(result.status).toBe(200);
        } finally {
          await seed.close();
        }
      }
    }
    const fixture = startSchemaFixture(dataDir);
    try {
      const response = await fetch(fixture.origin, {
        method: "POST",
        body: JSON.stringify({ action: "status" }),
        signal: AbortSignal.timeout(3000),
      });
      const { result } = (await response.json()) as {
        result: {
          version: string;
          shapes: Record<string, Array<string>>;
          integrity: string;
          foreignKeyErrors: Array<unknown>;
          backups: Array<string>;
        };
      };
      expect(result).toMatchObject({
        version: "25",
        integrity: "ok",
        foreignKeyErrors: [],
        backups: [],
      });
      expect(result.shapes.subscribers).toContain("external_id");
      expect(result.shapes.sends).toContain("idempotency_key");
      const search = await fetch(fixture.origin, {
        method: "POST",
        body: JSON.stringify({ action: "read-persist" }),
      });
      expect(((await search.json()) as { result: Array<string> }).result).toEqual([
        "persistent@example.test",
      ]);
      expect(result.shapes.mat_list_subscriber_stats).toEqual([
        "updated_at",
        "list_id",
        "status",
        "subscriber_count",
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("fails cleanly when the data directory cannot be created or the port is occupied", async () => {
    const blocked = join(temporaryDirectory, "not-a-directory");
    await writeFile(blocked, "synthetic fixture");
    const failure = await runCli(["--data-dir", join(blocked, "child")]);
    expect(failure.code).not.toBe(0);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).not.toBe("");

    // Only the bound port matters. Drop inbound connections (such as the host runtime's
    // keep-alive port probes) so close() doesn't wait on them.
    const socket = createServer((connection) => connection.destroy());
    await new Promise<void>((resolveListen, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = socket.address();
      if (!address || typeof address === "string") {
        throw new Error("No test port was assigned");
      }
      const dataDir = join(temporaryDirectory, "listen-failure");
      const result = await runCli(["--port", String(address.port), "--data-dir", dataDir]);
      expect(result.code).not.toBe(0);
      const fixture = startDbFixture(dataDir);
      try {
        const response = await fetch(fixture.origin, {
          method: "POST",
          body: JSON.stringify({ action: "status" }),
          signal: AbortSignal.timeout(3000),
        });
        expect(
          ((await response.json()) as { result: { integrity: string } }).result.integrity,
        ).toBe("ok");
      } finally {
        await fixture.close();
      }
    } finally {
      await new Promise<void>((resolveClose) => {
        socket.close(() => resolveClose());
      });
    }
  });

  test("help describes the bootstrap options", async () => {
    for (const args of [["--help"], ["serve", "--help"]]) {
      const result = await runCli(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--port");
      expect(result.stdout).toContain("IGLO_EMAIL_ROOT_URL");
      expect(result.stdout).toContain("9000");
      expect(result.stdout).toContain("127.0.0.1");
      expect(result.stdout).toContain("./data");
      expect(result.stderr).toBe("");
    }
  });

  test("rejects every removed flag and points to the scope document", async () => {
    for (const flag of [
      "--install",
      "--upgrade",
      "--config",
      "--config=old.toml",
      "--new-config",
    ]) {
      for (const prefix of [[], ["serve"]]) {
        const result = await runCli([...prefix, flag]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(flag.split("=")[0]!);
        expect(result.stderr).toContain("docs/design/01-scope.md");
      }
    }
  });

  test("rejects unknown commands, flags, and missing option values", async () => {
    for (const [args, message] of [
      [["restore"], "Unknown command"],
      [["serve", "--mystery"], "Unknown flag"],
      [["serve", "--port"], "--port"],
      [["serve", "--port", "--host", "127.0.0.1"], "--port"],
    ] as const) {
      const result = await runCli([...args]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
  });

  test("rejects invalid bootstrap values from flags and environment", async () => {
    for (const [args, env, message] of [
      [["--port", "0"], {}, "port"],
      [["--port", "65536"], {}, "port"],
      [["--port", "1.5"], {}, "port"],
      [["--host", "http://127.0.0.1"], {}, "host"],
      [["--host", "[localhost]"], {}, "host"],
      [["--data-dir="], {}, "data-dir"],
      [["--root-url", "file:///tmp"], {}, "root-url"],
      [["--root-url", "https://user:password@example.test"], {}, "root-url"],
      [["--root-url", "https://example.test/?q=value"], {}, "root-url"],
      [[], { IGLO_EMAIL_PORT: "abc" }, "port"],
      [[], { IGLO_EMAIL_HOST: "bad host" }, "host"],
      [[], { IGLO_EMAIL_DATA_DIR: "" }, "data-dir"],
      [[], { IGLO_EMAIL_ROOT_URL: "invalid" }, "root-url"],
      [["--port", "bad"], { IGLO_EMAIL_PORT: "9000" }, "port"],
    ] as Array<[Array<string>, Record<string, string>, string]>) {
      const result = await runCli(args, env);
      expect(result.code).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain(message);
    }
  });

  test("never prints the initial admin inputs on startup failure", async () => {
    const result = await runCli(["--port", "invalid"], {
      IGLO_EMAIL_ADMIN_USER: adminUser,
      IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(adminUser);
    expect(result.stdout + result.stderr).not.toContain(adminPassword);
  });

  test("a fresh start creates an API user from the environment, and only the first start reads it", async () => {
    const dataDir = join(temporaryDirectory, "api-bootstrap");
    const apiUser = "bootstrap-api";
    const token = apiTokenValue();
    const args = (listenPort: number) => ["--port", String(listenPort), "--data-dir", dataDir];
    const { child: first, port } = await startOnPort((listenPort) => ({
      args: args(listenPort),
      env: { IGLO_EMAIL_API_USER: apiUser, IGLO_EMAIL_API_TOKEN: token },
    }));
    try {
      expect((await healthWhenReady(first, port)).status).toBe(200);
      expect((await apiGet(port, apiUser, token)).status).toBe(200);
      expect((await apiGet(port, apiUser, apiTokenValue())).status).toBe(403);
    } finally {
      expect(await shutDown(first, "SIGTERM")).toBe(0);
    }
    // Nothing is printed: the operator chose the token and already knows it.
    expect(await new Response(first.stdout).text()).not.toContain(token);
    expect(await new Response(first.stderr).text()).not.toContain(token);

    // A later start with other values changes nothing: the first token still works.
    const replacement = apiTokenValue();
    const second = await restartOnPort(port, (listenPort) =>
      launch(listenPort, () => ({
        args: args(listenPort),
        env: { IGLO_EMAIL_API_USER: "replacement-api", IGLO_EMAIL_API_TOKEN: replacement },
      })),
    );
    try {
      expect((await healthWhenReady(second, port)).status).toBe(200);
      expect((await apiGet(port, apiUser, token)).status).toBe(200);
      expect((await apiGet(port, "replacement-api", replacement)).status).toBe(403);
    } finally {
      expect(await shutDown(second, "SIGTERM")).toBe(0);
    }
  });

  test("the admin and API pairs are independent, and both are created on the first start", async () => {
    const dataDir = join(temporaryDirectory, "both-bootstrap");
    const apiUser = "both-api";
    const token = apiTokenValue();
    const { child, port } = await startOnPort((listenPort) => ({
      args: ["--port", String(listenPort), "--data-dir", dataDir],
      env: {
        IGLO_EMAIL_ADMIN_USER: adminUser,
        IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
        IGLO_EMAIL_API_USER: apiUser,
        IGLO_EMAIL_API_TOKEN: token,
      },
    }));
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
      expect((await login(port, adminUser, adminPassword)).status).toBe(302);
      expect((await apiGet(port, apiUser, token)).status).toBe(200);
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
  });

  test("a half-set API pair, a malformed token or a clashing user name fails startup without echoing the token", async () => {
    const token = apiTokenValue();
    for (const [env, names] of [
      [{ IGLO_EMAIL_API_USER: "api-only-user" }, ["IGLO_EMAIL_API_USER", "IGLO_EMAIL_API_TOKEN"]],
      [{ IGLO_EMAIL_API_TOKEN: token }, ["IGLO_EMAIL_API_USER", "IGLO_EMAIL_API_TOKEN"]],
      [{ IGLO_EMAIL_API_USER: "api-empty", IGLO_EMAIL_API_TOKEN: "" }, ["IGLO_EMAIL_API_TOKEN"]],
      [{ IGLO_EMAIL_API_USER: "api-short", IGLO_EMAIL_API_TOKEN: "too-short-value" }, ["48"]],
      [
        { IGLO_EMAIL_API_USER: "api-dashes", IGLO_EMAIL_API_TOKEN: `${token.slice(0, 47)}-` },
        ["48"],
      ],
      [{ IGLO_EMAIL_API_USER: "ab", IGLO_EMAIL_API_TOKEN: token }, ["IGLO_EMAIL_API_USER"]],
      [
        {
          IGLO_EMAIL_API_USER: adminUser,
          IGLO_EMAIL_API_TOKEN: token,
          IGLO_EMAIL_ADMIN_USER: adminUser,
          IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
        },
        ["IGLO_EMAIL_API_USER", "IGLO_EMAIL_ADMIN_USER"],
      ],
    ] as Array<[Record<string, string>, Array<string>]>) {
      const result = await runCli(
        ["--data-dir", join(temporaryDirectory, `api-partial-${crypto.randomUUID()}`)],
        env,
      );
      expect(result.code).not.toBe(0);
      for (const name of names) {
        expect(result.stderr).toContain(name);
      }
      expect(result.stderr).not.toContain(token);
      expect(result.stderr).not.toContain(adminPassword);
    }
  });

  test("an untrusted X-Forwarded-For report reaches the logs page as its own line, without the address", async () => {
    const dataDir = join(temporaryDirectory, "forwarded-report");
    const token = apiTokenValue();
    const { child, port } = await startOnPort((listenPort) => ({
      args: ["--port", String(listenPort), "--data-dir", dataDir],
      env: {
        IGLO_EMAIL_ADMIN_USER: adminUser,
        IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
        IGLO_EMAIL_API_USER: "logs-api",
        IGLO_EMAIL_API_TOKEN: token,
      },
    }));
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
      // A login from the test host, which is not in security.trusted_proxies, with a forwarded header.
      await login(port, adminUser, "not-the-password", { "x-forwarded-for": "203.0.113.9" });
      await login(port, adminUser, "not-the-password", { "x-forwarded-for": "203.0.113.10" });
      const response = await fetch(`http://127.0.0.1:${port}/api/logs`, {
        headers: { authorization: `token logs-api:${token}` },
      });
      expect(response.status).toBe(200);
      const lines = (await response.json()).data as Array<string>;
      // One line per process, in the fixed wording of the log buffer, with no error class.
      expect(lines.filter((line) => line.includes("X-Forwarded-For"))).toEqual([
        expect.stringMatching(
          / \*: X-Forwarded-For from an untrusted peer ignored: see security\.trusted_proxies$/,
        ),
      ]);
      expect(lines.join("\n")).not.toContain("203.0.113");
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
    // The same report on stderr is one plain line: the peer, never the header's address, no stack.
    const stderr = await new Response(child.stderr).text();
    expect(stderr.split("\n").filter((line) => line.includes("X-Forwarded-For"))).toEqual([
      expect.stringMatching(
        /^X-Forwarded-For from \S+ was ignored: that address is not in security\.trusted_proxies\. /,
      ),
    ]);
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr).not.toContain("203.0.113");
  });

  test("root URL errors name the value and the fix, and never echo credentials", async () => {
    for (const [value, expected] of [
      [
        "email-dev.example.com",
        [
          'Invalid root-url "email-dev.example.com": expected an absolute http:// or https:// URL, such as https://email-dev.example.com',
        ],
      ],
      ["ftp://files.example.test", ["Invalid root-url", "must be http:// or https://"]],
      ["https://user:hunter2@example.test", ["Invalid root-url", "user name and password"]],
      ["https://example.test/?token=abc", ["Invalid root-url", "query string and fragment"]],
      [
        "https://user:hunter2@example.test ",
        ["Invalid root-url (value not shown)", "whitespace or a backslash"],
      ],
    ] as const) {
      const result = await runCli(["--root-url", value]);
      expect(result.code).not.toBe(0);
      for (const text of expected) {
        expect(result.stderr).toContain(text);
      }
      expect(result.stderr).not.toContain("hunter2");
      expect(result.stderr).not.toContain("token=abc");
    }
    const bare = await runCli([], { IGLO_EMAIL_ROOT_URL: "email-dev.example.com" });
    expect(bare.stderr).toContain("such as https://email-dev.example.com");
  });

  test("a root URL with a scheme never gets an https:// suggestion, and names the wrong part", async () => {
    // Each value is refused, and its message names the part to change without a suggestion. A
    // suggestion built from such a value would be `https://https://...`, which the validator
    // accepts with host `https`.
    for (const [value, reason] of [
      ["https://news.example.com ", "contains whitespace or a backslash"],
      ["https://news.example.com\r", "contains whitespace or a backslash"],
      ["https://news.example.com\n", "contains whitespace or a backslash"],
      ["https:/news.example.com", "the scheme must be followed by //"],
      ["http:news.example.com", "the scheme must be followed by //"],
      ["https:443", "the scheme must be followed by //"],
      ["https://", "with a valid host name"],
    ] as const) {
      const result = await runCli(["--root-url", value]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Invalid root-url");
      expect(result.stderr).toContain(reason);
      expect(result.stderr).not.toContain("such as");
      expect(result.stderr).not.toContain("https://https");
      // A control character is shown escaped, never as the raw character.
      expect(result.stderr).not.toContain("\r");
    }
  });

  test("a value with a missing colon, a bare scheme word or a single label gets no suggestion", async () => {
    // Each value names its wrong part and gets no suggestion. A suggestion from one of them would be
    // `https://https//...`, which the validator accepts with host `https` (D107).
    for (const [value, reason] of [
      ["https//news.example.com", "the scheme must be followed by ://"],
      ["http//news.example.com", "the scheme must be followed by ://"],
      ["HTTPS//news.example.com", "the scheme must be followed by ://"],
      ["https//news.example.com:8443", "the scheme must be followed by ://"],
      ["http//localhost:9000", "the scheme must be followed by ://"],
      ["https/news.example.com", "the scheme must be followed by ://"],
      ["https///x", "the scheme must be followed by ://"],
      ["https", "with a host name; the scheme is not guessed"],
      ["http", "with a host name; the scheme is not guessed"],
      ["localhost", "with a host name; the scheme is not guessed"],
      ["x.com:0", "the port must be from 1 to 65535"],
      ["https://x.com:0", "the port must be from 1 to 65535"],
      ["https://x.com:65536", "the port must be from 1 to 65535"],
    ] as const) {
      const result = await runCli(["--root-url", value]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`Invalid root-url "${value}": `);
      expect(result.stderr).toContain(reason);
      expect(result.stderr).not.toContain("such as");
      expect(result.stderr).not.toContain("https://https");
      expect(result.stderr).not.toContain("https://http");
    }
  });

  test("for hostile root URL values, a suggestion is only ever for the host the value names", async () => {
    // [value, the host it names, or null when it names none]. A suggestion exists exactly for the
    // values that name a host by the allow-list, and its hostname is that host.
    const hostile: ReadonlyArray<readonly [string, string | null]> = [
      ["news.example.com@evil.example.net", null],
      ["news.example.com/@evil.example.net", null],
      [String.raw`news.example.com\evil.example.net`, null],
      ["news.example.com?next=https://evil.example.net", null],
      ["news.example.com#https://evil.example.net", null],
      ["news.example.com/%2f%2fevil.example.net", "news.example.com"],
      ["news.example.com/../../evil.example.net", "news.example.com"],
      ["news.example.com:0", null],
      ["news.example.com:00443", null],
      ["news.example.com:65536", null],
      ["news.example.com:99999", null],
      ["news.example.com:8443:9000", null],
      ["news.example.com:", null],
      ["news.example.com:+443", null],
      ["news.example.com:443/", "news.example.com"],
      ["news..example.com", null],
      ["-news.example.com", null],
      ["news-.example.com", null],
      ["news.example.com.", null],
      [".news.example.com", null],
      ["news_example.com", null],
      ["ñews.example.com", null],
      ["news.example.com\t", null],
      [`${"a".repeat(64)}.example.com`, null],
      ["[2001:db8::1]", null],
      ["[2001:db8::1]:8443", null],
      ["localhost", null],
      ["//news.example.com", null],
      ["https//news.example.com", null],
      ["mailto:ops@example.com", null],
      ["NEWS.Example.COM", "news.example.com"],
      ["xn--nxasmq6b.example.com", "xn--nxasmq6b.example.com"],
      ["192.0.2.10:8443", "192.0.2.10"],
    ];
    for (const [value, intended] of hostile) {
      // The `=` form, because a value that starts with `-` is not read as a value after a flag.
      const result = await runCli([`--root-url=${value}`]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Invalid root-url");
      const suggestion = /such as (\S+)/.exec(result.stderr)?.[1];
      const host = suggestion === undefined ? null : new URL(suggestion).hostname;
      expect({ value, host }).toEqual({ value, host: intended });
    }
  }, 25_000);

  test("the root URL suggestion for a bare host or a host with a port is accepted and is the host meant", async () => {
    const token = apiTokenValue();
    for (const [value, intended] of [
      ["news.example.com", "news.example.com"],
      ["news.example.com:8443", "news.example.com"],
      ["news.example.com/base", "news.example.com"],
    ] as const) {
      const refused = await runCli(["--root-url", value]);
      expect(refused.code).not.toBe(0);
      const suggestion = /such as (\S+)/.exec(refused.stderr)?.[1];
      expect(suggestion).toBe(`https://${value}`);
      if (!suggestion) {
        throw new Error("No suggestion");
      }
      expect(new URL(suggestion).hostname).toBe(intended);

      // The suggestion starts the server, and the server's root URL is the one meant.
      const dataDir = join(temporaryDirectory, `suggest-${crypto.randomUUID()}`);
      const { child, port } = await startOnPort((listenPort) => ({
        args: ["--port", String(listenPort), "--data-dir", dataDir, "--root-url", suggestion],
        env: { IGLO_EMAIL_API_USER: "suggested-api", IGLO_EMAIL_API_TOKEN: token },
      }));
      try {
        expect((await healthWhenReady(child, port)).status).toBe(200);
        const settings = await apiGet(port, "suggested-api", token);
        expect(settings.status).toBe(200);
        expect((await settings.json()).data["app.root_url"]).toBe(suggestion);
      } finally {
        expect(await shutDown(child, "SIGTERM")).toBe(0);
      }
    }
  });
});
