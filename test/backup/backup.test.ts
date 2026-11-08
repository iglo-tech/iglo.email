// `backup` through the compiled executable: snapshots of a live server, in temporary directories.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  buildPublishEntry,
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
const HOLD_HEADER = "x-iglo-email-hold";
const version = productionMigrations.length;
let executable = "";
let publishEntry = "";
let build = "";
let base = "";
let dataDir = "";
let authorization = "";
let server: Server | undefined;

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
  publishEntry = await buildPublishEntry(build);
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
  expect(((await (await fetch(server.health)).json()) as { data: boolean }).data).toBe(true);
  const restored = apiClient(server.origin, authorization);
  const total = await subscriberTotal(restored);
  expect(total).toBeGreaterThanOrEqual(20 + acknowledged);
  expect(total).toBeLessThan(20 + written);
  const file = await fetch(`${server.origin}/uploads/kept.txt`);
  expect(await file.text()).toBe("kept bytes");
  expect((await createSubscriber(restored, "after-restore")).status).toBe(200);
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

test("an upload directory reached through an alias is served after a restore", async () => {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  mkdirSync(join(dataDir, "media"), { recursive: true });
  symlinkSync("media", join(dataDir, "uploads"));
  server = await startServer(executable, dataDir);
  authorization = await provisionAuthorization(server.origin);
  const client = apiClient(server.origin, authorization);
  expect((await uploadFile(client, "aliased.txt", "aliased")).status).toBe(200);
  expect(await (await fetch(`${server.origin}/uploads/aliased.txt`)).text()).toBe("aliased");
  await stopped();

  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.stdout).toContain("Uploads: 1 files");
  expect(verified.stderr).toBe("");
  restoreInto(output, dataDir);
  server = await startServer(executable, dataDir);
  const restored = await fetch(`${server.origin}/uploads/aliased.txt`);
  expect(restored.status).toBe(200);
  expect(await restored.text()).toBe("aliased");
  const again = await uploadFile(apiClient(server.origin, authorization), "new.txt", "new");
  expect(again.status).toBe(200);
  expect(await (await fetch(`${server.origin}/uploads/new.txt`)).text()).toBe("new");
});

test("--verify looks where the restored setting does, not only where the manifest says", async () => {
  const client = await live();
  mkdirSync(join(dataDir, "media"));
  const moved = await client("/api/settings/upload.filesystem.upload_path", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify("media"),
  });
  expect(moved.status).toBe(200);
  await stopped();
  server = await startServer(executable, dataDir);
  await uploadFile(apiClient(server.origin, authorization), "placed.txt", "placed");
  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  // The shape an alias used to leave: the files in one place, the setting naming another.
  const snapshot = new Database(join(output, "iglo-email.db"));
  snapshot
    .query("UPDATE settings SET value = ? WHERE key = ?")
    .run(JSON.stringify("uploads"), "upload.filesystem.upload_path");
  snapshot.close();
  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.stderr).toContain("placed.txt");
});

test("backed-up media is closed to everyone but its owner", async () => {
  const client = await live();
  await uploadFile(client, "private.txt", "private");
  chmodSync(join(dataDir, "uploads", "private.txt"), 0o664);
  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  expect(statSync(join(output, "uploads")).mode & 0o777).toBe(0o700);
  expect(statSync(join(output, "uploads", "private.txt")).mode & 0o777).toBe(0o600);
});

test("overlapping backups to one path: one wins, and neither replaces the other", async () => {
  await live();
  await stopped();
  seedSubscribers(dataDir, 20_000);
  server = await startServer(executable, dataDir);
  const output = join(base, "backup");
  const args = ["--data-dir", dataDir, "--output", output];
  const results = await Promise.all([runBackup(executable, args), runBackup(executable, args)]);
  expect(results.map(({ exitCode }) => exitCode).sort()).toEqual([0, 1]);
  expect(results.find(({ exitCode }) => exitCode === 1)!.stderr).toContain("--force");
  expect((await runBackup(executable, ["--verify", output])).exitCode).toBe(0);
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);
});

test("a path taken while the backup runs is not replaced, and --force still checks it", async () => {
  await live();
  const output = join(base, "backup");
  const claimed = () => {
    mkdirSync(output);
    writeFileSync(join(output, "precious.txt"), "someone else's");
    return Number.MAX_SAFE_INTEGER;
  };
  const backup = (force: boolean) =>
    createBackup({
      dataDir,
      output,
      force,
      clock: createRealClock(),
      supportedVersion: version,
      available: claimed,
      warn() {},
    });
  expect(() => backup(false)).toThrow("already exists");
  expect(readFileSync(join(output, "precious.txt"), "utf8")).toBe("someone else's");
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);
  rmSync(output, { recursive: true });
  // Claiming the path again fails inside the callback only if it is there: start from nothing.
  expect(() => backup(true)).toThrow("does not look like a backup");
  expect(readFileSync(join(output, "precious.txt"), "utf8")).toBe("someone else's");
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);
});

const publishing = async (action: string, path: string, ...args: string[]) => {
  const child = Bun.spawn([publishEntry, action, path, ...args], {
    env: { PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, signal: child.signalCode };
};

test("a directory that appears at the last moment survives with its content", async () => {
  await live();
  const output = join(base, "backup");
  const race = await publishing("claim", output, "--data-dir", dataDir, "--output", output);
  expect(race.stderr).toContain("already exists");
  expect(race.exitCode).toBe(1);
  expect(readdirSync(output)).toEqual(["precious.txt"]);
  expect(readFileSync(join(output, "precious.txt"), "utf8")).toBe("someone else's");
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);
});

test("a file that appears at the last moment survives, and an empty directory gives way", async () => {
  await live();
  const output = join(base, "backup");
  const race = await publishing("file", output, "--data-dir", dataDir, "--output", output);
  expect(race.exitCode).toBe(1);
  expect(readFileSync(output, "utf8")).toBe("someone else's");
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);

  const empty = join(base, "empty");
  const replaced = await publishing("empty", empty, "--data-dir", dataDir, "--output", empty);
  expect(replaced.exitCode).toBe(0);
  expect((await runBackup(executable, ["--verify", empty])).exitCode).toBe(0);
});

test("--force checks the target it actually moves, and puts back what it should not", async () => {
  await live();
  const output = join(base, "backup");
  const args = ["--data-dir", dataDir, "--output", output];
  expect((await runBackup(executable, args)).exitCode).toBe(0);
  const directory = await publishing("claim", output, ...args, "--force");
  expect(directory.stderr).toContain("does not look like a backup");
  expect(directory.exitCode).toBe(1);
  expect(readdirSync(output)).toEqual(["precious.txt"]);
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);

  rmSync(output, { recursive: true });
  expect((await runBackup(executable, args)).exitCode).toBe(0);
  const file = await publishing("file", output, ...args, "--force");
  expect(file.stderr).toContain("does not look like a backup");
  expect(file.exitCode).toBe(1);
  expect(readFileSync(output, "utf8")).toBe("someone else's");
  expect(names(base).filter((name) => name.startsWith("."))).toEqual([]);
});

test("a kill at publication leaves nothing at the name, and a retry works", async () => {
  await live();
  const output = join(base, "backup");
  const args = ["--data-dir", dataDir, "--output", output];
  const killed = await publishing("kill", output, ...args);
  expect(killed.signal).toBe("SIGKILL");
  expect(existsSync(output)).toBe(false);
  const retry = await runBackup(executable, args);
  expect(retry.stderr + retry.stdout).toContain("interrupted backup");
  expect(retry.exitCode).toBe(0);
  expect((await runBackup(executable, ["--verify", output])).exitCode).toBe(0);
});

test("a pre-migration snapshot is held, and the install it came from is not", async () => {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  const older = openDatabase(dataDir);
  runMigrations(older, dataDir, createRealClock(), productionMigrations.slice(0, version - 1));
  older.close(true);

  server = await startServer(executable, dataDir);
  expect((await fetch(server.health)).headers.get(HOLD_HEADER)).toBeNull();
  await stopped();
  const [snapshot] = names(join(dataDir, "backups"));
  const path = join(dataDir, "backups", snapshot!);
  expect((await runBackup(executable, ["--verify", path])).stdout).toMatch(/Hold: held since /);

  // Put back as the guide says, it starts held and keeps migrating.
  copyFileSync(path, join(base, "snapshot.db"));
  removeDirectory(dataDir);
  mkdirSync(dataDir);
  copyFileSync(join(base, "snapshot.db"), join(dataDir, "iglo-email.db"));
  server = await startServer(executable, dataDir);
  expect((await fetch(server.health)).headers.get(HOLD_HEADER)).not.toBeNull();
});

test("a migration that fails rolls back on its own: the live database stays unheld", async () => {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  const db = openDatabase(dataDir);
  const clock = createRealClock();
  const before = productionMigrations.slice(0, version - 1);
  runMigrations(db, dataDir, clock, before);
  expect(() =>
    runMigrations(db, dataDir, clock, [
      ...before,
      { version, sql: "CREATE TABLE half_done (id INTEGER); INSERT INTO nowhere VALUES (1);" },
    ]),
  ).toThrow();
  db.close(true);
  const [snapshot] = names(join(dataDir, "backups"));
  const report = await runBackup(executable, ["--verify", join(dataDir, "backups", snapshot!)]);
  expect(report.stdout).toMatch(/Hold: held since /);
  const live = await runBackup(executable, ["--verify", join(dataDir, "iglo-email.db")]);
  expect(live.stdout).not.toContain("Hold:");
  expect(live.stdout).toContain(`Schema version: ${version - 1}`);
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
  // The migration keeps the restore hold the backup placed.
  expect((await fetch(server.health)).headers.get(HOLD_HEADER)).not.toBeNull();
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
  const dataDirectory = await runBackup(executable, ["--verify", dataDir]);
  expect(dataDirectory.exitCode).toBe(1);
  expect(dataDirectory.stderr).toContain("not a backup");
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

test("on an empty, freshly started data directory, backup --output creates missing parent directories", async () => {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  server = await startServer(executable, dataDir);
  const monday = join(dataDir, "backups", "monday");
  const backup = await runBackup(executable, ["--data-dir", dataDir, "--output", monday]);
  expect(backup.exitCode).toBe(0);
  expect(backup.stderr).toBe("");
  expect(statSync(join(dataDir, "backups")).mode & 0o777).toBe(0o700);
  expect(statSync(monday).mode & 0o777).toBe(0o700);
  expect(statSync(join(monday, "iglo-email.db")).mode & 0o777).toBe(0o600);
  const verified = await runBackup(executable, ["--verify", monday]);
  expect(verified.exitCode).toBe(0);
  expect(verified.stdout).toContain("Integrity: ok");
  await stopped();
});

test("a backup refused for no schema creates none of the folders its output would need", async () => {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  mkdirSync(dataDir);
  new Database(join(dataDir, "iglo-email.db")).close();
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(base, "a", "b", "c", "out"),
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("has no schema yet");
  expect(existsSync(join(base, "a"))).toBe(false);
});

test("a backup refused for an output inside the uploads creates none of the folders it needs", async () => {
  await live();
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(dataDir, "uploads", "a", "b", "c", "out"),
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("is inside the upload directory");
  expect(existsSync(join(dataDir, "uploads", "a"))).toBe(false);
});

test("a backup refused for too little space creates none of the folders its output would need", async () => {
  await live();
  expect(() =>
    createBackup({
      dataDir,
      output: join(base, "x", "y", "z", "backup"),
      clock: createRealClock(),
      supportedVersion: version,
      available: () => 1024,
      warn() {},
    }),
  ).toThrow("A backup needs about");
  expect(existsSync(join(base, "x"))).toBe(false);
});

test("a refusal keeps the folders that already existed, and what is in them", async () => {
  await live();
  const taken = join(base, "taken");
  mkdirSync(taken);
  writeFileSync(join(taken, "keep.txt"), "kept");
  const exists = await runBackup(executable, ["--data-dir", dataDir, "--output", taken]);
  expect(exists.exitCode).toBe(1);
  expect(exists.stderr).toContain("already exists");
  expect(readFileSync(join(taken, "keep.txt"), "utf8")).toBe("kept");

  const kept = join(dataDir, "uploads", "kept");
  mkdirSync(kept);
  writeFileSync(join(kept, "keep.txt"), "kept too");
  const inside = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(kept, "new", "out"),
  ]);
  expect(inside.exitCode).toBe(1);
  expect(inside.stderr).toContain("is inside the upload directory");
  expect(names(kept)).toEqual(["keep.txt"]);
  expect(readFileSync(join(kept, "keep.txt"), "utf8")).toBe("kept too");
});

test("a parent that is a regular file is named as a file, not reported as a raw ENOTDIR", async () => {
  await live();
  writeFileSync(join(base, "afile"), "not a folder");
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(base, "afile", "out"),
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`${join(base, "afile")} is a file, not a folder`);
  expect(result.stderr).not.toContain("ENOTDIR");
  expect(readFileSync(join(base, "afile"), "utf8")).toBe("not a folder");
});

test("a parent through a broken symlink is named as one, not reported as a raw ENOENT", async () => {
  await live();
  symlinkSync(join(base, "nowhere"), join(base, "dangling"));
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(base, "dangling", "out"),
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`${join(base, "dangling")} is a symlink to a missing target`);
  expect(result.stderr).not.toContain("ENOENT");
  expect(existsSync(join(base, "nowhere"))).toBe(false);
});

test("a parent that is a symlink through a file is named as one, not reported as a raw ENOTDIR", async () => {
  await live();
  writeFileSync(join(base, "afile"), "not a folder");
  symlinkSync(join(base, "afile", "below"), join(base, "viafile"));
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(base, "viafile", "out"),
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    `${join(base, "viafile")} is a symlink to a path below a file, not a folder`,
  );
  expect(result.stderr).not.toContain("ENOTDIR");
  expect(names(base)).toEqual(["afile", "data", "viafile"]);
});

test("a parent that is a symlink loop is named as one, not reported as a raw ELOOP", async () => {
  await live();
  symlinkSync("loop", join(base, "loop"));
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(base, "loop", "out"),
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`${join(base, "loop")} is a symlink loop`);
  expect(result.stderr).not.toContain("ELOOP");
  expect(names(base)).toEqual(["data", "loop"]);
});

test("a symlink planted in a folder the backup is about to create is refused, not followed", async () => {
  await live();
  const uploads = join(dataDir, "uploads");
  const before = names(uploads);
  // The hook runs after the checks and before the folders are made: the race the checks cannot see.
  const planted = () => {
    symlinkSync(uploads, join(base, "a"));
    return Number.MAX_SAFE_INTEGER;
  };
  expect(() =>
    createBackup({
      dataDir,
      output: join(base, "a", "b", "out"),
      clock: createRealClock(),
      supportedVersion: version,
      available: planted,
      warn() {},
    }),
  ).toThrow(`${join(base, "a")} changed meanwhile`);
  expect(names(uploads)).toEqual(before);
  expect(existsSync(join(uploads, "b"))).toBe(false);
  expect(names(base)).toEqual(["a", "data"]);
});

test("a symlink planted above the data directory is refused, and --force never replaces the live data", async () => {
  await live();
  const before = names(dataDir);
  const size = statSync(join(dataDir, "iglo-email.db")).size;
  // The hook plants `a` as an alias of the parent, so `a/data` would be the live data directory.
  const planted = () => {
    symlinkSync(base, join(base, "a"));
    return Number.MAX_SAFE_INTEGER;
  };
  expect(() =>
    createBackup({
      dataDir,
      output: join(base, "a", "data"),
      force: true,
      clock: createRealClock(),
      supportedVersion: version,
      available: planted,
      warn() {},
    }),
  ).toThrow(`${join(base, "a")} changed meanwhile`);
  expect(names(dataDir)).toEqual(before);
  expect(statSync(join(dataDir, "iglo-email.db")).size).toBe(size);
  expect(names(base)).toEqual(["a", "data"]);
});

test("an existing parent swapped for a symlink during the checks is refused, not followed", async () => {
  await live();
  const uploads = join(dataDir, "uploads");
  const before = names(uploads);
  mkdirSync(join(base, "x"));
  // `x` existed when it was checked. The hook runs after the checks and before the folders are made.
  const swapped = () => {
    renameSync(join(base, "x"), join(base, "x-moved"));
    symlinkSync(uploads, join(base, "x"));
    return Number.MAX_SAFE_INTEGER;
  };
  expect(() =>
    createBackup({
      dataDir,
      output: join(base, "x", "a", "out"),
      clock: createRealClock(),
      supportedVersion: version,
      available: swapped,
      warn() {},
    }),
  ).toThrow(`${join(base, "x", "a")} changed meanwhile: it no longer resolves to`);
  expect(names(uploads)).toEqual(before);
  expect(names(join(base, "x-moved"))).toEqual([]);
});

test("--force to a path whose existing parent is swapped for an alias of the base is refused, and the live data is intact", async () => {
  await live();
  const before = names(dataDir);
  const size = statSync(join(dataDir, "iglo-email.db")).size;
  mkdirSync(join(base, "x"));
  const swapped = () => {
    renameSync(join(base, "x"), join(base, "x-moved"));
    symlinkSync(base, join(base, "x"));
    return Number.MAX_SAFE_INTEGER;
  };
  expect(() =>
    createBackup({
      dataDir,
      output: join(base, "x", "data"),
      force: true,
      clock: createRealClock(),
      supportedVersion: version,
      available: swapped,
      warn() {},
    }),
  ).toThrow(`${join(base, "x")} changed meanwhile: it no longer resolves to`);
  expect(names(dataDir)).toEqual(before);
  expect(statSync(join(dataDir, "iglo-email.db")).size).toBe(size);
  expect(names(base)).toEqual(["data", "x", "x-moved"]);
  expect(names(join(base, "x-moved"))).toEqual([]);
});

test("--force refuses to move the live data directory aside, even when the output came to name it", async () => {
  await live();
  const before = names(dataDir);
  const size = statSync(join(dataDir, "iglo-email.db")).size;
  const output = join(base, "x", "data");
  mkdirSync(join(base, "x"));
  // After the checks, the live data directory is moved to the path the output names. The output is
  // then the live directory itself: it holds a database, so `replaceable` would accept it, and a
  // replacement without the identity check would move it aside and delete it.
  const moved = () => renameSync(dataDir, output);
  expect(() =>
    createBackup({
      dataDir,
      output,
      force: true,
      clock: createRealClock(),
      supportedVersion: version,
      beforePublish: moved,
      warn() {},
    }),
  ).toThrow(`${output} is the live data directory; not replacing it`);
  expect(names(output)).toEqual(before);
  expect(statSync(join(output, "iglo-email.db")).size).toBe(size);
  expect(names(base)).toEqual(["x"]);
  expect(names(join(base, "x"))).toEqual(["data"]);
});

test("a successful backup into new nested folders creates each one 0700", async () => {
  await live();
  const output = join(base, "n1", "n2", "n3", "out");
  const backup = await runBackup(executable, ["--data-dir", dataDir, "--output", output]);
  expect(backup.exitCode).toBe(0);
  expect(backup.stderr).toBe("");
  for (const folder of [
    join(base, "n1"),
    join(base, "n1", "n2"),
    join(base, "n1", "n2", "n3"),
    output,
  ])
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  expect(statSync(join(output, "iglo-email.db")).mode & 0o777).toBe(0o600);
  const verified = await runBackup(executable, ["--verify", output]);
  expect(verified.exitCode).toBe(0);
  expect(verified.stdout).toContain("Integrity: ok");
});

test("a failure after folders were created removes exactly those, and keeps what existed", async () => {
  const client = await live();
  await uploadFile(client, "unreadable.txt", "bytes");
  chmodSync(join(dataDir, "uploads", "unreadable.txt"), 0o000);
  const kept = join(base, "keep");
  mkdirSync(kept);
  writeFileSync(join(kept, "keep.txt"), "kept");
  const result = await runBackup(executable, [
    "--data-dir",
    dataDir,
    "--output",
    join(kept, "f2", "out"),
  ]);
  chmodSync(join(dataDir, "uploads", "unreadable.txt"), 0o644);
  expect(result.exitCode).toBe(1);
  expect(names(kept)).toEqual(["keep.txt"]);
  expect(readFileSync(join(kept, "keep.txt"), "utf8")).toBe("kept");
});

const PARTIAL_PREFIX = ".iglo-email-backup-partial-";
const REPLACED_PREFIX = ".iglo-email-backup-replaced-";
const entriesStarting = (directory: string, prefix: string) =>
  readdirSync(directory).filter((name) => name.startsWith(prefix));

/** The message of a refusal. The test fails if the call does not refuse. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the call did not refuse");
}

test("a parent renamed away after the partial exists is refused as changed meanwhile, and the partial is named", async () => {
  await live();
  const parent = join(base, "x", "a");
  mkdirSync(join(base, "x"), { recursive: true });
  const warnings: string[] = [];
  // The parent moves once the partial backup is made, so the partial is no longer where it was made.
  const message = refusal(() =>
    createBackup({
      dataDir,
      output: join(parent, "out"),
      clock: createRealClock(),
      supportedVersion: version,
      beforePublish: () => renameSync(join(base, "x"), join(base, "x-moved")),
      warn: (message) => warnings.push(message),
    }),
  );
  expect(message).toContain("changed meanwhile");
  expect(message).not.toContain("ENOENT");
  const [partial] = entriesStarting(join(base, "x-moved", "a"), PARTIAL_PREFIX);
  expect(partial).toBeDefined();
  expect(existsSync(join(base, "x-moved", "a", partial!, "iglo-email.db"))).toBe(true);
  expect(warnings.join("\n")).toContain(join(parent, partial!));
  expect(names(base)).toEqual(["data", "x-moved"]);
});

test("two backups into one parent that the first one made both succeed", async () => {
  await live();
  const shared = join(base, "shared");
  const secondWarnings: string[] = [];
  const firstWarnings: string[] = [];
  let nested = false;
  // The first backup's clock is read once its partial is in the new parent. The second backup then
  // finds that parent with the first one's partial in it, and writes its own backup beside it.
  const clock = {
    ...createRealClock(),
    now() {
      if (!nested) {
        nested = true;
        createBackup({
          dataDir,
          output: join(shared, "b"),
          clock: createRealClock(),
          supportedVersion: version,
          warn: (message) => secondWarnings.push(message),
        });
      }
      return new Date();
    },
  };
  const first = createBackup({
    dataDir,
    output: join(shared, "a"),
    clock,
    supportedVersion: version,
    warn: (message) => firstWarnings.push(message),
  });
  expect(first.path).toBe(join(shared, "a"));
  expect(names(shared)).toEqual(["a", "b"]);
  expect((await runBackup(executable, ["--verify", join(shared, "a")])).exitCode).toBe(0);
  expect((await runBackup(executable, ["--verify", join(shared, "b")])).exitCode).toBe(0);
  expect(firstWarnings.join("\n")).not.toContain("could not be removed");
  expect(secondWarnings.join("\n")).not.toContain("could not be removed");
});

test("a parent that another backup creates after this one checked it is used, and both succeed", async () => {
  await live();
  const shared = join(base, "shared");
  const warnings: string[] = [];
  // The other backup runs inside this one's free-space check, so the parent appears after the check
  // that found it missing, and before this backup makes its folders.
  const otherBackup = () => {
    createBackup({
      dataDir,
      output: join(shared, "b"),
      clock: createRealClock(),
      supportedVersion: version,
      warn() {},
    });
    return Number.MAX_SAFE_INTEGER;
  };
  const first = createBackup({
    dataDir,
    output: join(shared, "a"),
    clock: createRealClock(),
    supportedVersion: version,
    available: otherBackup,
    warn: (message) => warnings.push(message),
  });
  expect(first.path).toBe(join(shared, "a"));
  expect(names(shared)).toEqual(["a", "b"]);
  expect(warnings).toEqual([]);
});

test("a folder another process starts using is kept, and no warning is given", async () => {
  await live();
  const parent = join(base, "new");
  const warnings: string[] = [];
  const message = refusal(() =>
    createBackup({
      dataDir,
      output: join(parent, "out"),
      clock: createRealClock(),
      supportedVersion: version,
      beforePublish() {
        writeFileSync(join(parent, "theirs.txt"), "theirs");
        throw new Error("stopped before publication");
      },
      warn: (message) => warnings.push(message),
    }),
  );
  expect(message).toBe("stopped before publication");
  expect(warnings).toEqual([]);
  expect(names(parent)).toEqual(["theirs.txt"]);
});

test("a forced backup whose replaced copy cannot be removed is published, warned about, and not cleaned up", async () => {
  await live();
  const output = join(base, "backup");
  const args = ["--data-dir", dataDir, "--output", output];
  expect((await runBackup(executable, args)).exitCode).toBe(0);
  // A file in the old backup's upload folder, which the folder's read-only mode keeps from being removed.
  writeFileSync(join(output, "uploads", "held.txt"), "held");
  const restore = () => {
    for (const name of entriesStarting(base, REPLACED_PREFIX))
      chmodSync(join(base, name, "uploads"), 0o700);
  };
  const warnings: string[] = [];
  try {
    const result = createBackup({
      dataDir,
      output,
      force: true,
      clock: createRealClock(),
      supportedVersion: version,
      beforePublish: () => chmodSync(join(output, "uploads"), 0o500),
      warn: (message) => warnings.push(message),
    });
    expect(result.path).toBe(output);
    const [replaced] = entriesStarting(base, REPLACED_PREFIX);
    expect(replaced).toBeDefined();
    expect(warnings).toEqual([expect.stringContaining(join(base, replaced!))]);
    expect(warnings.join("\n")).not.toContain("kept");
    expect((await runBackup(executable, ["--verify", output])).exitCode).toBe(0);
  } finally {
    restore();
  }
});

test("a folder that took the name of one this backup made is left alone", async () => {
  await live();
  const made = join(base, "n");
  const warnings: string[] = [];
  // The folder this backup made is moved away with its partial, and an empty folder takes its name.
  const message = refusal(() =>
    createBackup({
      dataDir,
      output: join(made, "out"),
      clock: createRealClock(),
      supportedVersion: version,
      beforePublish() {
        renameSync(made, join(base, "n-moved"));
        mkdirSync(made);
      },
      warn: (message) => warnings.push(message),
    }),
  );
  expect(message).toContain("changed meanwhile");
  expect(message).not.toContain("ENOENT");
  expect(names(base)).toEqual(["data", "n", "n-moved"]);
  expect(names(made)).toEqual([]);
  const [partial] = entriesStarting(join(base, "n-moved"), PARTIAL_PREFIX);
  expect(warnings.join("\n")).toContain(join(made, partial!));
});

test("a failed sync of the folder after publication is an error, names the replaced backup, and keeps it", async () => {
  await live();
  const output = join(base, "backup");
  expect((await runBackup(executable, ["--data-dir", dataDir, "--output", output])).exitCode).toBe(
    0,
  );
  const warnings: string[] = [];
  let message = "";
  try {
    // Without read permission the folder cannot be opened for its sync, but the rename still works.
    message = refusal(() =>
      createBackup({
        dataDir,
        output,
        force: true,
        clock: createRealClock(),
        supportedVersion: version,
        beforePublish: () => chmodSync(base, 0o300),
        warn: (message) => warnings.push(message),
      }),
    );
  } finally {
    chmodSync(base, 0o700);
  }
  const [replaced] = entriesStarting(base, REPLACED_PREFIX);
  expect(replaced).toBeDefined();
  expect(message).toContain(`${output} is in place`);
  expect(message).toContain("may not survive a crash");
  expect(message).toContain(join(base, replaced!));
  expect(warnings).toEqual([]);
  expect((await runBackup(executable, ["--verify", output])).exitCode).toBe(0);
  expect((await runBackup(executable, ["--verify", join(base, replaced!)])).exitCode).toBe(0);
});

test("a parent renamed away during the copy is refused as changed meanwhile, and the partial is named", async () => {
  await live();
  mkdirSync(join(base, "x"));
  const warnings: string[] = [];
  // The clock is read once the partial's database file is in place, before the database is copied.
  const clock = {
    ...createRealClock(),
    now() {
      if (existsSync(join(base, "x"))) renameSync(join(base, "x"), join(base, "x-moved"));
      return new Date();
    },
  };
  const message = refusal(() =>
    createBackup({
      dataDir,
      output: join(base, "x", "a", "out"),
      clock,
      supportedVersion: version,
      warn: (message) => warnings.push(message),
    }),
  );
  expect(message).toContain("changed meanwhile");
  const [partial] = entriesStarting(join(base, "x-moved", "a"), PARTIAL_PREFIX);
  expect(partial).toBeDefined();
  expect(warnings.join("\n")).toContain(join(base, "x", "a", partial!));
});

test("an error while the partial is inspected keeps the original failure, and is not named as a change", async () => {
  await live();
  mkdirSync(join(base, "x"));
  const warnings: string[] = [];
  // Once the partial is in place, its parent loses search permission: the copy fails, and so does
  // the look at the partial that follows it.
  const clock = {
    ...createRealClock(),
    now() {
      chmodSync(join(base, "x"), 0o000);
      return new Date();
    },
  };
  let message = "";
  try {
    // Two folders are made (x/a and x/a/b), so cleanup has a second folder after the first fails.
    message = refusal(() =>
      createBackup({
        dataDir,
        output: join(base, "x", "a", "b", "out"),
        clock,
        supportedVersion: version,
        warn: (message) => warnings.push(message),
      }),
    );
  } finally {
    chmodSync(join(base, "x"), 0o700);
  }
  expect(message).not.toContain("changed meanwhile");
  expect(message).toContain("unable to open database");
  // Both made folders are named: removal continues past the first one that cannot be inspected.
  expect(warnings.join("\n")).toContain(
    `${join(base, "x", "a", "b")} was made by this backup and could not be removed: EACCES`,
  );
  expect(warnings.join("\n")).toContain(
    `${join(base, "x", "a")} was made by this backup and could not be removed: EACCES`,
  );
});
