// The iglo.base test harness (15-external-sources section 8, D187, D189). `startIgloBase` runs the
// real iglo.base 1.3.0 binary in its own temporary directory on a free loopback port with the same
// fixture schema as `startPocketBase` in pocketbase.ts, created by the same API calls:
//
// - `services`: the auth collection iglo.email signs in to, with one service account;
// - `users`: the built-in auth collection plus `deletedAt` (date) and `marketingOptOut` (bool);
// - `events`: user (relation to users), name, data (JSON), occurredAt (date), key (unique when
//   set), created and updated;
// - `recipients`: a view over the users without `deletedAt`: id, email, name, optOut.
//
// Every fixture collection lets the service account list and view and nobody else. It returns the
// same `PocketBase` harness interface, so `sourceConfig` in pocketbase.ts and any test written
// against that interface run unchanged on either binary. Differences from pocketbase.ts: the binary,
// and no `--hooksDir` (iglo.base refuses it, D189). See README.md.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asBody } from "@/test/read-body";
import { igloBaseBinary } from "@/test/sources/iglo-base-binary";
import { SERVICE_IDENTITY, SERVICE_PASSWORD } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";
import { listensOn, restartOnPort, startOnFreePort, stderrDrained } from "@/test/serve-port";

const SUPERUSER = "root@example.com";
const SUPERUSER_PASSWORD = "superuser-password-1";
const serviceRule = '@request.auth.collectionName = "services"';

function field(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { name, type, required: false, ...extra };
}

/** Runs one CLI command of the binary; returns its stdout, throws with stderr on a failure. */
export async function igloBaseCommand(args: Array<string>): Promise<string> {
  const binary = await igloBaseBinary();
  const child = Bun.spawn([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`iglo-base ${args[0]} failed (${code}): ${stderr}`);
  }
  return stdout;
}

/**
 * Settles once every thread of process `pid` is in the stopped state (see `stopped` in
 * pocketbase.ts: a SIGSTOP stops a multi-threaded process one thread at a time). Linux only.
 */
async function stopped(pid: number): Promise<void> {
  const tasks = `/proc/${pid}/task`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const states = readdirSync(tasks).map((tid) => {
      try {
        const stat = readFileSync(join(tasks, tid, "stat"), "utf-8");
        return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      } catch {
        return "gone";
      }
    });
    if (states.every((state) => ["T", "Z", "X", "gone"].includes(state))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`iglo.base threads not stopped: ${states.join("")}`);
    }
    await Bun.sleep(1);
  }
}

/**
 * Starts the binary on `port`; resolves once it answers /api/health and this very process listens
 * on the port. Under parallel test workers another test's server can take a freed port and answer
 * /api/health while this child is failing its bind, so a 200 alone does not prove the start
 * (`listensOn` in serve-port.ts). A start that fails is killed and reaped before it throws.
 */
async function serve(binary: string, root: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    binary,
    [
      "serve",
      `--http=127.0.0.1:${port}`,
      `--dir=${join(root, "pb_data")}`,
      `--publicDir=${join(root, "pb_public")}`,
      `--migrationsDir=${join(root, "pb_migrations")}`,
      "--automigrate=false",
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, Bun.sleep(50).then(() => undefined)]);
    if (code !== undefined) {
      await stderrDrained(child);
      throw new Error(`iglo.base exited (${code}): ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
      if (response.ok && child.pid !== undefined && listensOn(child.pid, port)) {
        return child;
      }
    } catch {
      /* not listening yet, or no answer within the fetch timeout */
    }
  }
  child.kill("SIGKILL");
  await exited;
  throw new Error(`iglo.base did not start: ${stderr}`);
}

/** Starts iglo.base with the fixture schema and the service account. */
export async function startIgloBase(): Promise<PocketBase> {
  const binary = await igloBaseBinary();
  const root = mkdtempSync(join(tmpdir(), "iglo-base-"));
  const dir = join(root, "pb_data");
  let child: ChildProcess | undefined;
  let port = 0;
  try {
    await igloBaseCommand(["superuser", "upsert", SUPERUSER, SUPERUSER_PASSWORD, `--dir=${dir}`]);
    child = await startOnFreePort(async (free) => {
      port = free;
      return serve(binary, root, free);
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const url = `http://127.0.0.1:${port}`;
  let token = "";
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const init: RequestInit = { method, headers: { Authorization: token } };
    if (body !== undefined) {
      init.headers = {
        Authorization: token,
        "Content-Type": "application/json",
      };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${url}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`iglo.base ${method} ${path}: ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }
  async function signIn() {
    token = "";
    token = (
      await api("POST", "/api/collections/_superusers/auth-with-password", {
        identity: SUPERUSER,
        password: SUPERUSER_PASSWORD,
      })
    ).token;
  }
  let process: ChildProcess | undefined = child;
  async function stop() {
    const running = process;
    process = undefined;
    if (running && running.exitCode === null) {
      const exited = new Promise((resolve) => {
        running.once("exit", resolve);
      });
      running.kill("SIGCONT");
      running.kill("SIGTERM");
      await exited;
    }
  }
  try {
    await signIn();
    const rules = { listRule: serviceRule, viewRule: serviceRule };
    await api("POST", "/api/collections", {
      name: "services",
      type: "auth",
      fields: [],
    });
    await api("PATCH", "/api/collections/users", {
      ...rules,
      fields: [
        ...(await api("GET", "/api/collections/users")).fields,
        field("deletedAt", "date"),
        field("marketingOptOut", "bool"),
      ],
    });
    await api("POST", "/api/collections", {
      name: "events",
      type: "base",
      ...rules,
      fields: [
        field("user", "relation", {
          collectionId: "_pb_users_auth_",
          maxSelect: 1,
          cascadeDelete: false,
        }),
        field("name", "text"),
        field("data", "json"),
        field("occurredAt", "date"),
        field("key", "text"),
        field("created", "autodate", { onCreate: true, onUpdate: false }),
        field("updated", "autodate", { onCreate: true, onUpdate: true }),
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_events_key ON events (key) WHERE key != ''",
        "CREATE INDEX idx_events_user_name ON events (user, name, occurredAt)",
      ],
    });
    await api("POST", "/api/collections", {
      name: "recipients",
      type: "view",
      ...rules,
      viewQuery:
        "SELECT u.id, u.email, u.name, u.marketingOptOut AS optOut FROM users u WHERE u.deletedAt = '' OR u.deletedAt IS NULL",
    });
    await api("POST", "/api/collections/services/records", {
      email: SERVICE_IDENTITY,
      password: SERVICE_PASSWORD,
      passwordConfirm: SERVICE_PASSWORD,
    });
  } catch (error) {
    await stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let counter = 0;
  const harness: PocketBase = {
    url,
    port,
    dir,
    service: {
      collection: "services",
      identity: SERVICE_IDENTITY,
      password: SERVICE_PASSWORD,
    },
    api,
    create: (collection, record) => api("POST", `/api/collections/${collection}/records`, record),
    update: (collection, id, record) =>
      api("PATCH", `/api/collections/${collection}/records/${id}`, record),
    async remove(collection, id) {
      await api("DELETE", `/api/collections/${collection}/records/${id}`);
    },
    user(fields = {}) {
      counter++;
      return harness.create("users", {
        email: `user${counter}-${crypto.randomUUID().slice(0, 8)}@example.com`,
        password: "user-password-1",
        passwordConfirm: "user-password-1",
        name: `User ${counter}`,
        ...fields,
      });
    },
    event(user, name, data = {}, fields = {}) {
      return harness.create("events", {
        user,
        name,
        data,
        occurredAt: new Date().toISOString(),
        ...fields,
      });
    },
    async renameField(collection, from, to) {
      const current = asBody<{
        fields: Array<{ name: string }>;
        indexes: Array<string>;
      }>(await api("GET", `/api/collections/${collection}`));
      await api("PATCH", `/api/collections/${collection}`, {
        fields: current.fields.map((item) => (item.name === from ? { ...item, name: to } : item)),
        indexes: current.indexes.map((index) => index.replaceAll(from, to)),
      });
    },
    stop,
    async start() {
      if (!process) {
        // Another test can take the port this one just released: retried on the same port.
        process = await restartOnPort(port, (same) => serve(binary, root, same));
        await signIn();
      }
    },
    async pause() {
      const running = process;
      if (!running?.pid) {
        throw new Error("iglo.base is not running");
      }
      running.kill("SIGSTOP");
      await stopped(running.pid);
    },
    resume() {
      process?.kill("SIGCONT");
    },
    async close() {
      await harness.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}
