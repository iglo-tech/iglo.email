// A compiled executable and its processes, for tests and the measurement of `backup`.
import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";
import { ensureProductionBuild } from "@/test/production-build";
import { portZeroRootUrl, readyOnPortZero, startStderr } from "@/test/serve-port";
import { asBody } from "@/test/read-body";

const repository = resolve(import.meta.dir, "../..");
// Generated for these tests; see test/backup/fixtures.md.
export const admin = { user: "backup-test-admin", password: "backup-test-password" };

export async function buildExecutable(directory: string): Promise<string> {
  await ensureProductionBuild();
  const executable = join(directory, "iglo.email");
  copyFileSync(join(repository, "dist/iglo.email"), executable);
  return executable;
}

/** The `backup` command with an action at publication; see test/backup/publish-entry.ts. */
export async function buildPublishEntry(directory: string): Promise<string> {
  const entry = join(directory, "publish-entry");
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", "test/backup/publish-entry.ts", "--outfile", entry],
    { cwd: repository, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  if ((await build.exited) !== 0) {
    throw new Error(await new Response(build.stderr).text());
  }
  return entry;
}

export function temporaryDirectory(base = tmpdir()): string {
  return mkdtempSync(join(base, "iglo-backup-"));
}

export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** One `backup` run: exit code and both streams. A run past `timeout` ms is killed (SIGKILL). */
export async function runBackup(executable: string, args: Array<string>, timeout?: number) {
  const child = Bun.spawn([executable, "backup", ...args], {
    env: { PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
    ...(timeout === undefined ? {} : { timeout, killSignal: "SIGKILL" as const }),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export type Server = Awaited<ReturnType<typeof startServer>>;

/** The server on a data directory, answering /health, or an error with its stderr. */
export async function startServer(executable: string, dataDir: string) {
  // Port 0 (D144): the server names the port the OS gave it. A start that fails is killed and
  // reaped before its error, with its stderr, is thrown.
  const child = Bun.spawn(
    [
      executable,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--root-url",
      portZeroRootUrl,
      "--data-dir",
      dataDir,
    ],
    {
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // A start that exits fails with its stderr alone, as written: callers compare it with the
  // server's own refusal, such as the data-directory lock's.
  const { port } = await readyOnPortZero(child, 30_000).catch((error: unknown) => {
    const stderr = startStderr(error);
    throw stderr !== undefined && child.exitCode !== null
      ? new Error(stderr, { cause: error })
      : error;
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    health: `${origin}/health`,
    async stop() {
      child.kill("SIGTERM");
      return child.exited;
    },
    /** As a crash: nothing of the shutdown runs. */
    async kill() {
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}

/** An API credential of a server's first start; a restored database keeps it. */
export async function provisionAuthorization(origin: string): Promise<string> {
  const credentials = await provisionApiUser(origin, admin);
  return `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
}

export function apiClient(origin: string, authorization: string) {
  return (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: { authorization, ...asBody<Record<string, string>>(init.headers) },
    });
}
export type Client = ReturnType<typeof apiClient>;

export const createSubscriber = (client: Client, n: number | string) =>
  client("/api/subscribers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `backup-${n}@example.test`,
      name: `Backup ${n}`,
      status: "enabled",
    }),
  });

export function uploadFile(client: Client, name: string, content: string) {
  const body = new FormData();
  body.append("file", new File([content], name, { type: "text/plain" }));
  return client("/api/media", { method: "POST", body });
}

/** The operations guide's restore: a stopped server's directory set aside, the backup in place. */
export function restoreInto(backup: string, dataDir: string): void {
  // B138b layout: the primary project is restored as its directory. B144a (D158): a whole backup
  // holds it at projects/main/, and a `--project main` backup is that directory itself.
  const project = join(dataDir, "projects", "main");
  const whole = join(backup, "projects", "main");
  renameSync(project, `${dataDir}.before-restore`);
  cpSync(existsSync(whole) ? whole : backup, project, {
    recursive: true,
    preserveTimestamps: true,
  });
}

/** Generated subscribers, written while no server runs. */
export function seedSubscribers(dataDir: string, count: number): void {
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"));
  db.run("PRAGMA synchronous = OFF");
  const insert = db.prepare(
    "INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at) VALUES (?, ?, ?, 'enabled', '{}', ?, ?)",
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(crypto.randomUUID(), `seed-${i}@example.test`, `Seed ${i}`, now, now);
    }
  })();
  // A statement still alive keeps the connection open past close(), until the garbage collector
  // runs: the WAL stays on disk and is folded in at some later, unpredictable moment (B137).
  insert.finalize();
  db.close();
}
