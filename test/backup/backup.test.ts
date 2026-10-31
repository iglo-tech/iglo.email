// `backup` through the compiled executable: snapshots of a live server, in temporary directories.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createBackup } from "@/backup/snapshot";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import {
  apiClient,
  buildExecutable,
  createSubscriber,
  provisionAuthorization,
  removeDirectory,
  restoreInto,
  runBackup,
  seedSubscribers,
  startServer,
  temporaryDirectory,
  uploadFile,
  type Client,
  type Server,
} from "@/test/backup/fixture";

setDefaultTimeout(60_000);
const PARTIAL = ".iglo-email-backup-partial-";
const version = productionMigrations.length;
let executable = "";
let build = "";
let base = "";
let dataDir = "";
let authorization = "";
let server: Server | undefined;

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
}, 120_000);
afterAll(() => removeDirectory(build));
afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (base) removeDirectory(base);
  base = "";
});

/** A running server with a fresh data directory, and an API client for it. */
async function live() {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  server = await startServer(executable, dataDir);
  authorization = await provisionAuthorization(server.origin);
  return apiClient(server.origin, authorization);
}
const stopped = async () => {
  await server!.stop();
  server = undefined;
};
const subscriberTotal = async (client: Client) => {
  const response = await client("/api/subscribers?per_page=1");
  return ((await response.json()) as { data: { total: number } }).data.total;
};
const names = (directory: string) => readdirSync(directory).sort();

test("a backup under write load restores, opens and holds what was committed", async () => {
  const client = await live();
  const uploaded = await uploadFile(client, "kept.txt", "kept bytes");
  expect(uploaded.status).toBe(200);
  for (let i = 0; i < 20; i++)
    expect((await createSubscriber(client, `before-${i}`)).status).toBe(200);

  let writing = true;
  let written = 0;
  const failures: number[] = [];
  const writers = [0, 1, 2, 3].map(async (writer) => {
    for (let i = 0; writing; i++) {
      const { status } = await createSubscriber(client, `load-${writer}-${i}`);
      if (status === 200) written++;
      else failures.push(status);
    }
  });
  const uploader = (async () => {
    for (let i = 0; writing; i++) {
      const { status } = await uploadFile(client, `load-${i}.txt`, `bytes of ${i}`);
      if (status !== 200) failures.push(status);
    }
  })();
  while (written < 50) await Bun.sleep(5);
  const acknowledged = written;
  const output = join(base, "backup");
  const backup = await runBackup(executable, ["--data-dir", dataDir, "--output", output]);
  const during = written - acknowledged;
  while (written < acknowledged + during + 20) await Bun.sleep(5);
  writing = false;
  await Promise.all([...writers, uploader]);
  expect(failures).toEqual([]);
  // Uploads never stopped: the files copied after the snapshot cover every row in it.
  expect(backup.stderr).toBe("");
  expect(backup.exitCode).toBe(0);
  expect(backup.stdout).toContain(`Schema version: ${version}`);
  await stopped();

  expect(statSync(output).mode & 0o777).toBe(0o700);
  expect(statSync(join(output, "iglo-email.db")).mode & 0o777).toBe(0o600);
  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode).toBe(0);
  expect(verified.stdout).toContain(`Schema version: ${version}`);
  expect(verified.stdout).toContain("Integrity: ok");

  restoreInto(output, dataDir);
  server = await startServer(executable, dataDir);
  expect(await (await fetch(server.health)).json()).toEqual({ data: true });
  const restored = apiClient(server.origin, authorization);
  const total = await subscriberTotal(restored);
  expect(total).toBeGreaterThanOrEqual(20 + acknowledged);
  expect(total).toBeLessThan(20 + written);
  const file = await fetch(`${server.origin}/uploads/kept.txt`);
  expect(await file.text()).toBe("kept bytes");
  expect((await createSubscriber(restored, "after-restore")).status).toBe(200);
});

for (const signal of ["SIGKILL", "SIGTERM"] as const)
  test(`${signal} midway leaves nothing that looks complete`, async () => {
    base = temporaryDirectory();
    dataDir = join(base, "data");
    mkdirSync(join(dataDir, "uploads"), { recursive: true });
    await (await startServer(executable, dataDir)).stop();
    seedSubscribers(dataDir, 300_000);
    server = await startServer(executable, dataDir);
    const destination = join(base, "destination");
    mkdirSync(destination);
    const output = join(destination, "backup");

    const child = Bun.spawn([executable, "backup", "--data-dir", dataDir, "--output", output], {
      env: { PATH: "" },
      stdout: "ignore",
      stderr: "ignore",
    });
    let partial: string | undefined;
    for (const deadline = Date.now() + 20_000; !partial && Date.now() < deadline;) {
      partial = names(destination).find((name) => name.startsWith(PARTIAL));
      if (!partial || statSync(join(destination, partial, "iglo-email.db")).size === 0) {
        partial = undefined;
        await Bun.sleep(1);
      }
    }
    expect(partial).toBeDefined();
    child.kill(signal);
    expect(await child.exited).not.toBe(0);

    // The helper that syncs the snapshot goes with it.
    const helperRunning = () =>
      readdirSync("/proc").some((entry) => {
        try {
          return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(partial!);
        } catch {
          return false;
        }
      });
    for (const deadline = Date.now() + 5_000; helperRunning() && Date.now() < deadline;)
      await Bun.sleep(25);
    expect(helperRunning()).toBe(false);

    expect(existsSync(output)).toBe(false);
    expect(names(destination)).toEqual([partial!]);
    const refused = await runBackup(executable, ["--verify", join(destination, partial!)]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("interrupted backup");

    const next = await runBackup(executable, ["--data-dir", dataDir, "--output", output]);
    expect(next.exitCode).toBe(0);
    expect(next.stderr).toContain(partial!);
    expect((await runBackup(executable, ["--verify", output])).exitCode).toBe(0);
  });

test("a failure exits nonzero and leaves no file", async () => {
  const client = await live();
  await uploadFile(client, "unreadable.txt", "bytes");
  chmodSync(join(dataDir, "uploads", "unreadable.txt"), 0o000);
  const destination = join(base, "destination");
  mkdirSync(destination);
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(destination, "backup"),
  ]);
  chmodSync(join(dataDir, "uploads", "unreadable.txt"), 0o644);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).not.toBe("");
  expect(names(destination)).toEqual([]);
});

test("too little free space refuses before anything is written", async () => {
  await live();
  const destination = join(base, "destination");
  mkdirSync(destination);
  expect(() =>
    createBackup({
      dataDir,
      output: join(destination, "backup"),
      clock: createRealClock(),
      supportedVersion: version,
      available: () => 1024,
      warn() {},
    }),
  ).toThrow("A backup needs about");
  expect(names(destination)).toEqual([]);
});

test("an existing backup is replaced only when told, and only a backup", async () => {
  const client = await live();
  const output = join(base, "backup");
  const args = ["--data-dir", dataDir, "--output", output];
  expect((await runBackup(executable, args)).exitCode).toBe(0);
  await createSubscriber(client, "newer");

  const refused = await runBackup(executable, args);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("--force");
  expect((await runBackup(executable, [...args, "--force"])).exitCode).toBe(0);
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);
  const replaced = new Database(join(output, "iglo-email.db"), { readonly: true });
  expect(
    replaced.query("SELECT count(*) AS count FROM subscribers").get() as { count: number },
  ).toEqual({ count: 1 });
  replaced.close();

  const other = join(base, "other");
  mkdirSync(other);
  writeFileSync(join(other, "precious.txt"), "not a backup");
  const kept = await runBackup(executable, ["--data-dir", dataDir, "--output", other, "--force"]);
  expect(kept.exitCode).toBe(1);
  expect(readFileSync(join(other, "precious.txt"), "utf8")).toBe("not a backup");

  const self = await runBackup(executable, ["--data-dir", dataDir, "--output", dataDir, "--force"]);
  expect(self.exitCode).toBe(1);
  expect(existsSync(join(dataDir, "iglo-email.db"))).toBe(true);
});

test("a file with no row is harmless, and a row with no file is reported and stays missing", async () => {
  const client = await live();
  await uploadFile(client, "gone.txt", "gone");
  await uploadFile(client, "kept.txt", "kept");
  writeFileSync(join(dataDir, "uploads", "orphan.txt"), "crash orphan");
  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  await stopped();
  // As if the file went in the moment after the snapshot.
  rmSync(join(output, "uploads", "gone.txt"));

  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode).toBe(0);
  expect(verified.stderr).toContain("gone.txt");
  restoreInto(output, dataDir);
  server = await startServer(executable, dataDir);
  expect((await fetch(`${server.origin}/uploads/gone.txt`)).status).toBe(404);
  expect((await fetch(`${server.origin}/uploads/orphan.txt`)).status).toBe(404);
  expect(await (await fetch(`${server.origin}/uploads/kept.txt`)).text()).toBe("kept");
  const restored = apiClient(server.origin, authorization);
  const media = await restored("/api/media");
  const rows = ((await media.json()) as { data: { results: { filename: string }[] } }).data.results;
  expect(rows.map(({ filename }) => filename).sort()).toEqual(["gone.txt", "kept.txt"]);
});

test("an upload directory named by the settings is backed up at its place", async () => {
  const client = await live();
  mkdirSync(join(dataDir, "media"));
  const response = await client("/api/settings/upload.filesystem.upload_path", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify("media"),
  });
  expect(response.status).toBe(200);
  await stopped();
  server = await startServer(executable, dataDir);
  const uploaded = await uploadFile(
    apiClient(server.origin, authorization),
    "custom.txt",
    "custom",
  );
  expect(uploaded.status).toBe(200);
  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  expect(readFileSync(join(output, "media", "custom.txt"), "utf8")).toBe("custom");
  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.stdout).toContain("Uploads: 1 files");
  expect(verified.stderr).toBe("");
});

test("a newer executable migrates a restored backup", async () => {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const older = openDatabase(dataDir);
  runMigrations(older, dataDir, createRealClock(), productionMigrations.slice(0, version - 1));
  older
    .query("INSERT INTO lists (uuid, name, type, optin) VALUES (?, 'kept', 'public', 'single')")
    .run(crypto.randomUUID());
  older.close(true);

  const output = join(base, "backup");
  const backup = await runBackup(executable, ["--data-dir", dataDir, "--output", output]);
  expect(backup.exitCode).toBe(0);
  expect(backup.stdout).toContain(`Schema version: ${version - 1}`);
  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode).toBe(0);
  expect(verified.stdout).toContain(`migrates this backup to version ${version}`);

  restoreInto(output, dataDir);
  server = await startServer(executable, dataDir);
  const client = apiClient(server.origin, await provisionAuthorization(server.origin));
  const lists = await (await client("/api/lists")).json();
  expect(JSON.stringify(lists)).toContain('"kept"');
  await stopped();
  expect(names(join(dataDir, "backups"))).toHaveLength(1);
  const after = await runBackup(executable, ["--verify", join(dataDir, "iglo-email.db")]);
  expect(after.stdout).toContain(`Schema version: ${version}`);
});

test("an older executable refuses a backup ahead of it", async () => {
  await live();
  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  await stopped();
  const ahead = new Database(join(output, "iglo-email.db"));
  ahead.run(`PRAGMA user_version = ${version + 1}`);
  ahead.close();

  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode).toBe(1);
  expect(verified.stdout).toContain(`Schema version: ${version + 1}`);
  expect(verified.stderr).toContain("ahead of this executable");
  restoreInto(output, dataDir);
  const refused = await startServer(executable, dataDir).catch((error: Error) => error);
  expect(String(refused)).toContain(`Database version ${version + 1} is ahead of this executable`);
});

test("--verify reports a damaged file and changes nothing", async () => {
  await live();
  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  const file = join(output, "iglo-email.db");
  const entries = names(output);
  const before = readFileSync(file);
  expect((await runBackup(executable, ["--verify", output])).exitCode).toBe(0);
  expect(names(output)).toEqual(entries);
  expect(readFileSync(file).equals(before)).toBe(true);

  // Pages of an index are scattered here: most of the file is structure.
  const damaged = Buffer.from(before);
  damaged.fill(0xa5, 8192, damaged.length - 8192);
  writeFileSync(file, damaged);
  const result = await runBackup(executable, ["--verify", output]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).not.toBe("");

  expect((await runBackup(executable, ["--verify", join(base, "absent")])).exitCode).toBe(1);
});

test("nothing is created for a directory without a database or a bad command line", async () => {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const empty = join(base, "empty");
  const result = await runBackup(executable, ["--data-dir", empty]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("No database");
  expect(existsSync(empty)).toBe(false);
  expect((await runBackup(executable, ["--unknown"])).exitCode).toBe(1);
  expect((await runBackup(executable, ["--output"])).exitCode).toBe(1);
  expect((await runBackup(executable, ["--verify", "x", "--force"])).exitCode).toBe(1);
  const help = await runBackup(executable, ["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("iglo.email backup --verify");
});
