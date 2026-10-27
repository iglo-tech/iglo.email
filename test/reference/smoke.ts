import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { command, spawnGroup, stopGroup, type GroupChild } from "@/test/reference/command";
import { cache, repository, sourceCommit } from "@/test/reference/prepare";

interface State {
  runId: string;
  reference: string;
  mailpit: string;
  receiver: string;
  smtpHost: string;
  smtpPort: string;
  runnerPid: number;
  childUrl?: string;
  grandchildUrl?: string;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function docker(args: string[]) {
  const result = await command(["docker", ...args], { timeout: 30_000 });
  if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  description: string,
  timeout = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
function startRunner(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawnGroup(process.execPath, ["run", "reference:run", "--", ...args], {
    cwd: repository,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr?.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
  });
  return { child, done, output: () => output };
}
async function finish(runner: ReturnType<typeof startRunner>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runner.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopGroup(runner.child);
          reject(new Error(`Reference CLI timed out: ${runner.output()}`));
        }, 150_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function stateFile(path: string, runner: ReturnType<typeof startRunner>): Promise<State> {
  return waitFor(async () => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (runner.child.exitCode !== null || runner.child.signalCode !== null)
        throw new Error(`Reference command exited before its child was ready: ${runner.output()}`);
      return undefined;
    }
  }, "reference command readiness");
}
async function absent(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}
async function smtpAbsent(host: string, port: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port: Number(port) });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
  });
}
async function checkCleanup(id: string, state?: State) {
  await waitFor(
    async () => {
      const containers = await docker([
        "ps",
        "-aq",
        "--filter",
        `label=io.iglo.email.reference.run=${id}`,
      ]);
      const volumes = await docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=io.iglo.email.reference.run=${id}`,
      ]);
      if (containers || volumes) return undefined;
      if (state) {
        const closed = await Promise.all([
          ...[
            state.reference,
            state.mailpit,
            state.receiver,
            ...(state.childUrl ? [state.childUrl] : []),
            ...(state.grandchildUrl ? [state.grandchildUrl] : []),
          ].map(absent),
          smtpAbsent(state.smtpHost, state.smtpPort),
        ]);
        if (!closed.every(Boolean)) return undefined;
      }
      return true;
    },
    `owned resources of ${id} to disappear`,
    30_000,
  );
}
function runId(output: string) {
  const value = /Reference run: ([a-f0-9-]{36})/.exec(output)?.[1];
  assert(value, `Runner did not announce its run ID: ${output}`);
  return value;
}

const realDocker = Bun.which("docker");
if (!realDocker) throw new Error("Docker CLI is required");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "validation-"));
const sentinelName = `iglo-reference-sentinel-${randomUUID()}`;
const sentinelLabel = `sentinel-${randomUUID()}`;
let sentinel: GroupChild | undefined;
let sentinelCreated = false;
const active: Array<ReturnType<typeof startRunner>> = [];
async function verifySentinelVolume() {
  const volumes = JSON.parse(await docker(["volume", "inspect", sentinelName])) as Array<{
    Labels?: Record<string, string>;
  }>;
  assert(
    volumes[0]?.Labels?.["io.iglo.email.reference.run"] === sentinelLabel,
    "Sentinel volume has an unexpected ownership label",
  );
}
try {
  await docker([
    "volume",
    "create",
    "--label",
    `io.iglo.email.reference.run=${sentinelLabel}`,
    sentinelName,
  ]);
  sentinelCreated = true;
  await verifySentinelVolume();
  sentinel = spawnGroup(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  async function sentinelSurvives() {
    assert(
      sentinel?.pid && sentinel.exitCode === null && sentinel.signalCode === null,
      "unrelated sentinel process was stopped",
    );
    process.kill(sentinel.pid, 0);
    await verifySentinelVolume();
  }
  const poisonedEnv = {
    LISTMONK_db__host: "invalid.example.test",
    LISTMONK_ADMIN_API_USER: "wrong-user",
    LISTMONK_ADMIN_PASSWORD: "wrong-password",
    MP_SMTP_RELAY_ALL: "true",
    MP_SMTP_FORWARD_CONFIG: "/nonexistent-forward-config",
    POSTGRES_DB: "wrong-database",
  };
  const verifyPath = join(temp, "verify.json");
  const verify = startRunner(
    [
      process.execPath,
      "test/reference/smoke-client.ts",
      "verify",
      verifyPath,
      "argument with spaces",
      "$(literal)",
      "semi;colon",
    ],
    poisonedEnv,
  );
  active.push(verify);
  const verifyCode = await finish(verify);
  assert(verifyCode === 0, `Smoke command failed (${verifyCode}): ${verify.output()}`);
  assert(
    verify.output().includes(sourceCommit) &&
      verify.output().includes("v7.0.0-beta.1") &&
      verify.output().includes("v1.32.0"),
    "Pinned versions/source were not validated",
  );
  const verified = JSON.parse(await readFile(verifyPath, "utf8")) as State;
  assert(runId(verify.output()) === verified.runId, "Run ID does not match child environment");
  await checkCleanup(verified.runId, verified);
  await sentinelSurvives();
  console.log("Successful run and owned cleanup passed");

  const orphanPath = join(temp, "orphan.json");
  const orphan = startRunner([
    process.execPath,
    "test/reference/smoke-client.ts",
    "orphan",
    orphanPath,
  ]);
  active.push(orphan);
  const orphanCode = await finish(orphan);
  assert(orphanCode === 0, `Exited parent cleanup failed (${orphanCode}): ${orphan.output()}`);
  const orphanState = JSON.parse(await readFile(orphanPath, "utf8")) as State;
  assert(orphanState.grandchildUrl, "Exited parent did not start a descendant");
  await checkCleanup(orphanState.runId, orphanState);
  await sentinelSurvives();
  console.log("Exited parent descendant cleanup passed");

  const waitPath = join(temp, "wait-term.json");
  const term = startRunner([process.execPath, "test/reference/smoke-client.ts", "wait", waitPath]);
  active.push(term);
  const waiting = await stateFile(waitPath, term);
  assert(
    waiting.grandchildUrl && (await fetch(waiting.grandchildUrl)).ok,
    "Test grandchild did not start",
  );
  const markerResponse = await fetch(`${waiting.receiver}/deliver`, {
    method: "POST",
    body: "other run's webhook",
  });
  assert(markerResponse.ok, "Could not set the concurrent webhook marker");
  const failurePath = join(temp, "failure.json");
  const failure = startRunner([
    process.execPath,
    "test/reference/smoke-client.ts",
    "failure",
    failurePath,
  ]);
  active.push(failure);
  const failedCode = await finish(failure);
  assert(
    failedCode === 37,
    `Command failure was not propagated (${failedCode}): ${failure.output()}`,
  );
  const failedState = JSON.parse(await readFile(failurePath, "utf8")) as State;
  assert(
    failedState.runId !== waiting.runId &&
      failedState.reference !== waiting.reference &&
      failedState.mailpit !== waiting.mailpit &&
      failedState.receiver !== waiting.receiver,
    "Concurrent runs shared resources",
  );
  await checkCleanup(failedState.runId, failedState);
  assert(
    (await fetch(`${waiting.reference}/health`)).ok,
    "Concurrent run was stopped by another run's cleanup",
  );
  await sentinelSurvives();
  process.kill(waiting.runnerPid, "SIGTERM");
  const termCode = await finish(term);
  assert(termCode === 143, `SIGTERM was not propagated (${termCode}): ${term.output()}`);
  await checkCleanup(waiting.runId, waiting);
  await sentinelSurvives();
  console.log("Concurrent runs, command failure, and SIGTERM cleanup passed");

  const intPath = join(temp, "wait-int.json");
  const int = startRunner([process.execPath, "test/reference/smoke-client.ts", "wait", intPath]);
  active.push(int);
  const interrupted = await stateFile(intPath, int);
  assert(
    interrupted.grandchildUrl && (await fetch(interrupted.grandchildUrl)).ok,
    "Test grandchild did not start",
  );
  process.kill(interrupted.runnerPid, "SIGINT");
  const intCode = await finish(int);
  assert(intCode === 130, `SIGINT was not propagated (${intCode}): ${int.output()}`);
  await checkCleanup(interrupted.runId, interrupted);
  await sentinelSurvives();
  console.log("SIGINT cleanup passed");

  const timeoutPath = join(temp, "wait-timeout.json");
  const timeout = startRunner(
    [process.execPath, "test/reference/smoke-client.ts", "wait", timeoutPath],
    { REFERENCE_COMMAND_TIMEOUT_MS: "2000" },
  );
  active.push(timeout);
  const timedState = await stateFile(timeoutPath, timeout);
  const timeoutCode = await finish(timeout);
  assert(
    timeoutCode === 124,
    `Command timeout was not propagated (${timeoutCode}): ${timeout.output()}`,
  );
  await checkCleanup(timedState.runId, timedState);
  await sentinelSurvives();
  console.log("Test command deadline and process-group cleanup passed");

  const killedCommand = startRunner([
    process.execPath,
    "-e",
    'process.kill(process.pid, "SIGKILL")',
  ]);
  active.push(killedCommand);
  const killedCode = await finish(killedCommand);
  assert(
    killedCode === 137,
    `A signalled test command did not propagate its status (${killedCode}): ${killedCommand.output()}`,
  );
  await checkCleanup(runId(killedCommand.output()));
  await sentinelSurvives();
  console.log("Signalled test command failure passed");

  const shimDir = join(temp, "shim");
  await mkdir(shimDir);
  const shim = join(shimDir, "docker");
  await writeFile(
    shim,
    '#!/bin/sh\nif [ "$1" = "start" ]; then echo "synthetic startup failure" >&2; exit 44; fi\nexec "$REFERENCE_REAL_DOCKER" "$@"\n',
  );
  await chmod(shim, 0o755);
  const partial = startRunner([process.execPath, "-e", "process.exit(0)"], {
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    REFERENCE_REAL_DOCKER: realDocker,
  });
  active.push(partial);
  const partialCode = await finish(partial);
  assert(
    partialCode !== 0 && partial.output().includes("synthetic startup failure"),
    `Partial startup failure not observed: ${partial.output()}`,
  );
  await checkCleanup(runId(partial.output()));
  await sentinelSurvives();
  console.log("Partial startup failure and sentinel survival passed");

  // Hold a Docker operation briefly to deliver a signal while startup is in
  // progress, after the container and volume have been created.
  const startupMarker = join(temp, "startup-pid");
  await writeFile(
    shim,
    '#!/bin/sh\nif [ "$1" = "start" ]; then printf "%s" "$PPID" > "$REFERENCE_START_MARKER"; sleep 4; fi\nexec "$REFERENCE_REAL_DOCKER" "$@"\n',
  );
  const startup = startRunner([process.execPath, "-e", "process.exit(0)"], {
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    REFERENCE_REAL_DOCKER: realDocker,
    REFERENCE_START_MARKER: startupMarker,
  });
  active.push(startup);
  const startupPid = await waitFor(async () => {
    try {
      return Number(await readFile(startupMarker, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (startup.child.exitCode !== null || startup.child.signalCode !== null)
        throw new Error(`Startup exited before signal: ${startup.output()}`);
      return undefined;
    }
  }, "the owned startup operation");
  assert(Number.isInteger(startupPid) && startupPid > 1, "Invalid startup runner PID");
  process.kill(startupPid, "SIGTERM");
  const startupCode = await finish(startup);
  assert(
    startupCode === 143,
    `Startup signal was not propagated (${startupCode}): ${startup.output()}`,
  );
  await checkCleanup(runId(startup.output()));
  await sentinelSurvives();
  console.log("Signal during partial startup cleanup passed");
} finally {
  const cleanupErrors: string[] = [];
  for (const runner of active) {
    try {
      if (runner.child.exitCode === null && runner.child.signalCode === null) {
        stopGroup(runner.child);
        await Promise.race([runner.done, Bun.sleep(35_000)]);
        stopGroup(runner.child, "SIGKILL");
      }
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  try {
    if (sentinel) stopGroup(sentinel, "SIGKILL");
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  try {
    if (sentinelCreated) {
      await verifySentinelVolume();
      await docker(["volume", "rm", sentinelName]);
    }
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  try {
    await rm(temp, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  if (cleanupErrors.length) {
    console.error(`Smoke cleanup was incomplete: ${cleanupErrors.join("; ")}`);
    process.exitCode = 1;
  }
}
