import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGroup, stopGroup, type GroupChild } from "@/test/reference/command";

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a loopback port");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stop(child: GroupChild, closed: Promise<number>): Promise<number> {
  if (child.exitCode === null && child.signalCode === null) stopGroup(child);
  const force = setTimeout(() => stopGroup(child, "SIGKILL"), 2000);
  try {
    return await closed;
  } finally {
    clearTimeout(force);
  }
}

export async function withProduction<T>(
  executable: string,
  signal: AbortSignal,
  run: (origin: string, signal: AbortSignal) => Promise<T>,
  admin?: { user: string; password: string },
  timeoutMs = 30_000,
): Promise<T> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const directory = await mkdtemp(join(tmpdir(), "iglo-contract-production-"));
  let child: GroupChild | undefined;
  let closed: Promise<number> | undefined;
  let completed = false;
  let result: T | undefined;
  let shutdownFailure: Error | undefined;
  try {
    const copy = join(directory, "iglo.email");
    await copyFile(executable, copy);
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    lifetime.throwIfAborted();
    child = spawnGroup(
      copy,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        join(directory, "data"),
      ],
      {
        cwd: directory,
        env: {
          PATH: "",
          ...(admin
            ? { IGLO_EMAIL_ADMIN_USER: admin.user, IGLO_EMAIL_ADMIN_PASSWORD: admin.password }
            : {}),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-4000);
    });
    closed = new Promise<number>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code) => resolve(code ?? 1));
    });
    // Attach a rejection handler immediately, even if readiness fails first.
    void closed.catch(() => {});
    const deadline = Date.now() + 5000;
    let ready = false;
    while (Date.now() < deadline) {
      lifetime.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Compiled production process exited before readiness: ${errors}`);
      try {
        const response = await fetch(`${origin}/health`, {
          headers: { Connection: "close" },
          signal: AbortSignal.any([lifetime, AbortSignal.timeout(500)]),
        });
        if (response.status === 200 && (await response.text()) === '{"data":true}\n') {
          ready = true;
          break;
        }
      } catch {
        lifetime.throwIfAborted();
      }
      await Bun.sleep(25);
    }
    if (!ready) throw new Error("Compiled production process readiness timed out");
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(lifetime.reason);
      lifetime.addEventListener("abort", abort, { once: true });
    });
    try {
      lifetime.throwIfAborted();
      result = await Promise.race([run(origin, lifetime), cancelled]);
    } finally {
      lifetime.removeEventListener("abort", abort);
    }
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Compiled production process exited during the contract run");
    completed = true;
  } finally {
    try {
      if (child && closed) {
        const code = await stop(child, closed);
        if (completed && code !== 0)
          shutdownFailure = new Error(`Compiled production process shutdown failed (exit ${code})`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (shutdownFailure) throw shutdownFailure;
  return result as T;
}

// Provision only through the compiled process's real login and protected user API.
export async function provisionApiUser(origin: string, admin: { user: string; password: string }) {
  const page = await fetch(`${origin}/admin/login`);
  const html = await page.text();
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1];
  const nonceCookie = page.headers
    .getSetCookie()
    .find((item) => item.startsWith("nonce="))
    ?.split(";", 1)[0];
  if (page.status !== 200 || !nonce || !nonceCookie)
    throw new Error("Unable to obtain production login form");
  const login = await fetch(`${origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: nonceCookie },
    body: new URLSearchParams({
      username: admin.user,
      password: admin.password,
      nonce,
      next: "/api/profile",
    }),
  });
  const session = login.headers
    .getSetCookie()
    .find((item) => item.startsWith("session="))
    ?.split(";", 1)[0];
  const csrf = login.headers
    .getSetCookie()
    .find((item) => item.startsWith("csrf="))
    ?.split(";", 1)[0];
  if (login.status !== 302 || !session || !csrf)
    throw new Error("Unable to log into production bootstrap account");
  const user = "m13-contract-api";
  const response = await fetch(`${origin}/api/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${session}; ${csrf}`,
      "X-CSRF-Token": csrf.slice("csrf=".length),
    },
    body: JSON.stringify({ username: user, type: "api", status: "enabled", user_role_id: 1 }),
  });
  if (response.status !== 200)
    throw new Error("Unable to create production contract API credential");
  let data: { data?: { username?: unknown; password?: unknown } };
  try {
    data = (await response.json()) as { data?: { username?: unknown; password?: unknown } };
  } catch {
    throw new Error("Invalid production contract API credential");
  }
  if (
    data.data?.username !== user ||
    typeof data.data.password !== "string" ||
    !/^[A-Za-z0-9]{48}$/.test(data.data.password)
  )
    throw new Error("Invalid production contract API credential");
  return { user, token: data.data.password };
}
