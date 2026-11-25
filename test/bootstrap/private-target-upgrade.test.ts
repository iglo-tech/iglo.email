// B125 (D122, lead decisions): an upgrade from an earlier release turns a stored
// `webhooks.block_private_addresses = false` on, once. Then, at every start while the block is on,
// each enabled webhook whose target it refuses is named once on stderr and in the log buffer, by ID
// and host. Through the compiled executable, with the data directory seeded as an earlier release
// left it. No receiver and no DNS: the targets are IP literals, and the check only tests them.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureProductionBuild } from "@/test/production-build";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";
import { readJson } from "@/test/read-body";
import { untilState } from "@/test/wait";
import { instanceClient } from "@/test/settings/instance-client";

const repository = resolve(import.meta.dir, "../..");
setDefaultTimeout(60_000);
const key = "webhooks.block_private_addresses";
/** The buffer's fixed text for the notice (src/webhooks/delivery.ts REFUSED_NOTICE). */
const fixed = "A webhook target is refused by the private-address block";
// B138b: every stderr line names its project (14-projects section 9).
const refusedLine = `[main] Webhook 1 target 127.0.0.1:9 is refused by ${key} (D122)`;
const tokenAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const apiUser = "upgrade-api";
const token = Array.from(
  crypto.getRandomValues(new Uint8Array(48)),
  (byte) => tokenAlphabet[byte % 62],
).join("");
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
  temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-upgrade-"));
  executable = join(temporaryDirectory, "iglo.email");
  await copyFile(join(repository, "dist", "iglo.email"), executable);
  await chmod(executable, 0o755);
}, 60_000);

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

/** The executable with a clean environment, on port 0 (D144): it names the port the OS gave it. */
function start(dataDir: string) {
  const args = ["--port", "0", "--root-url", portZeroRootUrl, "--data-dir", dataDir];
  return Bun.spawn([executable, ...args], {
    cwd: temporaryDirectory,
    env: {
      PATH: "",
      IGLO_EMAIL_ADMIN_USER: adminUser,
      IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
      IGLO_EMAIL_API_USER: apiUser,
      IGLO_EMAIL_API_TOKEN: token,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** B139 (D154): the key is an instance key, read and changed with the instance session. */
const instance = (port: number) =>
  instanceClient(`http://127.0.0.1:${port}`, { user: adminUser, password: adminPassword });

/** A started process, healthy on its port. */
async function up(dataDir: string) {
  const child = start(dataDir);
  const { port } = await readyOnPortZero(child, 30_000);
  return { child, port };
}

/** An API call as the API user. */
async function api<T = unknown>(port: number, method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `token ${apiUser}:${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: (await readJson<{ data: T }>(response)).data };
}

/** The log buffer's lines that contain `text`. */
const logLines = async (port: number, text: string) =>
  (await api<Array<string>>(port, "GET", "/api/logs")).data.filter((line) => line.includes(text));

/** Waits until this process has named a refused webhook in its log buffer. */
async function noticed(port: number) {
  let lines = 0;
  await untilState(async () => (lines = (await logLines(port, fixed)).length) > 0, {
    label: "refused private target logged",
    progress: () => String(lines),
    stallMs: 20_000,
    intervalMs: 50,
  });
}

/**
 * The check has no answer to wait for when nothing is refused, so a start that should name nothing
 * waits this long for its background check to run (the injected clock is not in this process).
 */
const settle = () => Bun.sleep(1000);

/** Stops the process and returns its stderr lines that name a webhook. */
async function stopped(child: ReturnType<typeof start>) {
  await stopChild(child);
  const stderr = await new Response(child.stderr).text();
  return stderr.split("\n").filter((line) => line.includes("Webhook "));
}

/** An earlier release's data directory: one first start, then schema 23 with this key false. */
async function earlierRelease(): Promise<string> {
  const dataDir = join(temporaryDirectory, crypto.randomUUID());
  const first = await up(dataDir);
  await stopChild(first.child);
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"), {
    readwrite: true,
    strict: true,
  });
  try {
    // Schema 23 has neither the campaign delivery reason nor its index (migration 25, B116), nor the
    // rotated-secret columns (migration 26, D130), so the upgrade must add all of them.
    db.run("DROP INDEX idx_campaign_deliveries_skipped");
    // Schema 23 has the send status index that migration 28 replaces, so it is put back here.
    db.run("DROP INDEX idx_sends_status_id");
    db.run("CREATE INDEX idx_sends_outbox ON sends(status, created_at)");
    db.run("ALTER TABLE campaign_deliveries DROP COLUMN reason");
    db.run("ALTER TABLE webhooks DROP COLUMN previous_secret_until");
    db.run("ALTER TABLE webhooks DROP COLUMN previous_secret");
    // Schema 23 has no enrollment exit condition either (migration 29, B127 r2).
    db.run("ALTER TABLE enrollments DROP COLUMN exit_condition");
    // Migration 31 (B117d) names each send, and schema 23 has no such columns.
    db.run("ALTER TABLE sends DROP COLUMN template_name");
    db.run("ALTER TABLE sends DROP COLUMN sequence_name");
    // Migration 32 (B140) marks the admin's copy; the earlier schema has no such column.
    db.run("DROP INDEX users_one_admin_copy");
    db.run("ALTER TABLE users DROP COLUMN admin_copy");
    db.run("UPDATE settings SET value = 'false' WHERE key = ?", [key]);
    db.run("INSERT INTO webhooks (id, url, secret, events) VALUES (1, ?, 'secret', '[]')", [
      "http://127.0.0.1:9/hook",
    ]);
    db.run("INSERT INTO webhooks (id, url, secret, events) VALUES (2, ?, 'secret', '[]')", [
      "http://93.184.216.34/hook",
    ]);
    db.run("PRAGMA user_version = 23");
  } finally {
    db.close(true);
  }
  return dataDir;
}

function userVersion(dataDir: string): number {
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"), { readonly: true });
  try {
    return Number(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    );
  } finally {
    db.close(true);
  }
}

test("an upgrade turns the stored false on, and every restart names the refused webhook while it is refused", async () => {
  const dataDir = await earlierRelease();

  const upgraded = await up(dataDir);
  await noticed(upgraded.port);
  // B139: the stored false went with every instance key (migration 33); the instance default holds.
  expect((await (await instance(upgraded.port)).read())[key]).toBe(true);
  // The public webhook, id 2, is never named.
  expect(await stopped(upgraded.child)).toEqual([refusedLine]);
  expect(userVersion(dataDir)).toBe(33);

  // A restart, with the target still refused: named again.
  const restarted = await up(dataDir);
  await noticed(restarted.port);
  expect(await stopped(restarted.child)).toEqual([refusedLine]);
});

test("fixing the refused target stops the line", async () => {
  const dataDir = await earlierRelease();
  const first = await up(dataDir);
  await noticed(first.port);
  expect(
    (await api(first.port, "PUT", "/api/webhooks/1", { url: "http://93.184.216.34/hook" })).status,
  ).toBe(200);
  expect(await stopped(first.child)).toEqual([refusedLine]);

  const fixed_ = await up(dataDir);
  await settle();
  expect(await logLines(fixed_.port, fixed)).toHaveLength(0);
  expect(await stopped(fixed_.child)).toEqual([]);
});

test("setting the block off stops the line, and a later restart keeps it off", async () => {
  const dataDir = await earlierRelease();
  const first = await up(dataDir);
  await noticed(first.port);
  await (await instance(first.port)).put(key, false);
  expect(await stopped(first.child)).toEqual([refusedLine]);

  const off = await up(dataDir);
  await settle();
  expect((await (await instance(off.port)).read())[key]).toBe(false);
  expect(await logLines(off.port, fixed)).toHaveLength(0);
  expect(await stopped(off.child)).toEqual([]);
});
