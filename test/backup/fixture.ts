// A compiled executable and its processes, for tests and the measurement of `backup`.
import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
// Generated for these tests; see test/backup/fixtures.md.
export const admin = { user: "backup-test-admin", password: "backup-test-password" };

export async function buildExecutable(directory: string): Promise<string> {
  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: repository,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
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
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  return entry;
}

export function temporaryDirectory(base = tmpdir()): string {
  return mkdtempSync(join(base, "iglo-backup-"));
}

export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** One `backup` run: exit code and both streams. */
export async function runBackup(executable: string, args: string[]) {
  const child = Bun.spawn([executable, "backup", ...args], {
    env: { PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
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
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  const child = Bun.spawn(
    [executable, "serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
    {
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const origin = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 30_000; ; await Bun.sleep(25)) {
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
    const up = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) }).catch(
      () => null,
    );
    if (up?.ok) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("The server did not start");
    }
  }
  return {
    origin,
    health: `${origin}/health`,
    async stop() {
      child.kill("SIGTERM");
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
      headers: { authorization, ...(init.headers as Record<string, string>) },
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
  renameSync(dataDir, `${dataDir}.before-restore`);
  cpSync(backup, dataDir, { recursive: true, preserveTimestamps: true });
}

/** Generated subscribers, written while no server runs. */
export function seedSubscribers(dataDir: string, count: number): void {
  const db = new Database(join(dataDir, "iglo-email.db"));
  db.run("PRAGMA synchronous = OFF");
  const insert = db.prepare(
    "INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at) VALUES (?, ?, ?, 'enabled', '{}', ?, ?)",
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < count; i++)
      insert.run(crypto.randomUUID(), `seed-${i}@example.test`, `Seed ${i}`, now, now);
  })();
  db.close();
}
