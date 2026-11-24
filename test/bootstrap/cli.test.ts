import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test as bunTest,
} from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cpuProgress,
  healthWhenReady,
  listensOn,
  outputOf,
  startOnFreePort,
  stopChild,
} from "@/test/serve-port";
import { ensureProductionBuild } from "@/test/production-build";
import { startDbFixture } from "@/test/db/fixture";
import { startSchemaFixture } from "@/test/schema/fixture";
import { readJson } from "@/test/read-body";
import { untilState } from "@/test/wait";

const repository = resolve(import.meta.dir, "../..");
const defaultTimeoutMs = 15_000;
setDefaultTimeout(defaultTimeoutMs);
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

/**
 * A test's budget for its CLI runs and children: its timeout less 3 s, so it ends before Bun gives
 * up on the body. Bun does not stop a timed-out body, so the body can go on after its test has
 * failed. Its budget ends with it: its next CLI run fails by name, and each child it started is
 * killed, so none runs under the next test (B118a). Each test has its own budget, held by the
 * async context of its body, so no budget is shared between tests.
 */
interface Budget {
  readonly name: string;
  readonly ends: number;
  readonly children: Set<ReturnType<typeof start>>;
  /** Set by the kill timer. A timer can fire a few ms before `performance.now()` reaches `ends`. */
  expired: boolean;
}
const budgets = new AsyncLocalStorage<Budget>();
const budgetMarginMs = 3000;
/** The budget of a test with a 12 s timeout: the budget tests at the end of this file. */
const budgetMs = 12_000 - budgetMarginMs;

function test(name: string, body: () => Promise<void>, timeoutMs = defaultTimeoutMs) {
  bunTest(
    name,
    () => {
      const budget: Budget = {
        name,
        ends: performance.now() + timeoutMs - budgetMarginMs,
        children: new Set(),
        expired: false,
      };
      const timer = setTimeout(() => {
        budget.expired = true;
        for (const child of budget.children) {
          child.kill("SIGKILL");
        }
      }, timeoutMs - budgetMarginMs);
      return budgets.run(budget, body).finally(() => clearTimeout(timer));
    },
    timeoutMs,
  );
}

/**
 * Starts the executable. Under a budget, a start after it ended fails by name, and the child is kept.
 * A start is refused once the kill timer has fired, even when the clock has not yet reached `ends`:
 * a child added after the kill would otherwise escape it (B118a r2).
 */
function start(args: Array<string>, env: Record<string, string> = {}) {
  const budget = budgets.getStore();
  if (budget && (budget.expired || performance.now() >= budget.ends)) {
    throw new Error(`The test "${budget.name}" budget ended before: ${args.join(" ")}`);
  }
  const child = Bun.spawn([executable, ...args], {
    cwd: temporaryDirectory,
    env: { PATH: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (budget) {
    budget.children.add(child);
    void child.exited.then(() => budget.children.delete(child));
  }
  return child;
}

/**
 * Runs the CLI to its exit. A CLI that is still running when its test's budget ends is killed by
 * that budget (B118c item 2), so there is no per-call timer; a killed child fails the run by name.
 * `onStart` receives the child before the run is awaited, so a test can watch the process while it
 * runs (the call starts the child synchronously).
 */
async function runCli(
  args: Array<string>,
  env: Record<string, string> = {},
  onStart?: (child: ReturnType<typeof start>) => void,
) {
  const child = start(args, env);
  onStart?.(child);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    outputOf(child).text,
    new Response(child.stderr).text(),
  ]);
  if (child.signalCode !== null) {
    throw new Error(`CLI did not exit before its budget ended: ${args.join(" ")}`);
  }
  return { code, stdout, stderr };
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
 * The root URL of a start on port 0. It is set before the bind, so it names no port (D144): the
 * tests that need the port read it from the child's line, and the root URL stays this one.
 */
const rootUrl = "http://127.0.0.1";

/**
 * A start on port 0 (D144): the child is ready once it has named the port the OS gave it and answers
 * /health on that port. A start that fails is killed, and its failure is thrown.
 */
async function launchBound(args: Array<string>, env: Record<string, string> = {}) {
  const child = start(args, env);
  try {
    const port = await outputOf(child).port;
    const health = await healthWhenReady(child, port);
    return { child, port, health };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  }
}

/**
 * The executable started on a free port. `build` gives the arguments from the port; a start that
 * reports its port in use is retried on another port. Only the fixed-port case uses it now.
 */
function startOnPort(
  build: (port: number) => { args: Array<string>; env?: Record<string, string> },
) {
  return startOnFreePort(async (port) => ({ child: await launch(port, build), port }));
}

/**
 * Starts the executable through `runCli` on `port`, and resolves once that very process listens on
 * it and answers /health. The run is returned still pending: the caller decides how it ends. A
 * process that exits before it is ready fails the start with the stderr `runCli` read, which
 * `startOnFreePort` checks for a port in use. A start that never becomes ready is killed.
 */
async function startThroughCli(dataDir: string) {
  const started: Array<ReturnType<typeof start>> = [];
  const run = runCli(["--port", "0", "--root-url", rootUrl, "--data-dir", dataDir], {}, (child) => {
    started.push(child);
  });
  const [child] = started;
  if (!child) {
    // runCli rejects when start refuses (a budget that has ended): its error is the answer, and
    // awaiting the run handles its rejection instead of leaving it unhandled (B118c r3 backlog).
    await run;
    throw new Error("runCli did not start the executable");
  }
  // The run settles only when the process has exited, and then the start fails with its stderr.
  // The readiness poll never settles after an exit, so the exit alone decides the start.
  const exited = run.then((result) => {
    throw new Error(`Server exited before it became ready: ${result.stderr}`);
  });
  // The port is the one the child names on its line (D144); a child that exits first names none.
  let port: number;
  try {
    port = await Promise.race([outputOf(child).port, exited]);
  } catch (error) {
    child.kill("SIGKILL");
    await run.catch(() => undefined);
    throw error;
  }
  // Readiness is a stall window on the child's CPU time, as in `healthWhenReady` (B118g): a start
  // that is still computing keeps going, and one that hangs without CPU fails after 15 s. After an
  // exit the wait never settles: the exit alone decides the start.
  let last = "no answer yet";
  const listening = untilState(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return new Promise<never>(() => {});
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Connection: "close" },
          signal: AbortSignal.timeout(500),
        });
        // Another server can hold the port and answer first: ready only when this child listens on it.
        if (child.pid !== undefined && listensOn(child.pid, port)) {
          await response.body?.cancel();
          return true;
        }
        last = `answered ${response.status} but this process is not listening`;
      } catch {
        // Not listening yet: the wait goes on until the stall window ends.
        last = "no answer";
      }
      return false;
    },
    {
      label: "Server ready",
      progress: () => cpuProgress(child.pid),
      stallMs: 15_000,
      intervalMs: 25,
      describe: () => last,
    },
  );
  try {
    await Promise.race([exited, listening]);
  } catch (error) {
    child.kill("SIGKILL");
    await run.catch(() => undefined);
    throw error;
  }
  return { child, run };
}

/**
 * Stops a child and returns its exit code. A non-zero exit fails with the stderr the child wrote,
 * so a failure says why the process ended and not only its code.
 */
async function shutDown(child: ReturnType<typeof start>, signal: "SIGTERM" | "SIGINT") {
  // 7 s: above the product's 5 s shutdown drain (D104), so SIGKILL ends only a shutdown that has
  // stopped, not one still draining. The test's budget still ends a child that outlives its test.
  const code = await stopChild(child, signal, 7000);
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
    const { child, port } = await launchBound([
      "--port",
      "0",
      "--root-url",
      rootUrl,
      "--data-dir",
      dataDir,
    ]);
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
    const args = ["--port", "0", "--data-dir", dataDir, "--root-url", "https://127.0.0.1"];
    const { child: first, port } = await launchBound(args, {
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
      expect(await shutDown(first, "SIGTERM")).toBe(0);
    }
    // The restart takes the port the OS picks now. Its session cookie names no port, so it still works.
    const restarted = await launchBound(args, { IGLO_EMAIL_ADMIN_USER: "replacement-admin" });
    const second = restarted.child;
    const nextPort = restarted.port;
    try {
      expect((await healthWhenReady(second, nextPort)).status).toBe(200);
      const profile = await fetch(`http://127.0.0.1:${nextPort}/api/profile`, {
        headers: { cookie: session },
      });
      expect(profile.status).toBe(200);
      expect((await readJson<{ data: { username: string } }>(profile)).data.username).toBe(
        adminUser,
      );
      expect((await login(nextPort, adminUser, adminPassword)).status).toBe(302);
      expect((await login(nextPort, "replacement-admin", adminPassword)).status).toBe(200);
    } finally {
      expect(await shutDown(second, "SIGTERM")).toBe(0);
    }
  });
  test("serves the upstream health response outside the checkout and stops on SIGTERM", async () => {
    const { child, port } = await launchBound(["serve", "--port", "0", "--root-url", rootUrl], {
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
        expect(await apiResponse.text()).toBe(
          '{"message":"404 unknown endpoint","code":"not_found"}\n',
        );
      }
      const protectedHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(protectedHealth.status).toBe(403);
      expect(await protectedHealth.text()).toBe(
        '{"message":"invalid session","code":"invalid_credentials"}\n',
      );
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
    // The only line on stdout is the port the child named (D144), which is the port it served on.
    const [stdout, stderr] = await Promise.all([
      outputOf(child).text,
      new Response(child.stderr).text(),
    ]);
    expect(stdout).toBe(`listening on port ${port}\n`);
    expect(stderr).toBe("");
  });

  test("flags override environment values and SIGINT closes the server", async () => {
    const { child, port } = await launchBound(
      [
        "serve",
        "--port=0",
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
      expect(await shutDown(child, "SIGINT")).toBe(0);
    }
  });

  test("environment bootstrap values work without flags or admin credentials", async () => {
    const { child, port } = await launchBound([], {
      IGLO_EMAIL_PORT: "0",
      IGLO_EMAIL_HOST: "127.0.0.1",
      IGLO_EMAIL_DATA_DIR: "./env-data",
      IGLO_EMAIL_ROOT_URL: "https://example.test",
    });
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
  });

  test("opens the persistent version-two production schema on standalone restart", async () => {
    const dataDir = join(temporaryDirectory, "persistent-db");
    for (let i = 0; i < 2; i++) {
      const { child, port } = await launchBound([
        "--port",
        "0",
        "--root-url",
        rootUrl,
        "--data-dir",
        dataDir,
      ]);
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
      const { result } = await readJson<{
        result: {
          version: string;
          shapes: Record<string, Array<string>>;
          integrity: string;
          foreignKeyErrors: Array<unknown>;
          backups: Array<string>;
        };
      }>(response);
      expect(result).toMatchObject({
        version: "31",
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
      expect((await readJson<{ result: Array<string> }>(search)).result).toEqual([
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
        expect((await readJson<{ result: { integrity: string } }>(response)).result.integrity).toBe(
          "ok",
        );
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
    const args = ["--port", "0", "--root-url", rootUrl, "--data-dir", dataDir];
    const { child: first, port } = await launchBound(args, {
      IGLO_EMAIL_API_USER: apiUser,
      IGLO_EMAIL_API_TOKEN: token,
    });
    try {
      expect((await healthWhenReady(first, port)).status).toBe(200);
      expect((await apiGet(port, apiUser, token)).status).toBe(200);
      expect((await apiGet(port, apiUser, apiTokenValue())).status).toBe(403);
    } finally {
      expect(await shutDown(first, "SIGTERM")).toBe(0);
    }
    // Nothing is printed: the operator chose the token and already knows it.
    expect(await outputOf(first).text).not.toContain(token);
    expect(await new Response(first.stderr).text()).not.toContain(token);

    // A later start with other values changes nothing: the first token still works.
    const replacement = apiTokenValue();
    const restarted = await launchBound(args, {
      IGLO_EMAIL_API_USER: "replacement-api",
      IGLO_EMAIL_API_TOKEN: replacement,
    });
    const second = restarted.child;
    try {
      expect((await healthWhenReady(second, restarted.port)).status).toBe(200);
      expect((await apiGet(restarted.port, apiUser, token)).status).toBe(200);
      expect((await apiGet(restarted.port, "replacement-api", replacement)).status).toBe(403);
    } finally {
      expect(await shutDown(second, "SIGTERM")).toBe(0);
    }
  });

  test("the admin and API pairs are independent, and both are created on the first start", async () => {
    const dataDir = join(temporaryDirectory, "both-bootstrap");
    const apiUser = "both-api";
    const token = apiTokenValue();
    const { child, port } = await launchBound(
      ["--port", "0", "--root-url", rootUrl, "--data-dir", dataDir],
      {
        IGLO_EMAIL_ADMIN_USER: adminUser,
        IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
        IGLO_EMAIL_API_USER: apiUser,
        IGLO_EMAIL_API_TOKEN: token,
      },
    );
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
      expect((await login(port, adminUser, adminPassword)).status).toBe(302);
      expect((await apiGet(port, apiUser, token)).status).toBe(200);
    } finally {
      expect(await shutDown(child, "SIGTERM")).toBe(0);
    }
  });

  // One test per case, each with its own budget (B118i item 4): seven starts in one test ran past the
  // 12 s budget under load. Each case builds its environment from the token of its own test.
  const partialCases: Array<
    [label: string, env: (token: string) => Record<string, string>, names: Array<string>]
  > = [
    [
      "an API user without its token",
      () => ({ IGLO_EMAIL_API_USER: "api-only-user" }),
      ["IGLO_EMAIL_API_USER", "IGLO_EMAIL_API_TOKEN"],
    ],
    [
      "an API token without its user",
      (token) => ({ IGLO_EMAIL_API_TOKEN: token }),
      ["IGLO_EMAIL_API_USER", "IGLO_EMAIL_API_TOKEN"],
    ],
    [
      "an empty API token",
      () => ({ IGLO_EMAIL_API_USER: "api-empty", IGLO_EMAIL_API_TOKEN: "" }),
      ["IGLO_EMAIL_API_TOKEN"],
    ],
    [
      "a short API token",
      () => ({ IGLO_EMAIL_API_USER: "api-short", IGLO_EMAIL_API_TOKEN: "too-short-value" }),
      ["48"],
    ],
    [
      "an API token ending in a dash",
      (token) => ({
        IGLO_EMAIL_API_USER: "api-dashes",
        IGLO_EMAIL_API_TOKEN: `${token.slice(0, 47)}-`,
      }),
      ["48"],
    ],
    [
      "an API user name of two letters",
      (token) => ({ IGLO_EMAIL_API_USER: "ab", IGLO_EMAIL_API_TOKEN: token }),
      ["IGLO_EMAIL_API_USER"],
    ],
    [
      "an API user named like the admin",
      (token) => ({
        IGLO_EMAIL_API_USER: adminUser,
        IGLO_EMAIL_API_TOKEN: token,
        IGLO_EMAIL_ADMIN_USER: adminUser,
        IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
      }),
      ["IGLO_EMAIL_API_USER", "IGLO_EMAIL_ADMIN_USER"],
    ],
  ];
  for (const [label, env, names] of partialCases) {
    test(`fails startup without echoing the token: ${label}`, async () => {
      const token = apiTokenValue();
      const result = await runCli(
        ["--data-dir", join(temporaryDirectory, `api-partial-${crypto.randomUUID()}`)],
        env(token),
      );
      expect(result.code).not.toBe(0);
      for (const name of names) {
        expect(result.stderr).toContain(name);
      }
      expect(result.stderr).not.toContain(token);
      expect(result.stderr).not.toContain(adminPassword);
    });
  }

  test("an untrusted X-Forwarded-For report reaches the logs page as its own line, without the address", async () => {
    const dataDir = join(temporaryDirectory, "forwarded-report");
    const token = apiTokenValue();
    const { child, port } = await launchBound(
      ["--port", "0", "--root-url", rootUrl, "--data-dir", dataDir],
      {
        IGLO_EMAIL_ADMIN_USER: adminUser,
        IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
        IGLO_EMAIL_API_USER: "logs-api",
        IGLO_EMAIL_API_TOKEN: token,
      },
    );
    try {
      expect((await healthWhenReady(child, port)).status).toBe(200);
      // A login from the test host, which is not in security.trusted_proxies, with a forwarded header.
      await login(port, adminUser, "not-the-password", { "x-forwarded-for": "203.0.113.9" });
      await login(port, adminUser, "not-the-password", { "x-forwarded-for": "203.0.113.10" });
      const response = await fetch(`http://127.0.0.1:${port}/api/logs`, {
        headers: { authorization: `token logs-api:${token}` },
      });
      expect(response.status).toBe(200);
      const lines = (await readJson<{ data: Array<string> }>(response)).data;
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

  test("a root URL with a leading-zero port or a non-web scheme names that part, and escapes DEL and C1 controls", async () => {
    // B117a (D136): `host:00080` names its leading zero, and `a.b:/c` names its scheme. A DEL or C1
    // control is refused and shown escaped, as JSON escapes the C0 controls.
    for (const [value, expected] of [
      ["host:00080", ["the port has a leading zero, so write 80 instead of 00080"]],
      ["a.b:/c", ['the scheme must be followed by //, and "a.b" is not http or https']],
      [
        "https://news.example.com\u007f",
        ["the value contains a control character", String.raw`\u007f`],
      ],
      [
        "https://news.example.com\u0085",
        ["the value contains a control character", String.raw`\u0085`],
      ],
    ] as const) {
      const result = await runCli(["--root-url", value]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`Invalid root-url `);
      for (const text of expected) {
        expect(result.stderr).toContain(text);
      }
      expect(result.stderr).not.toContain("\u007f");
      expect(result.stderr).not.toContain("\u0085");
      expect(result.stderr).not.toContain("such as");
    }
  });

  test("a root URL that is withheld names nothing taken from it, not even its scheme or port", async () => {
    // B117a (D136): a value with credentials, a query or a fragment is shown as "(value not shown)", so the
    // message names neither its scheme (`token`) nor its leading-zero port (`00080`).
    for (const value of ["token:x-oauth@news.example.com", "news.example.com:00080/?x=1"]) {
      const result = await runCli(["--root-url", value]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Invalid root-url (value not shown)");
      expect(result.stderr).not.toContain("token");
      expect(result.stderr).not.toContain("x-oauth");
      expect(result.stderr).not.toContain("00080");
      expect(result.stderr).not.toContain("news.example.com");
    }
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
      const { child, port } = await launchBound(
        ["--port", "0", "--data-dir", dataDir, "--root-url", suggestion],
        { IGLO_EMAIL_API_USER: "suggested-api", IGLO_EMAIL_API_TOKEN: token },
      );
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

  test("a body that outlives its budget fails its next CLI run by name and kills its children", async () => {
    const name =
      "a body that outlives its budget fails its next CLI run by name and kills its children";
    // The budget ends 9 s after the test starts (the 12 s timeout less 3 s), and kills the child
    // then. The wait is on that exit itself: when no kill comes, the test's own timeout ends it.
    const child = start([
      "--port",
      "0",
      "--root-url",
      rootUrl,
      "--data-dir",
      join(temporaryDirectory, "outlives-budget"),
    ]);
    try {
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const next = await runCli(["--version"]).then(() => "ran", String);
      expect(next).toContain(`The test "${name}" budget ended`);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 12_000);

  // B118c item 2: runCli has no fixed kill timer. A server that runs past 3 s lives until its budget
  // ends at 9 s. The sleep is the thing under test: the server must still run at 4 s. The server is
  // started through runCli, the path every other CLI run here takes, so a fixed timer in runCli is
  // what this test sees. The server picks its port (port 0, D144), so no start races another for it.
  // Mutation 1: main's 3 s SIGKILL timer in runCli; the server is then gone before the check at 4 s.
  // Mutation 2: the "did not exit before its budget ended" check removed from runCli; the run then
  // resolves, and the expectation on its rejection fails.
  test("a server that runs past 3 s is killed by its budget, not by a fixed timer", async () => {
    const begun = performance.now();
    const { child, run } = await startThroughCli(join(temporaryDirectory, "past-3s"));
    // B118c r3 item 8b: a start that takes 5 to 9 s would leave the check below to find the process
    // already killed, with the same output as mutation 1. The start is measured to readiness (the
    // helper returns once this process answers /health), and the 4 s check runs from that point.
    // A late sleep can overshoot by up to 500 ms, so the check must come 500 ms before the kill
    // (mutation 3: a 5 s sleep before the start fails with this message, not with "SIGKILL").
    const readyMs = performance.now() - begun;
    if (readyMs + 4000 + 500 > budgetMs) {
      child.kill("SIGKILL");
      await run.catch(() => undefined);
      throw new Error(
        `ready after ${Math.round(readyMs)} ms, too slow for the 4 s check with 500 ms of margin ` +
          `within the ${budgetMs} ms budget`,
      );
    }
    await Bun.sleep(4000);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    // The budget, not a timer of the test, ends the server: SIGKILL at 9 s, and runCli says so.
    const outcome = await run.then(() => "resolved", String);
    expect(outcome).toContain("CLI did not exit before its budget ended");
    expect(child.signalCode).toBe("SIGKILL");
  }, 12_000);

  // B118c r3 backlog: a retry that starts after its budget ended. The sleep is the thing under test:
  // the budget has to end in real time before the start. The start is refused by name, and the
  // refusal is the answer; before the fix the run's rejection went unhandled and the test saw
  // "runCli did not start the executable". Mutation: the `await run` in startThroughCli removed.
  test("a start after its budget ended is refused with the budget message", async () => {
    await Bun.sleep(budgetMs + 100);
    const outcome = await startThroughCli(join(temporaryDirectory, "after-budget")).then(
      () => "started",
      String,
    );
    expect(outcome).toContain("budget ended before: --port 0 --root-url");
    expect(outcome).not.toContain("did not start the executable");
  }, 12_000);
});

// D144: a port of 0 binds a port the OS chooses and names it on one stdout line. The root URL is set
// before the bind, so a port of 0 needs --root-url, and these starts pass a root URL with no port.
describe("a port of 0 (D144)", () => {
  const root = rootUrl;

  test("is refused without a root URL, and the refusal names it", async () => {
    const result = await runCli([
      "--port",
      "0",
      "--data-dir",
      join(temporaryDirectory, "port-zero-no-root"),
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--root-url");
    expect(result.stdout).toBe("");
  });

  test("binds a port the OS chooses, names it on one stdout line, and serves on it", async () => {
    const { child, port, health } = await launchBound([
      "--port",
      "0",
      "--root-url",
      root,
      "--data-dir",
      join(temporaryDirectory, "port-zero-one"),
    ]);
    expect(port).toBeGreaterThan(0);
    expect(health.status).toBe(200);
    expect(await shutDown(child, "SIGTERM")).toBe(0);
    expect(await outputOf(child).text).toBe(`listening on port ${port}\n`);
  });

  test("IGLO_EMAIL_PORT=0 binds the same way", async () => {
    const { child, port, health } = await launchBound([], {
      IGLO_EMAIL_PORT: "0",
      IGLO_EMAIL_ROOT_URL: root,
      IGLO_EMAIL_DATA_DIR: join(temporaryDirectory, "port-zero-env"),
    });
    expect(health.status).toBe(200);
    expect(await shutDown(child, "SIGTERM")).toBe(0);
    expect(await outputOf(child).text).toBe(`listening on port ${port}\n`);
  });

  test("two starts on port 0 at once take two ports, and each serves on its own", async () => {
    const started = await Promise.all(
      [1, 2].map((index) =>
        launchBound([
          "--port",
          "0",
          "--root-url",
          root,
          "--data-dir",
          join(temporaryDirectory, `port-zero-pair-${index}`),
        ]),
      ),
    );
    try {
      expect(new Set(started.map((item) => item.port)).size).toBe(2);
      for (const item of started) {
        expect(item.health.status).toBe(200);
      }
    } finally {
      for (const item of started) {
        expect(await shutDown(item.child, "SIGTERM")).toBe(0);
      }
    }
  });

  test("a fixed port prints no port line, so only a port of 0 names one", async () => {
    const { child } = await startOnPort((listenPort) => ({
      args: [
        "--port",
        String(listenPort),
        "--root-url",
        root,
        "--data-dir",
        join(temporaryDirectory, "port-fixed-silent"),
      ],
    }));
    expect(await shutDown(child, "SIGTERM")).toBe(0);
    expect(await outputOf(child).text).toBe("");
  });

  test("the help says that port 0 binds a port the OS chooses", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("binds a port the OS chooses");
  });
});
