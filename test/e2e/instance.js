// A restored production instance for operations.e2e.js. The compiled executable runs on a data
// directory copied from a snapshot that the production `backup` command wrote from a live stack's
// data directory, so the restore hold (D67) is the one `backup` places. Node only: Playwright runs
// specs under Node, where `Bun` does not exist, so this file does not import test/serve-port.ts.
// Every directory is a fresh temporary one; every port is one the kernel picked.
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every child this process spawned and has not seen exit, registered before it listens, and every
// instance started and not yet closed. A test that times out never reaches its own `close`, so
// `stopOwnedInstances` and the exit hook reach these instead.
const children = new Set();
const owned = new Set();
process.once("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});

/** One `backup` (or `backup --release-hold`) run; the result carries the exit code and both streams. */
export async function backupCommand(executable, args) {
  try {
    const { stdout, stderr } = await execute(executable, ["backup", ...args], {
      env: { PATH: "" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * The executable serving `dataDir` on one port: `start` answers once /health is up, `stop` ends the
 * process with SIGTERM (SIGKILL after 15 s) and returns its exit code, and `start` after `stop`
 * serves the same origin again. `close` stops it and removes `directory`, whatever state it is in.
 */
export async function startInstance(executable, dataDir, directory) {
  let child;
  let errors = "";
  let origin = "";
  let listenPort = 0;

  const spawnOn = (port) => {
    errors = "";
    const current = spawn(
      executable,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
      { env: { PATH: "" }, stdio: ["ignore", "ignore", "pipe"] },
    );
    // Registered before the process can listen, so no path from here to `ready` loses it.
    children.add(current);
    current.once("exit", () => children.delete(current));
    current.stderr.on("data", (chunk) => {
      errors = (errors + chunk.toString()).slice(-4000);
    });
    child = current;
    return current;
  };

  const ready = async (current, base) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (current.exitCode !== null) throw new Error(`the instance exited: ${errors}`);
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
        if (response.status === 200) {
          // A server that already holds the port answers /health too; a process that lost the bind
          // exits a moment later, so a live process after a pause is the one that owns the port.
          await sleep(150);
          if (current.exitCode === null) return;
          throw new Error(`the instance exited after the port answered: ${errors}`);
        }
      } catch (error) {
        if (current.exitCode !== null) throw error;
      }
      await sleep(25);
    }
    throw new Error(`the instance did not answer /health: ${errors}`);
  };

  /** Starts on `port`, or on a new port the first time; a port taken by another process is retried. */
  const start = async (port) => {
    for (let attempt = 1; ; attempt++) {
      if (closing) throw new Error("the instance is closing, so it does not start again");
      const chosen = port ?? (await freePort());
      const current = spawnOn(chosen);
      try {
        await ready(current, `http://127.0.0.1:${chosen}`);
        // A close that began while this process was starting has already stopped `child`, which
        // is this one: it must not stay up as the instance's answer.
        if (closing) throw new Error("the instance closed while it was starting");
        listenPort = chosen;
        origin = `http://127.0.0.1:${chosen}`;
        return;
      } catch (error) {
        if (current.exitCode === null) await stopped(current);
        if (closing || attempt >= 5 || !/in use/i.test(errors)) throw error;
        await sleep(50 * attempt);
      }
    }
  };

  const stopped = (current) =>
    new Promise((resolve) => {
      if (current.exitCode !== null || current.signalCode !== null)
        return resolve(current.exitCode);
      const force = setTimeout(() => current.kill("SIGKILL"), 15_000);
      current.once("exit", (code) => {
        clearTimeout(force);
        resolve(code);
      });
      current.kill("SIGTERM");
    });

  const stop = async () => {
    const current = child;
    if (!current) return 0;
    const code = await stopped(current);
    child = undefined;
    return code;
  };

  // The first call does the work; a later one waits for the same cleanup to finish.
  let closing = false;
  let closed;
  const close = () => {
    closing = true;
    owned.delete(handle);
    closed ??= stop().finally(() => rm(directory, { recursive: true, force: true }));
    return closed;
  };
  const handle = { close };
  owned.add(handle);
  try {
    await start();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    get origin() {
      return origin;
    },
    dataDir,
    /** Starts again on the port it had, so the origin a browser holds still answers. */
    start: () => start(listenPort),
    stop,
    close,
  };
}

/**
 * Closes every instance this process started and has not closed, whatever state it is in. Each one
 * is closed on its own, so an error in one leaves the rest to close. Throws with all the errors.
 */
export async function stopOwnedInstances() {
  const results = await Promise.allSettled([...owned].map((handle) => handle.close()));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new Error(failed.map((result) => result.reason.message).join("\n"));
}

/**
 * A snapshot of `sourceDataDir` written by the production `backup` command, while its server may
 * run, copied into a fresh data directory, and that directory served by the same executable.
 */
export async function restoredInstance(executable, sourceDataDir) {
  const directory = await mkdtemp(join(tmpdir(), "iglo-email-e2e-restore-"));
  try {
    const snapshot = join(directory, "snapshot");
    const made = await backupCommand(executable, [
      "--data-dir",
      sourceDataDir,
      "--output",
      snapshot,
    ]);
    if (made.code !== 0) throw new Error(`backup exited ${made.code}: ${made.stderr}`);
    const dataDir = join(directory, "data");
    await cp(snapshot, dataDir, { recursive: true });
    return await startInstance(executable, dataDir, directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The release of the hold on a stopped data directory: `backup --release-hold --consent-reconciled`. */
export function releaseHold(executable, dataDir) {
  return backupCommand(executable, [
    "--release-hold",
    "--consent-reconciled",
    "--data-dir",
    dataDir,
  ]);
}
