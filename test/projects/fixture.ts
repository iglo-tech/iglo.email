// B138b: an instance with projects registered through src/projects before the compiled executable
// starts on port 0. Every request names its project by an explicit Host header to 127.0.0.1, so no
// test depends on DNS or `*.localhost` resolution (14-projects section 15).
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { openInstanceDatabase } from "@/projects/instance";
import { createRegistry } from "@/projects/registry";
import type { NewProject } from "@/projects/registry";
import { ensureProductionBuild } from "@/test/production-build";
import { readJson } from "@/test/read-body";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";

const repository = resolve(import.meta.dir, "../..");

export interface Credentials {
  readonly user: string;
  readonly password: string;
}

/** The bootstrap test admin (test/bootstrap/fixtures.md); seeded into every project (D151). */
export async function adminCredentials(): Promise<Credentials> {
  const fixture = await Bun.file(join(repository, "test/bootstrap/fixtures.md")).text();
  const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1] ?? "";
  const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1] ?? "";
  if (!user || !password) {
    throw new Error("Bootstrap test credentials are missing");
  }
  return { user, password };
}

/** A private copy of the production executable in a temporary directory. */
export async function prepareExecutable() {
  await ensureProductionBuild();
  const directory = await mkdtemp(join(tmpdir(), "iglo-email-projects-"));
  const executable = join(directory, "iglo.email");
  await copyFile(join(repository, "dist", "iglo.email"), executable);
  await chmod(executable, 0o755);
  return {
    directory,
    executable,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Registers projects in a data directory's instance.db, as a fixture does before a start. */
export function registerProjects(dataDir: string, projects: ReadonlyArray<NewProject>): void {
  const clock = createRealClock();
  const db = openInstanceDatabase(dataDir, clock);
  try {
    const registry = createRegistry(db, clock);
    try {
      for (const project of projects) {
        registry.add(project);
      }
    } finally {
      registry.close();
    }
  } finally {
    db.close();
  }
}

/** The executable on port 0 (D144) with the test admin, and an API user for the primary only. */
export function spawnInstance(
  executable: string,
  dataDir: string,
  admin: Credentials,
  extra: Record<string, string> = {},
) {
  return Bun.spawn(
    [executable, "--port", "0", "--root-url", portZeroRootUrl, "--data-dir", dataDir],
    {
      cwd: dirname(executable),
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

export async function startInstance(
  executable: string,
  dataDir: string,
  admin: Credentials,
  extra: Record<string, string> = {},
) {
  const child = spawnInstance(executable, dataDir, admin, extra);
  const { port } = await readyOnPortZero(child);
  let stopped: Promise<{ code: number; stderr: string }> | undefined;
  return {
    child,
    port,
    /** Stops the process once and returns its exit code and its whole stderr. */
    stop() {
      stopped ??= (async () => {
        const code = await stopChild(child, "SIGTERM", 5000);
        return { code, stderr: await new Response(child.stderr).text() };
      })();
      return stopped;
    },
  };
}

/** A request to the instance on 127.0.0.1 that names `host` in its Host header. */
export function request(port: number, host: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", ...init, headers });
}

export interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

/** Logs in on `host` through the admin login form; returns the session and CSRF cookies. */
export async function logIn(
  port: number,
  host: string,
  credentials: Credentials,
): Promise<Session> {
  const page = await request(port, host, "/admin/login");
  const nonceCookie = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const response = await request(port, host, "/admin/login", {
    method: "POST",
    headers: { cookie: nonceCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      nonce,
      username: credentials.user,
      password: credentials.password,
      next: "/admin",
    }).toString(),
  });
  if (response.status !== 302) {
    throw new Error(`Login on ${host} answered ${response.status}`);
  }
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0] ?? "");
  const csrf = cookies.find((value) => value.startsWith("csrf="))?.slice("csrf=".length) ?? "";
  return { cookie: cookies.filter((value) => value.includes("=")).join("; "), csrf };
}

/** Session headers for an API call: the cookies, the CSRF token and a JSON body type. */
export function sessionHeaders(session: Session): Record<string, string> {
  return {
    cookie: session.cookie,
    "x-csrf-token": session.csrf,
    "content-type": "application/json",
  };
}

/** Creates a Super Admin API user on `host` with an admin session; returns its Basic header. */
export async function createApiUser(
  port: number,
  host: string,
  session: Session,
  username: string,
): Promise<string> {
  const response = await request(port, host, "/api/users", {
    method: "POST",
    headers: sessionHeaders(session),
    body: JSON.stringify({ username, type: "api", status: "enabled", user_role_id: 1 }),
  });
  const body = await readJson<{ data?: { username: string; password: string } }>(response);
  if (response.status !== 200 || !body.data) {
    throw new Error(`Creating an API user on ${host} answered ${response.status}`);
  }
  return `Basic ${btoa(`${body.data.username}:${body.data.password}`)}`;
}

/** An API call with a Basic header; a body is sent as JSON. */
export async function api(
  port: number,
  host: string,
  authorization: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = { authorization };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await request(port, host, path, init);
  return { status: response.status, text: await response.text() };
}
