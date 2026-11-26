// B144a (14-projects sections 12 and 15 "CLI", D158): `backup` of instance.db and every project,
// `backup --project <slug>`, and the restore hold per database, on the compiled executable with
// three projects: the primary on the instance host (127.0.0.1), `a` and `b` on their own hostnames.
// Every request names its project by an explicit Host header.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MANIFEST_LIMIT } from "@/backup/snapshot";
import { runBackup } from "@/test/backup/fixture";
import {
  adminCredentials,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  sessionHeaders,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";

setDefaultTimeout(60_000);

const PRIMARY = "127.0.0.1";
const A = "a.example.test";
const B = "b.example.test";
const HOSTS = [PRIMARY, A, B];

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let admin: Credentials;
let server: Awaited<ReturnType<typeof startInstance>> | undefined;
let base = "";
let dataDir = "";

const whole = () => join(base, "whole");
const onlyA = () => join(base, "only-a");
const names = (directory: string) => readdirSync(directory).sort();
const backup = (...args: Array<string>) =>
  runBackup(prepared.executable, ["--data-dir", dataDir, ...args]);
const release = (...args: Array<string>) =>
  backup("--release-hold", "--consent-reconciled", ...args);

async function start() {
  server = await startInstance(prepared.executable, dataDir, admin);
  return server.port;
}

async function stop() {
  const running = server;
  server = undefined;
  if (running) {
    const { code, stderr } = await running.stop();
    expect(code, stderr).toBe(0);
  }
}

/**
 * Whether each host's sending is held, as an operator sees it: the hold header on `/health` and a
 * resend refused with 503 before its ID is looked at. Both must agree.
 */
async function heldHosts(port: number): Promise<Array<string>> {
  const held: Array<string> = [];
  for (const host of HOSTS) {
    const health = await request(port, host, "/health");
    expect(health.status).toBe(200);
    const session = await logIn(port, host, admin);
    const resend = await request(port, host, "/api/sends/1/resend", {
      method: "POST",
      headers: sessionHeaders(session),
      body: "{}",
    });
    const header = health.headers.get("x-iglo-email-hold") !== null;
    expect(resend.status === 503, `${host}: resend ${resend.status}, header ${header}`).toBe(
      header,
    );
    if (header) {
      held.push(host);
    }
  }
  return held;
}

beforeAll(async () => {
  prepared = await prepareExecutable();
  admin = await adminCredentials();
  base = join(prepared.directory, "work");
  dataDir = join(base, "data");
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true },
    { slug: "a", name: "A", hostname: A },
    { slug: "b", name: "B", hostname: B },
  ]);
  const port = await start();
  expect(await heldHosts(port)).toEqual([]);
});

afterAll(async () => {
  await server?.stop();
  await prepared?.cleanup();
});

test("backup without --project holds instance.db and every project, checked as one", async () => {
  const result = await backup("--output", whole());
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(names(whole())).toEqual(["iglo-email-backup.json", "instance.db", "projects"]);
  expect(names(join(whole(), "projects"))).toEqual(["a", "b", "main"]);
  for (const slug of ["a", "b", "main"]) {
    expect(existsSync(join(whole(), "projects", slug, "iglo-email.db"))).toBe(true);
  }

  const verified = await runBackup(prepared.executable, ["--verify", whole()]);
  expect(verified.exitCode, verified.stderr).toBe(0);
  const headings = verified.stdout.split("\n").filter((line) => line && !line.startsWith(" "));
  expect(headings).toEqual([
    "instance.db",
    "projects/a",
    "projects/b",
    "projects/main",
    "Integrity: ok",
  ]);
  expect(verified.stdout.match(/Hold: held since /g)).toHaveLength(4);
  expect(verified.stdout).toContain("sends nothing in any project until released");
});

test("backup --project holds that project only, shaped like its directory", async () => {
  const result = await backup("--project", "a", "--output", onlyA());
  expect(result.exitCode, result.stderr).toBe(0);
  expect(names(onlyA())).toContain("iglo-email.db");
  expect(names(onlyA())).not.toContain("instance.db");
  expect(names(onlyA())).not.toContain("projects");

  const verified = await runBackup(prepared.executable, ["--verify", onlyA()]);
  expect(verified.exitCode, verified.stderr).toBe(0);
  expect(verified.stdout).not.toContain("instance.db");
  expect(verified.stdout.match(/Hold: held since /g)).toHaveLength(1);
  expect(verified.stdout).toContain("Integrity: ok");
});

test("--verify refuses a manifest that names something other than a project slug", async () => {
  // A hand-made whole backup: its instance.db claims a schema ahead of this executable, so the
  // registry is not compared, and its manifest names a path to a project backup outside it.
  const crafted = join(base, "crafted");
  cpSync(whole(), crafted, { recursive: true });
  const db = new Database(join(crafted, "instance.db"));
  db.run("PRAGMA user_version = 99");
  db.close();
  const outside = "../../only-a";
  expect(existsSync(join(crafted, "projects", outside, "iglo-email.db"))).toBe(true);
  writeFileSync(join(crafted, "iglo-email-backup.json"), JSON.stringify({ projects: [outside] }));

  const verified = await runBackup(prepared.executable, ["--verify", crafted]);
  expect(verified.exitCode).toBe(1);
  expect(verified.stderr).toContain(`names "${outside}", which is not a project slug`);
  expect(verified.stdout).toBe("");
});

/** A manifest's JSON padded past the limit with spaces: it would parse, and only the bound refuses it. */
function padded(manifest: { projects: Array<string> } | { uploads: string }): string {
  return `${JSON.stringify(manifest)}${" ".repeat(MANIFEST_LIMIT)}\n`;
}

test("--verify refuses a manifest over its size limit before parsing it", async () => {
  // D178.
  const crafted = join(base, "large-whole");
  cpSync(whole(), crafted, { recursive: true });
  writeFileSync(join(crafted, "iglo-email-backup.json"), padded({ projects: ["a", "b", "main"] }));
  const refused = await runBackup(prepared.executable, ["--verify", crafted]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain(
    `iglo-email-backup.json is larger than the ${MANIFEST_LIMIT} bytes a backup's manifest may have`,
  );
  expect(refused.stdout).toBe("");

  const project = join(base, "large-project");
  cpSync(onlyA(), project, { recursive: true });
  writeFileSync(join(project, "iglo-email-backup.json"), padded({ uploads: "uploads" }));
  const projectRefused = await runBackup(prepared.executable, ["--verify", project]);
  expect(projectRefused.exitCode).toBe(1);
  expect(projectRefused.stderr).toContain("is larger than the");
  expect(projectRefused.stdout).toBe("");
});

test("--verify refuses a symlink anywhere in a backup", async () => {
  // Each crafted backup would otherwise pass: the symlinks lead to real databases and manifests.
  const cases: Array<[string, (crafted: string) => void, string]> = [
    [
      "a project directory",
      (crafted) => {
        rmSync(join(crafted, "projects", "b"), { recursive: true });
        symlinkSync(onlyA(), join(crafted, "projects", "b"));
      },
      "projects/b is a symlink",
    ],
    [
      "a project's database",
      (crafted) => {
        rmSync(join(crafted, "projects", "b", "iglo-email.db"));
        symlinkSync(
          join(onlyA(), "iglo-email.db"),
          join(crafted, "projects", "b", "iglo-email.db"),
        );
      },
      "projects/b/iglo-email.db is a symlink",
    ],
    [
      "the manifest",
      (crafted) => {
        renameSync(
          join(crafted, "iglo-email-backup.json"),
          join(crafted, "projects", "manifest.json"),
        );
        symlinkSync(
          join(crafted, "projects", "manifest.json"),
          join(crafted, "iglo-email-backup.json"),
        );
      },
      "iglo-email-backup.json is a symlink",
    ],
  ];
  for (const [what, craft, message] of cases) {
    const crafted = join(base, `symlink-${what.replaceAll(/\W/g, "-")}`);
    cpSync(whole(), crafted, { recursive: true });
    craft(crafted);
    const verified = await runBackup(prepared.executable, ["--verify", crafted]);
    expect(verified.exitCode, what).toBe(1);
    expect(verified.stderr, what).toContain(message);
    expect(verified.stdout, what).toBe("");
  }

  // A project's backup with its database a symlink to another project's.
  const project = join(base, "symlink-project");
  cpSync(onlyA(), project, { recursive: true });
  rmSync(join(project, "iglo-email.db"));
  symlinkSync(join(whole(), "projects", "b", "iglo-email.db"), join(project, "iglo-email.db"));
  const verified = await runBackup(prepared.executable, ["--verify", project]);
  expect(verified.exitCode).toBe(1);
  expect(verified.stderr).toContain("iglo-email.db is a symlink");

  // A relative upload path leading out of the backup is refused before it is listed.
  const escaping = join(base, "escaping-uploads");
  cpSync(onlyA(), escaping, { recursive: true });
  const db = new Database(join(escaping, "iglo-email.db"));
  db.run("UPDATE settings SET value = ? WHERE key = 'upload.filesystem.upload_path'", [
    JSON.stringify("../whole/projects/b/uploads"),
  ]);
  expect(db.query("SELECT changes() AS n").get()).toEqual({ n: 1 });
  db.close();
  const escaped = await runBackup(prepared.executable, ["--verify", escaping]);
  expect(escaped.exitCode).toBe(1);
  expect(escaped.stderr).toContain("names an upload directory outside it");

  // The path given may itself be a symlink to a backup: the operator chose it.
  const link = join(base, "link-to-whole");
  symlinkSync(whole(), link);
  const followed = await runBackup(prepared.executable, ["--verify", link]);
  expect(followed.exitCode, followed.stderr).toBe(0);
  expect(followed.stdout).toContain("Integrity: ok");
});

/** A FIFO at `path`: opening it to read would wait for a writer that never comes. */
function makeFifo(path: string): void {
  const made = Bun.spawnSync(["mkfifo", path]);
  expect(made.exitCode, made.stderr.toString()).toBe(0);
}

test("--verify refuses a FIFO in a backup at once instead of waiting on it", async () => {
  // D178. Without the checks SQLite's open of a FIFO database waits forever; a run past 10 s is
  // killed and fails the test with a signal instead of exit code 1. The WAL and the upload are
  // refused by the walk of the backup, before anything is opened.
  const cases: Array<[string, (crafted: string) => string]> = [
    [
      "a project's database",
      (crafted) => {
        const path = join(crafted, "projects", "b", "iglo-email.db");
        rmSync(path);
        makeFifo(path);
        return "projects/b/iglo-email.db is not a regular file";
      },
    ],
    [
      "a WAL beside a database",
      (crafted) => {
        makeFifo(join(crafted, "projects", "b", "iglo-email.db-wal"));
        return "projects/b/iglo-email.db-wal is not a regular file";
      },
    ],
    [
      "an upload",
      (crafted) => {
        makeFifo(join(crafted, "projects", "b", "uploads", "fifo.png"));
        return "projects/b/uploads/fifo.png is not a regular file";
      },
    ],
  ];
  for (const [what, craft] of cases) {
    const crafted = join(base, `fifo-${what.replaceAll(/\W/g, "-")}`);
    cpSync(whole(), crafted, { recursive: true });
    const message = craft(crafted);
    const verified = await runBackup(prepared.executable, ["--verify", crafted], 10_000);
    expect(verified.exitCode, `${what}: ${verified.stderr}`).toBe(1);
    expect(verified.stderr, what).toContain(message);
    expect(verified.stdout, what).toBe("");
  }

  // A FIFO given as a bare snapshot.
  const bare = join(base, "fifo-bare.db");
  makeFifo(bare);
  const verified = await runBackup(prepared.executable, ["--verify", bare], 10_000);
  expect(verified.exitCode, verified.stderr).toBe(1);
  expect(verified.stderr).toContain("fifo-bare.db is not a regular file");
});

test("an unknown project slug fails and writes nothing", async () => {
  const before = names(base);
  const output = join(base, "unknown");
  const result = await backup("--project", "nope", "--output", output);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("No project nope");
  expect(result.stdout).toBe("");
  expect(existsSync(output)).toBe(false);
  expect(names(base)).toEqual(before);
});

test("--output inside the projects directory is refused with a plain message", async () => {
  const projects = join(dataDir, "projects");
  const inA = names(join(projects, "a"));
  for (const output of [join(projects, "x"), join(projects, "a", "backup")]) {
    const result = await backup("--output", output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`is inside ${projects}, where the projects are read from`);
    expect(existsSync(output)).toBe(false);
  }
  // The projects directory itself, with --force too: once refused as the data directory (D166).
  for (const args of [[projects], [`${projects}/`], [projects, "--force"]]) {
    const result = await backup("--output", ...args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`is inside ${projects}, where the projects are read from`);
    expect(result.stdout).toBe("");
  }
  expect(names(projects)).toEqual(["a", "b", "main"]);
  expect(names(join(projects, "a"))).toEqual(inA);
});

test("a restored project database holds only that project, and only its release ends it", async () => {
  await stop();
  const project = join(dataDir, "projects", "a");
  renameSync(project, join(base, "a.before-restore"));
  cpSync(onlyA(), project, { recursive: true });

  expect(await heldHosts(await start())).toEqual([A]);
  await stop();

  // Exit 3 whenever a database stays held, so a script sees that sending has not started (D166).
  const other = await release("--project", "b");
  expect(other.exitCode, other.stderr).toBe(3);
  expect(other.stdout).toContain("No hold on project b");
  expect(other.stdout).toContain("Still held: project a");
  const instance = await release();
  expect(instance.exitCode, instance.stderr).toBe(3);
  expect(instance.stdout).toContain("No hold on instance.db");
  expect(instance.stdout).toContain("Still held: project a");
  expect(await heldHosts(await start())).toEqual([A]);
  await stop();

  const released = await release("--project", "a");
  expect(released.exitCode, released.stderr).toBe(0);
  expect(released.stdout).toMatch(/^Hold released on project a at \S+\n/);
  expect(released.stdout).toContain("Nothing is held; sending starts with the server");
  expect(await heldHosts(await start())).toEqual([]);
});

test("a restored instance.db holds every project until its own release", async () => {
  await stop();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(join(dataDir, `instance.db${suffix}`), { force: true });
  }
  cpSync(join(whole(), "instance.db"), join(dataDir, "instance.db"));

  expect(await heldHosts(await start())).toEqual(HOSTS);
  await stop();

  const project = await release("--project", "a");
  expect(project.exitCode, project.stderr).toBe(3);
  expect(project.stdout).toContain("No hold on project a");
  expect(project.stdout).toContain("instance.db is still held, which holds every project");
  expect(await heldHosts(await start())).toEqual(HOSTS);
  await stop();

  const released = await release();
  expect(released.exitCode, released.stderr).toBe(0);
  expect(released.stdout).toMatch(/^Hold released on instance.db at \S+\n/);
  expect(released.stdout).toContain("Nothing is held; sending starts with the server");
  expect(await heldHosts(await start())).toEqual([]);
});
