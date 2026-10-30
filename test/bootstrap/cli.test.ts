import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDbFixture } from "@/test/db/fixture";
import { startSchemaFixture } from "@/test/schema/fixture";

const repository = resolve(import.meta.dir, "../..");
setDefaultTimeout(15_000);
let temporaryDirectory = "";
let executable = "";
let adminUser = "";
let adminPassword = "";

// Building needs Bun on PATH; the compiled executable does not.
const buildEnvironment = { PATH: process.env.PATH ?? "" };

beforeAll(async () => {
  const fixture = await Bun.file(join(repository, "test/bootstrap/fixtures.md")).text();
  adminUser = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1] ?? "";
  adminPassword = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1] ?? "";
  if (!adminUser || !adminPassword) throw new Error("Bootstrap test credentials are missing");

  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: repository,
    env: buildEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Build failed:\n${stdout}\n${stderr}`);

  temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-bootstrap-"));
  executable = join(temporaryDirectory, "iglo.email");
  await copyFile(join(repository, "dist", "iglo.email"), executable);
  await chmod(executable, 0o755);
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

function start(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn([executable, ...args], {
    cwd: temporaryDirectory,
    env: { PATH: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function stop(child: ReturnType<typeof start>, signal: "SIGTERM" | "SIGINT") {
  if (child.exitCode === null) child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try {
    return await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function runCli(args: string[], env: Record<string, string> = {}) {
  const child = start(args, env);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 3_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error(`CLI did not exit: ${args.join(" ")}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function availablePort() {
  const socket = createServer();
  await new Promise<void>((resolveListen, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolveListen);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port was assigned");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    socket.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function healthWhenReady(child: ReturnType<typeof start>, port: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`Server exited before it became ready: ${stderr}`);
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(500),
      });
    } catch {
      // This delay is only for bounded process readiness, not application time.
      await Bun.sleep(25);
    }
  }
  throw new Error("Server did not become ready within five seconds");
}

async function login(port: number, username: string, password: string) {
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(`${base}/admin/login?next=%2Fapi%2Fprofile`);
  const html = await page.text();
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1];
  const cookie = page.headers
    .getSetCookie()
    .find((item) => item.startsWith("nonce="))
    ?.split(";", 1)[0];
  if (!nonce || !cookie) throw new Error("Login form is missing its nonce");
  return fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ username, password, nonce, next: "/api/profile" }),
  });
}

describe("compiled executable", () => {
  test("unprovisioned startup denies login and partial bootstrap pairs fail", async () => {
    const port = await availablePort();
    const dataDir = join(temporaryDirectory, "unprovisioned-auth");
    const child = start(["--port", String(port), "--data-dir", dataDir]);
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
      expect(await stop(child, "SIGTERM")).toBe(0);
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
    const port = await availablePort();
    const dataDir = join(temporaryDirectory, "persistent-auth");
    const args = [
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--root-url",
      `https://127.0.0.1:${port}`,
    ];
    const first = start(args, {
      IGLO_EMAIL_ADMIN_USER: adminUser,
      IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
    });
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
      expect(await stop(first, "SIGTERM")).toBe(0);
    }
    const second = start(args, { IGLO_EMAIL_ADMIN_USER: "replacement-admin" });
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
      expect(await stop(second, "SIGTERM")).toBe(0);
    }
  });
  test("serves the upstream health response outside the checkout and stops on SIGTERM", async () => {
    const port = await availablePort();
    const child = start(["serve", "--port", String(port)], {
      IGLO_EMAIL_ADMIN_USER: adminUser,
      IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
    });
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
        signal: AbortSignal.timeout(1_000),
      });
      expect(wrongMethod.status).not.toBe(200);
      const unknownPath = await fetch(`http://127.0.0.1:${port}/missing`, {
        signal: AbortSignal.timeout(1_000),
      });
      expect(unknownPath.status).toBe(404);
      for (const path of ["/api/not-present", "/api/lang/en"]) {
        const apiResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(1_000),
        });
        expect(apiResponse.status).toBe(404);
        expect(apiResponse.headers.get("content-type")).toBe("application/json");
        expect(await apiResponse.text()).toBe('{"message":"404 unknown endpoint"}\n');
      }
      const protectedHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(protectedHealth.status).toBe(403);
      expect(await protectedHealth.text()).toBe('{"message":"invalid session"}\n');
    } finally {
      expect(await stop(child, "SIGTERM")).toBe(0);
    }
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("flags override environment values and SIGINT closes the server", async () => {
    const port = await availablePort();
    const child = start(
      [
        "serve",
        `--port=${port}`,
        "--host",
        "127.0.0.1",
        "--data-dir",
        "./chosen-data",
        "--root-url=https://example.test/root",
      ],
      {
        IGLO_EMAIL_PORT: "invalid",
        IGLO_EMAIL_HOST: "invalid host",
        IGLO_EMAIL_DATA_DIR: "",
        IGLO_EMAIL_ROOT_URL: "not-a-url",
      },
    );
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
    } finally {
      expect(await stop(child, "SIGINT")).toBe(0);
    }
  });

  test("environment bootstrap values work without flags or admin credentials", async () => {
    const port = await availablePort();
    const child = start([], {
      IGLO_EMAIL_PORT: String(port),
      IGLO_EMAIL_HOST: "127.0.0.1",
      IGLO_EMAIL_DATA_DIR: "./env-data",
      IGLO_EMAIL_ROOT_URL: "https://example.test",
    });
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
    } finally {
      expect(await stop(child, "SIGTERM")).toBe(0);
    }
  });

  test("opens the persistent version-two production schema on standalone restart", async () => {
    const port = await availablePort();
    const dataDir = join(temporaryDirectory, "persistent-db");
    for (let i = 0; i < 2; i++) {
      const child = start(["--port", String(port), "--data-dir", dataDir]);
      try {
        expect((await healthWhenReady(child, port)).status).toBe(200);
      } finally {
        expect(await stop(child, "SIGTERM")).toBe(0);
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
          shapes: Record<string, string[]>;
          integrity: string;
          foreignKeyErrors: unknown[];
          backups: string[];
        };
      };
      expect(result).toMatchObject({
        version: "6",
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
      expect(((await search.json()) as { result: string[] }).result).toEqual([
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

    const socket = createServer();
    await new Promise<void>((resolveListen, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("No test port was assigned");
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
      await new Promise<void>((resolveClose) => socket.close(() => resolveClose()));
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
      [["backup"], "Unknown command"],
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
    ] as Array<[string[], Record<string, string>, string]>) {
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
});
