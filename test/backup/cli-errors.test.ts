// B159b (D183): what the compiled `backup` command prints when it fails. A whole backup that meets a
// registry change reports the change and, on a line of its own, the failure of the step that met
// it; `--verify /dev/stdin` on a pipe says there is no backup instead of a raw `stat` error.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  adminCredentials,
  prepareExecutable,
  registerProjects,
  startInstance,
} from "@/test/projects/fixture";

setDefaultTimeout(60_000);

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;

beforeAll(async () => {
  prepared = await prepareExecutable();
});

afterAll(async () => {
  await prepared?.cleanup();
});

/** The compiled command with its exit code and both streams; killed past 30 s. */
function spawnBackup(args: Array<string>, stdin: "pipe" | "ignore" = "ignore") {
  const child = Bun.spawn([prepared.executable, "backup", ...args], {
    env: { PATH: "" },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
  return { child, result };
}

/** Waits until process `pid` has `path` open. */
async function opened(pid: number, path: string, limitMs: number): Promise<void> {
  // `/proc/<pid>/fd` links name the resolved file, so a symlink anywhere in `path` (`TMPDIR`
  // included) is resolved before comparing.
  const target = realpathSync(path);
  const start = Date.now();
  for (;;) {
    let links: Array<string> = [];
    try {
      links = readdirSync(`/proc/${pid}/fd`).map((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          return "";
        }
      });
    } catch {
      // The process has exited; the check below fails the wait.
    }
    if (links.includes(target)) {
      return;
    }
    if (Date.now() - start > limitMs) {
      throw new Error(`process ${pid} did not open ${path} within ${limitMs} ms`);
    }
    await Bun.sleep(10);
  }
}

test("a whole backup failing as the registry changes prints the step's own error as its cause", async () => {
  const dataDir = join(prepared.directory, "data");
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: "127.0.0.1", primary: true },
    { slug: "b", name: "B", hostname: "b.example.test" },
  ]);
  const server = await startInstance(prepared.executable, dataDir, await adminCredentials());
  const stopped = await server.stop();
  expect(stopped.code, stopped.stderr).toBe(0);

  // Project b's database is held by an exclusive lock, so `backup`, which opens it only after it
  // has read the registered projects, waits on it for its busy timeout and then fails that step.
  // Once `backup` has the file open the registry has been read: a project registered then is a
  // registry change. (In rollback-journal mode an exclusive lock keeps readers out; in WAL mode
  // it would not.)
  const database = join(dataDir, "projects", "b", "iglo-email.db");
  const holder = new Database(database);
  try {
    holder.run("PRAGMA journal_mode = DELETE");
    holder.run("BEGIN EXCLUSIVE");
    holder.run("PRAGMA user_version = user_version");
    const { child, result } = spawnBackup([
      "--data-dir",
      dataDir,
      "--output",
      join(prepared.directory, "whole"),
    ]);
    await opened(child.pid, database, 20_000);
    registerProjects(dataDir, [{ slug: "c", name: "C", hostname: "c.example.test" }]);
    const { exitCode, stdout, stderr } = await result;
    expect(exitCode, stderr).toBe(1);
    // The registry change, then the step's own error, which it would otherwise hide until the rerun.
    expect(stderr.trimEnd().split("\n")).toEqual([
      "The registered projects changed while the backup ran; run it again",
      "Cause: database is locked",
    ]);
    expect(stdout).toBe("");
  } finally {
    holder.close();
  }
});

test("--verify /dev/stdin on a pipe says there is no backup there", async () => {
  // `/dev/stdin` resolves to `pipe:[…]`, which names nothing on disk.
  const { result } = spawnBackup(["--verify", "/dev/stdin"], "pipe");
  const { exitCode, stdout, stderr } = await result;
  expect(exitCode, stderr).toBe(1);
  expect(stderr).toBe("No backup at /dev/stdin\n");
  expect(stdout).toBe("");
});
