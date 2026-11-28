// The shared source harness (15-external-sources section 8, D170, D189, D190): what the PocketBase
// and iglo.base harnesses have in common. `releaseBinary` downloads a pinned release archive,
// checks its SHA-256 and caches the extracted binary; `startHarness` runs a binary on a free
// loopback port in its own temporary directory, waits until this very process answers there, and
// creates the fixture schema:
//
// - `services`: the auth collection iglo.email signs in to, with one service account;
// - `users`: the built-in auth collection plus `deletedAt` (date) and `marketingOptOut` (bool);
// - `events`: user (relation to users), name, data (JSON), occurredAt (date), key (unique when
//   set), created and updated;
// - `recipients`: a view over the users without `deletedAt`: id, email, name, optOut.
//
// Every fixture collection lets the service account list and view and nobody else. The harness
// itself writes as a superuser. `pocketbase.ts` and `iglo-base.ts` name their binary and command
// line; everything else is here. See README.md.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { asBody } from "@/test/read-body";
import type { PocketBase } from "@/test/sources/pocketbase";
import { listensOn, restartOnPort, startOnFreePort, stderrDrained } from "@/test/serve-port";

export const SERVICE_IDENTITY = "iglo@example.com";
export const SERVICE_PASSWORD = "service-password-1";
const SUPERUSER = "root@example.com";
const SUPERUSER_PASSWORD = "superuser-password-1";
const serviceRule = '@request.auth.collectionName = "services"';

// ---------------------------------------------------------------------------------------------
// The release binary.

/** A pinned release: its archives per `process.arch` and where they are published. */
export interface Release {
  /** The name errors use, such as "PocketBase". */
  label: string;
  /** The cache directory's name under node_modules/.cache/, such as `pocketbase-0.40.5`. */
  cache: string;
  /** The binary's name inside the archive and in the cache. */
  entry: string;
  /** The archive name and SHA-256 per `process.arch` (from the release's checksum file). */
  archives: Record<string, { name: string; sha256: string }>;
  /** The download URL of an archive. */
  url(archive: string): string;
  /** The download's time limit. */
  timeoutMs: number;
}

const root = join(import.meta.dir, "..", "..");

/** One file of a zip archive, read through its central directory. */
function unzipEntry(label: string, archive: Uint8Array, wanted: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = archive.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06_05_4b_50) {
    end--;
  }
  if (end < 0) {
    throw new Error(`${label} archive: no end of central directory`);
  }
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02_01_4b_50) {
      throw new Error(`${label} archive: bad central directory`);
    }
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (name === wanted) {
      const dataAt =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = archive.subarray(dataAt, dataAt + compressed);
      if (method === 0) {
        return data;
      }
      if (method === 8) {
        return inflateRawSync(data);
      }
      throw new Error(`${label} archive: unsupported compression ${method}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${label} archive: no ${wanted}`);
}

/**
 * The cached binary's path, downloading and verifying it first when it is missing. The archive's
 * SHA-256 is compared with the pinned value before anything is extracted. Concurrent callers
 * (parallel test workers) each write their own temporary file and rename it into place, so a
 * half-written binary is never run.
 */
export async function releaseBinary(release: Release): Promise<string> {
  const cacheDir = join(root, "node_modules", ".cache", release.cache);
  const binary = join(cacheDir, release.entry);
  if (existsSync(binary)) {
    return binary;
  }
  if (process.platform !== "linux") {
    throw new Error(`The ${release.label} test binary is pinned for Linux only (D89)`);
  }
  const archive = release.archives[process.arch];
  if (!archive) {
    throw new Error(`No pinned ${release.label} archive for ${process.arch}`);
  }
  const url = release.url(archive.name);
  const response = await fetch(url, { signal: AbortSignal.timeout(release.timeoutMs) });
  if (!response.ok) {
    throw new Error(`${release.label} download failed: ${response.status} ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== archive.sha256) {
    throw new Error(
      `${release.label} archive checksum mismatch: ${digest}, expected ${archive.sha256}`,
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  const temporary = join(cacheDir, `${release.entry}.${process.pid}.${crypto.randomUUID()}`);
  try {
    writeFileSync(temporary, unzipEntry(release.label, bytes, release.entry));
    chmodSync(temporary, 0o755);
    renameSync(temporary, binary);
  } finally {
    rmSync(temporary, { force: true });
  }
  return binary;
}

// ---------------------------------------------------------------------------------------------
// The running server.

/** What a harness names: its binary and the `serve` arguments past `--http`. */
export interface ServerSpec {
  /** The name errors use, such as "PocketBase". */
  label: string;
  /** The temporary directory's prefix under `tmpdir()`. */
  prefix: string;
  /** The binary's path (downloaded on first use). */
  binary(): Promise<string>;
  /** The arguments after `serve --http=...` for a server whose files live under `root`. */
  serveArgs(root: string): Array<string>;
}

function field(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { name, type, required: false, ...extra };
}

/** Runs one CLI command of `binary`; returns its stdout, throws with stderr on a failure. */
export async function command(label: string, binary: string, args: Array<string>) {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${label} ${args[0]} failed (${code}): ${stderr}`);
  }
  return stdout;
}

/**
 * Settles once every thread of process `pid` is in the stopped state. A SIGSTOP stops a
 * multi-threaded process one thread at a time, each when it next runs, so `kill` returns while
 * some threads (a Go scheduler, a network poller) can still answer a request. A thread that exits
 * meanwhile (zombie `Z`, dead `X`, or its task entry gone) cannot answer either, so it counts as
 * stopped. Linux only, like the release targets.
 */
export async function stopped(label: string, pid: number): Promise<void> {
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
      throw new Error(`${label} threads not stopped: ${states.join("")}`);
    }
    await Bun.sleep(1);
  }
}

/**
 * Starts the binary on `port`; resolves once it answers /api/health and this very process listens
 * on the port (B162b r1). Under parallel test workers another test's server can take a freed port
 * and answer /api/health while this child is failing its bind, so a 200 alone does not prove the
 * start (`listensOn` in serve-port.ts). A start that fails is killed and reaped before it throws.
 */
async function serve(
  spec: ServerSpec,
  binary: string,
  root: string,
  port: number,
): Promise<ChildProcess> {
  const child = spawn(binary, ["serve", `--http=127.0.0.1:${port}`, ...spec.serveArgs(root)], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
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
      throw new Error(`${spec.label} exited (${code}): ${stderr}`);
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
  throw new Error(`${spec.label} did not start: ${stderr}`);
}

/** Starts a server of `spec` with the fixture schema and the service account. */
export async function startHarness(spec: ServerSpec): Promise<PocketBase> {
  const binary = await spec.binary();
  const root = mkdtempSync(join(tmpdir(), spec.prefix));
  const dir = join(root, "pb_data");
  let child: ChildProcess | undefined;
  let port = 0;
  try {
    await command(spec.label, binary, [
      "superuser",
      "upsert",
      SUPERUSER,
      SUPERUSER_PASSWORD,
      `--dir=${dir}`,
    ]);
    child = await startOnFreePort(async (free) => {
      port = free;
      return serve(spec, binary, root, free);
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
      throw new Error(`${spec.label} ${method} ${path}: ${response.status} ${text}`);
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
    await fixtureSchema(api);
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
    stop,
    async start() {
      if (!process) {
        // Another test can take the port this one just released: retried on the same port.
        process = await restartOnPort(port, (same) => serve(spec, binary, root, same));
        await signIn();
      }
    },
    async pause() {
      const running = process;
      if (!running?.pid) {
        throw new Error(`${spec.label} is not running`);
      }
      running.kill("SIGSTOP");
      await stopped(spec.label, running.pid);
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

/** The fixture schema and the service account, through the superuser API. */
async function fixtureSchema(api: PocketBase["api"]) {
  const rules = { listRule: serviceRule, viewRule: serviceRule };
  await api("POST", "/api/collections", { name: "services", type: "auth", fields: [] });
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
}
