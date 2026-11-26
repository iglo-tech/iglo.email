// The PocketBase test harness (15-external-sources section 8, D170). `startPocketBase` runs the real
// 0.40.5 binary in its own temporary directory on a free loopback port with the fixture schema:
//
// - `services`: the auth collection iglo.email signs in to, with one service account;
// - `users`: PocketBase's own auth collection plus `deletedAt` (date) and `marketingOptOut` (bool);
// - `events`: user (relation to users), name, data (JSON), occurredAt (date), key (unique when
//   set), created and updated;
// - `recipients`: a view over the users without `deletedAt`: id, email, name, optOut.
//
// Every fixture collection lets the service account list and view and nobody else. The harness
// itself writes as a superuser through `create`, `update` and `remove`. See README.md.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { asBody } from "@/test/read-body";
import { pocketBaseBinary } from "@/test/sources/pocketbase-binary";
import { startOnFreePort, stderrDrained } from "@/test/serve-port";

export const SERVICE_IDENTITY = "iglo@example.com";
export const SERVICE_PASSWORD = "service-password-1";
const SUPERUSER = "root@example.com";
const SUPERUSER_PASSWORD = "superuser-password-1";
const serviceRule = '@request.auth.collectionName = "services"';

export type PocketBaseRecord = Record<string, unknown> & { id: string };

export interface PocketBase {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** The data directory (pb_data) of this instance. */
  readonly dir: string;
  /** The service account the source settings name. */
  readonly service: { collection: "services"; identity: string; password: string };
  /** A superuser API call; throws with the body on a non-2xx answer. */
  api(method: string, path: string, body?: unknown): Promise<any>;
  create(collection: string, record: Record<string, unknown>): Promise<PocketBaseRecord>;
  update(
    collection: string,
    id: string,
    record: Record<string, unknown>,
  ): Promise<PocketBaseRecord>;
  remove(collection: string, id: string): Promise<void>;
  /** A user and its recipients-view row. */
  user(fields?: Record<string, unknown>): Promise<PocketBaseRecord>;
  /** An events record for `user`; `occurredAt` defaults to now. */
  event(
    user: string,
    name: string,
    data?: Record<string, unknown>,
    fields?: Record<string, unknown>,
  ): Promise<PocketBaseRecord>;
  /** Renames a field of a collection (a schema change the source must report as permanent). */
  renameField(collection: string, from: string, to: string): Promise<void>;
  /** Stops the process; the data directory stays until `close`. */
  stop(): Promise<void>;
  /** Starts the process again on the same port and data. */
  start(): Promise<void>;
  /**
   * Pauses (SIGSTOP) or resumes (SIGCONT) the process: a server that accepts and never answers.
   * `pause` settles once every thread of the process is stopped (B154): `kill` returns before
   * that, and until each thread has run to its stop the server still answers.
   */
  pause(): Promise<void>;
  resume(): void;
  /** Stops the process and removes its directory. */
  close(): Promise<void>;
}

/** The adapter's settings for a harness instance: the fixture schema's names, `url` as given. */
export function sourceConfig(url: string, service: PocketBase["service"]): PocketBaseConfig {
  return {
    url,
    authCollection: service.collection,
    identity: service.identity,
    password: service.password,
    events: {
      collection: "events",
      user: "user",
      name: "name",
      data: "data",
      occurredAt: "occurredAt",
      key: "key",
    },
    recipients: { collection: "recipients", email: "email", name: "name", optOut: "optOut" },
    users: { collection: "users", leavingFilter: "deletedAt != ''" },
  };
}

function field(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { name, type, required: false, ...extra };
}

async function run(binary: string, args: Array<string>) {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`pocketbase ${args[0]} failed: ${await new Response(child.stderr).text()}`);
  }
}

/**
 * Settles once every thread of process `pid` is in the stopped state. A SIGSTOP stops a
 * multi-threaded process one thread at a time, each when it next runs, so `kill` returns while
 * some threads (PocketBase's Go scheduler and network poller among them) can still answer a
 * request. A thread that exits meanwhile (zombie `Z`, dead `X`, or its task entry gone) cannot
 * answer either, so it counts as stopped. Linux only, like the release targets.
 */
async function stopped(pid: number): Promise<void> {
  const tasks = `/proc/${pid}/task`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const states = readdirSync(tasks).map((tid) => {
      try {
        // The state follows the parenthesised command name, which may itself contain spaces.
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
      throw new Error(`PocketBase threads not stopped: ${states.join("")}`);
    }
    await Bun.sleep(1);
  }
}

/** Starts the binary on `port`; resolves once it answers /api/health. */
async function serve(binary: string, root: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    binary,
    [
      "serve",
      `--http=127.0.0.1:${port}`,
      `--dir=${join(root, "pb_data")}`,
      `--publicDir=${join(root, "pb_public")}`,
      `--hooksDir=${join(root, "pb_hooks")}`,
      `--migrationsDir=${join(root, "pb_migrations")}`,
      "--automigrate=false",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
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
      throw new Error(`PocketBase exited (${code}): ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return child;
      }
    } catch {
      /* not listening yet */
    }
  }
  child.kill("SIGKILL");
  throw new Error(`PocketBase did not start: ${stderr}`);
}

/** Starts PocketBase with the fixture schema and the service account. */
export async function startPocketBase(): Promise<PocketBase> {
  const binary = await pocketBaseBinary();
  const root = mkdtempSync(join(tmpdir(), "iglo-pocketbase-"));
  const dir = join(root, "pb_data");
  await run(binary, ["superuser", "upsert", SUPERUSER, SUPERUSER_PASSWORD, `--dir=${dir}`]);
  let child: ChildProcess | undefined;
  let port = 0;
  try {
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
      init.headers = { Authorization: token, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${url}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PocketBase ${method} ${path}: ${response.status} ${text}`);
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
  const events = await api("POST", "/api/collections", {
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
  if (!events?.id) {
    throw new Error("events collection was not created");
  }
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
  let process: ChildProcess | undefined = child;
  let counter = 0;
  const harness: PocketBase = {
    url,
    port,
    dir,
    service: { collection: "services", identity: SERVICE_IDENTITY, password: SERVICE_PASSWORD },
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
      const current = asBody<{ fields: Array<{ name: string }>; indexes: Array<string> }>(
        await api("GET", `/api/collections/${collection}`),
      );
      await api("PATCH", `/api/collections/${collection}`, {
        fields: current.fields.map((item) => (item.name === from ? { ...item, name: to } : item)),
        indexes: current.indexes.map((index) => index.replaceAll(from, to)),
      });
    },
    async stop() {
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
    },
    async start() {
      if (!process) {
        process = await serve(binary, root, port);
        await signIn();
      }
    },
    async pause() {
      const running = process;
      if (!running?.pid) {
        throw new Error("PocketBase is not running");
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
