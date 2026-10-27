import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
let temporaryDirectory = "";
let executable = "";

// These processes receive only the environment needed for the test.
const baseEnvironment = { PATH: process.env.PATH ?? "" };

beforeAll(async () => {
  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: repository,
    env: baseEnvironment,
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
    env: { ...baseEnvironment, ...env },
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

describe("compiled executable", () => {
  test("serves the upstream health response outside the checkout and stops on SIGTERM", async () => {
    const port = await availablePort();
    const adminUser = "test-admin-user";
    const adminPassword = "test-admin-password";
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
    const child = start(["serve"], {
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

  test("help describes the bootstrap options", async () => {
    for (const args of [["--help"], ["serve", "--help"]]) {
      const result = await runCli(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--port");
      expect(result.stdout).toContain("IGLO_EMAIL_ROOT_URL");
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
      const result = await runCli(["serve", flag]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(flag.split("=")[0]);
      expect(result.stderr).toContain("docs/design/01-scope.md");
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
      [["--data-dir="], {}, "data-dir"],
      [["--root-url", "file:///tmp"], {}, "root-url"],
      [["--root-url", "https://user:password@example.test"], {}, "root-url"],
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
});
