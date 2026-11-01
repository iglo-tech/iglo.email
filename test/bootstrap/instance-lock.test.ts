// One process per data directory (D69), through the compiled executable and real processes.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  admin,
  apiClient,
  buildExecutable,
  createSubscriber,
  provisionAuthorization,
  removeDirectory,
  runBackup,
  startServer,
  temporaryDirectory,
  type Server,
} from "@/test/backup/fixture";

setDefaultTimeout(60_000);

let build = "";
let executable = "";
let base = "";
let data = "";
const running: Server[] = [];

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(() => removeDirectory(build));
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.kill()));
  removeDirectory(base);
});

async function serve(dataDir = data) {
  const server = await startServer(executable, dataDir);
  running.push(server);
  return server;
}
const forget = (server: Server) => running.splice(running.indexOf(server), 1);

const inUse = (dataDir: string) =>
  `${dataDir} is in use by another iglo.email process: stop it first\n`;

/** A run that must end by itself: a second server that kept serving fails here, not by hanging. */
async function run(args: string[], options: { stdin?: string; cwd?: string } = {}) {
  const child = Bun.spawn([executable, ...args], {
    env: { PATH: "" },
    cwd: options.cwd ?? base,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(watchdog);
  return { exitCode, stdout, stderr };
}

/** On a port of its own, so only the lock can stop it. */
function secondServer(dataDir: string, options?: { cwd?: string }) {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = String(probe.port);
  probe.stop(true);
  return run(["serve", "--host", "127.0.0.1", "--port", port, "--data-dir", dataDir], options);
}

/** The database as it stands on disk. */
const fileBytes = (dataDir: string) =>
  ["iglo-email.db", "iglo-email.db-wal"].map((name) =>
    Bun.hash(readFileSync(join(dataDir, name))).toString(),
  );

async function logIn(origin: string, password: string) {
  const page = await fetch(`${origin}/admin/login`);
  const cookie = page.headers.getSetCookie()[0]!.split(";")[0]!;
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())![1]!;
  const entered = await fetch(`${origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nonce, username: admin.user, password, next: "/admin" }).toString(),
  });
  return entered.headers.get("location");
}

function freshDirectories() {
  base = temporaryDirectory();
  data = join(base, "data");
}

test("a second server refuses, before the database, and the first keeps serving", async () => {
  freshDirectories();
  const first = await serve();
  const client = apiClient(first.origin, await provisionAuthorization(first.origin));
  expect((await createSubscriber(client, 1)).status).toBe(200);
  const before = fileBytes(data);

  const second = await secondServer(data);

  expect(second.exitCode).toBe(1);
  expect(second.stderr).toBe(inUse(data));
  expect(second.stdout).toBe("");
  expect(fileBytes(data)).toEqual(before);
  expect((await fetch(first.health)).status).toBe(200);
  const listed = await client("/api/subscribers").then((response) => response.json());
  expect(listed.data.total).toBe(1);
});

test("every path to one directory meets the same lock", async () => {
  freshDirectories();
  await serve();
  const alias = join(base, "alias");
  symlinkSync(data, alias);

  const throughLink = await secondServer(alias);
  expect(throughLink.exitCode).toBe(1);
  expect(throughLink.stderr).toBe(inUse(alias));

  const relative = await secondServer("./data", { cwd: base });
  expect(relative.exitCode).toBe(1);
  expect(relative.stderr).toBe(inUse(data));
});

test("of two servers started together, exactly one serves", async () => {
  freshDirectories();
  const outcomes = await Promise.allSettled([
    startServer(executable, data),
    startServer(executable, data),
  ]);
  const served = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? [outcome.value] : [],
  );
  running.push(...served);
  expect(served).toHaveLength(1);
  const refused = outcomes.find((outcome) => outcome.status === "rejected");
  expect(refused?.reason.message).toBe(inUse(data));
});

test("a killed server's lock is gone: the leftover file blocks nothing", async () => {
  freshDirectories();
  const first = await serve();
  const authorization = await provisionAuthorization(first.origin);
  await createSubscriber(apiClient(first.origin, authorization), 1);
  forget(first);
  await first.kill();
  expect(existsSync(join(data, "iglo-email.lock"))).toBe(true);

  const restarted = await serve();

  const listed = await apiClient(restarted.origin, authorization)("/api/subscribers");
  expect((await listed.json()).data.total).toBe(1);
  // The file was already there this time, and the lock on it is as real.
  const second = await secondServer(data);
  expect(second.exitCode).toBe(1);
  expect(second.stderr).toBe(inUse(data));
});

test("a stopped server's lock is released", async () => {
  freshDirectories();
  const first = await serve();
  forget(first);
  expect(await first.stop()).toBe(0);
  const restarted = await serve();
  expect((await fetch(restarted.health)).status).toBe(200);
});

test("a lock file with any content blocks nothing, and still locks", async () => {
  freshDirectories();
  mkdirSync(data);
  writeFileSync(join(data, "iglo-email.lock"), "damaged ".repeat(2_000));
  await serve();
  const second = await secondServer(data);
  expect(second.exitCode).toBe(1);
  expect(second.stderr).toBe(inUse(data));
});

// A read-only open would take no lock at all, so this must not start. Root can write the file.
test.skipIf(process.getuid?.() === 0)("a lock file it cannot write stops the server", async () => {
  freshDirectories();
  mkdirSync(data);
  const lock = join(data, "iglo-email.lock");
  writeFileSync(lock, "");
  chmodSync(lock, 0o444);
  const refused = await secondServer(data);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toStartWith(`Cannot lock ${lock}: `);
  expect(existsSync(join(data, "iglo-email.db"))).toBe(false);
});

test("two data directories run side by side", async () => {
  freshDirectories();
  const left = await serve(join(base, "left"));
  const right = await serve(join(base, "right"));
  expect((await fetch(left.health)).status).toBe(200);
  expect((await fetch(right.health)).status).toBe(200);
});

test("reads run beside a server, and the lock outlives them", async () => {
  freshDirectories();
  const server = await serve();
  const client = apiClient(server.origin, await provisionAuthorization(server.origin));
  await createSubscriber(client, 1);

  // Each of these runs in a helper child of the server (D62).
  expect((await client("/api/dashboard/charts")).status).toBe(200);
  expect((await client("/api/sends/analytics?from=2020-01-01&to=2099-01-01")).status).toBe(200);
  const query = encodeURIComponent("subscribers.id > 0");
  const found = await client(`/api/subscribers?query=${query}`).then((response) => response.json());
  expect(found.data.total).toBe(1);

  const output = join(base, "monday");
  const backup = await runBackup(executable, ["--data-dir", data, "--output", output]);
  expect(backup.exitCode).toBe(0);
  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode).toBe(0);
  expect(verified.stdout).toContain("Integrity: ok");

  expect((await run(["--version"])).exitCode).toBe(0);
  expect((await run(["--help"])).exitCode).toBe(0);

  const second = await secondServer(data);
  expect(second.exitCode).toBe(1);
  expect(second.stderr).toBe(inUse(data));
});

test("commands that write refuse beside a server, then work without one", async () => {
  freshDirectories();
  const server = await serve();
  const before = fileBytes(data);
  const password = "a-new-password";
  const reset = ["reset-password", "--data-dir", data, "--user", admin.user];
  const release = ["backup", "--release-hold", "--consent-reconciled", "--data-dir", data];

  for (const refused of [await run(reset, { stdin: password }), await run(release)]) {
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toBe(inUse(data));
    expect(refused.stdout).toBe("");
  }
  expect(fileBytes(data)).toEqual(before);
  expect(await logIn(server.origin, admin.password)).toBe("/admin");

  forget(server);
  await server.stop();
  expect((await run(reset, { stdin: password })).exitCode).toBe(0);
  expect((await run(release)).exitCode).toBe(0);
  const restarted = await serve();
  expect(await logIn(restarted.origin, password)).toBe("/admin");
});

test("a command leaves a directory without a database as it found it", async () => {
  freshDirectories();
  const missing = join(base, "missing");
  mkdirSync(base, { recursive: true });
  const result = await run(["reset-password", "--data-dir", missing, "--user", "x"], {
    stdin: "a-long-password",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe(`No database at ${join(missing, "iglo-email.db")}\n`);
  expect(statSync(missing, { throwIfNoEntry: false })).toBeUndefined();
});
