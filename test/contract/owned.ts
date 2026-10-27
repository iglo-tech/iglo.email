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

async function stop(child: GroupChild, closed: Promise<number>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) stopGroup(child);
  const force = setTimeout(() => stopGroup(child, "SIGKILL"), 2000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}

export async function withProduction<T>(
  executable: string,
  signal: AbortSignal,
  run: (origin: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const directory = await mkdtemp(join(tmpdir(), "iglo-contract-production-"));
  let child: GroupChild | undefined;
  let closed: Promise<number> | undefined;
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
      { cwd: directory, env: { PATH: "" }, stdio: ["ignore", "ignore", "pipe"] },
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
    while (Date.now() < deadline) {
      lifetime.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Compiled production process exited before readiness: ${errors}`);
      try {
        const response = await fetch(`${origin}/health`, {
          headers: { Connection: "close" },
          signal: AbortSignal.any([lifetime, AbortSignal.timeout(500)]),
        });
        if (response.status === 200 && (await response.text()) === '{"data":true}\n') break;
      } catch {
        lifetime.throwIfAborted();
      }
      await Bun.sleep(25);
    }
    if (Date.now() >= deadline) throw new Error("Compiled production process readiness timed out");
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(lifetime.reason);
      lifetime.addEventListener("abort", abort, { once: true });
    });
    let result: T;
    try {
      lifetime.throwIfAborted();
      result = await Promise.race([run(origin, lifetime), cancelled]);
    } finally {
      lifetime.removeEventListener("abort", abort);
    }
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Compiled production process exited during the contract run");
    return result;
  } finally {
    try {
      if (child && closed) await stop(child, closed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
