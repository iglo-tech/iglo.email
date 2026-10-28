import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { command, spawnGroup, stopGroup, type GroupChild } from "@/test/reference/command";
import { cache, prepare } from "@/test/reference/prepare";
import { startReceiver } from "@/test/reference/webhook";

const label = "io.iglo.email.reference.run";
const adminUser = "reference-admin";
const adminPassword = "reference-admin-password";
const apiUser = "reference-api";
const dbUser = "reference";
const dbPassword = "reference-db-password";
const dbName = "reference";

async function availablePorts(count: number): Promise<number[]> {
  const sockets = Array.from({ length: count }, () => createServer());
  try {
    for (const socket of sockets)
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(0, "127.0.0.1", resolve);
      });
    return sockets.map((socket) => {
      const address = socket.address();
      if (!address || typeof address === "string")
        throw new Error("Could not allocate a loopback port");
      return address.port;
    });
  } finally {
    await Promise.all(
      sockets.map((socket) =>
        socket.listening
          ? new Promise<void>((resolve) => socket.close(() => resolve()))
          : Promise.resolve(),
      ),
    );
  }
}

async function stop(child: GroupChild | undefined) {
  if (!child?.pid) return;
  stopGroup(child);
  if (child.exitCode === null && child.signalCode === null) {
    const timer = setTimeout(() => stopGroup(child, "SIGKILL"), 3_000);
    try {
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    } finally {
      clearTimeout(timer);
    }
  }
  stopGroup(child, "SIGKILL");
}

async function ready(
  check: () => Promise<boolean>,
  signal: AbortSignal,
  description: string,
  child?: GroupChild,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`${description} exited before readiness`);
    try {
      if (await check()) return;
    } catch {
      /* Service is still starting. */
    }
    await Bun.sleep(100);
  }
  throw new Error(`${description} was not ready within ${timeout}ms`);
}

async function healthy(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(1_000),
    headers: { Connection: "close" },
  });
  return response.ok;
}

// Check database acceptance over TCP: SSL negotiation alone can succeed while
// Postgres still rejects startup packets with 57P03. An explicit TCP host also
// excludes the image's temporary initialization server, which uses a Unix socket.
// Keep the published-port check so Docker forwarding must be usable as well.
async function postgresReady(
  container: string,
  port: number,
  signal: AbortSignal,
): Promise<boolean> {
  const status = await command(
    [
      "docker",
      "exec",
      container,
      "pg_isready",
      "-q",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      dbUser,
      "-d",
      dbName,
      "-t",
      "1",
    ],
    { timeout: 5_000, signal },
  );
  if (status.code !== 0) return false;
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => {
      const sslRequest = Buffer.alloc(8);
      sslRequest.writeInt32BE(8, 0);
      sslRequest.writeInt32BE(80877103, 4);
      socket.write(sslRequest);
    });
    socket.once("data", (data) => finish(data[0] === 0x4e || data[0] === 0x53));
  });
}

async function run(args: string[]): Promise<number> {
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) throw new Error("Usage: bun run reference:run -- <command> [args...]");
  const timeoutText = process.env.REFERENCE_COMMAND_TIMEOUT_MS ?? "600000";
  const commandTimeout = Number(timeoutText);
  if (
    !/^\d+$/.test(timeoutText) ||
    !Number.isSafeInteger(commandTimeout) ||
    commandTimeout < 1_000 ||
    commandTimeout > 3_600_000
  )
    throw new Error("REFERENCE_COMMAND_TIMEOUT_MS must be an integer from 1000 to 3600000");
  const id = randomUUID();
  const name = `iglo-reference-${id}`;
  const directory = join(cache, "runs", id);
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  let listmonk: GroupChild | undefined;
  let mailpit: GroupChild | undefined;
  let testCommand: GroupChild | undefined;
  let receiver: ReturnType<typeof startReceiver> | undefined;
  let cleanupError = false;
  let resourcesMayExist = false;
  let ownsDirectory = false;
  let exitCode = 1;
  let failure: unknown;
  let failed = false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    controller.abort(new Error(`Interrupted by ${signal}`));
    if (testCommand) stopGroup(testCommand, signal);
    if (listmonk) stopGroup(listmonk);
    if (mailpit) stopGroup(mailpit);
    // A test command may handle or ignore SIGTERM/SIGINT. It must not hold
    // cleanup open indefinitely after the runner has been interrupted.
    forceStop = setTimeout(() => {
      if (testCommand) stopGroup(testCommand, "SIGKILL");
      if (listmonk) stopGroup(listmonk, "SIGKILL");
      if (mailpit) stopGroup(mailpit, "SIGKILL");
    }, 3_000);
  };
  const sigterm = () => interrupt("SIGTERM");
  const sigint = () => interrupt("SIGINT");
  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);
  console.log(`Reference run: ${id}`);

  // Docker operations finish before cleanup starts, even if a signal arrives in
  // the middle of creation. The exact name and label identify what we own.
  async function docker(args: string[], timeout = 30_000) {
    const result = await command(["docker", ...args], { timeout });
    if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }
  async function removeOwned(type: "container" | "volume") {
    const inspectArgs =
      type === "container" ? ["inspect", "--type", "container", name] : ["volume", "inspect", name];
    const result = await command(["docker", ...inspectArgs], { timeout: 15_000 });
    if (result.code !== 0) {
      if (/no such (object|container|volume)/i.test(result.stderr)) return;
      throw new Error(`Could not inspect owned ${type}: ${result.stderr.trim()}`);
    }
    const item = JSON.parse(result.stdout)[0];
    const labels = type === "container" ? item.Config?.Labels : item.Labels;
    if (labels?.[label] !== id)
      throw new Error(`Refusing to remove ${type} with an unexpected ownership label: ${name}`);
    await docker(type === "container" ? ["rm", "-f", item.Id] : ["volume", "rm", name], 30_000);
  }
  function service(executable: string, argv: string[], env: NodeJS.ProcessEnv, logName: string) {
    const fd = openSync(join(directory, logName), "a", 0o600);
    try {
      const child = spawnGroup(executable, argv, {
        cwd: directory,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.on("error", (error) => console.error(`Could not start ${logName}: ${error.message}`));
      return child;
    } finally {
      closeSync(fd);
    }
  }

  try {
    const binaries = await prepare(controller.signal);
    controller.signal.throwIfAborted();
    await mkdir(join(cache, "runs"), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    ownsDirectory = true;
    receiver = startReceiver();
    const [httpPort, smtpPort, referencePort] = await availablePorts(3);
    if (!httpPort || !smtpPort || !referencePort) throw new Error("Could not allocate ports");
    const mailUrl = `http://127.0.0.1:${httpPort}`;
    const referenceUrl = `http://127.0.0.1:${referencePort}`;
    const serviceEnv = {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      TMPDIR: directory,
      TZ: "UTC",
    };
    mailpit = service(
      binaries.mailpit,
      [
        "--listen",
        `127.0.0.1:${httpPort}`,
        "--smtp",
        `127.0.0.1:${smtpPort}`,
        "--label",
        id,
        "--disable-version-check",
        "--smtp-disable-rdns",
        "--quiet",
      ],
      serviceEnv,
      "mailpit.log",
    );
    const mailpitReady = async () => {
      if (!(await healthy(`${mailUrl}/readyz`))) return false;
      const response = await fetch(`${mailUrl}/api/v1/webui`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return false;
      const config = (await response.json()) as {
        Label?: string;
        MessageRelay?: { Enabled?: boolean };
      };
      return config.Label === id && config.MessageRelay?.Enabled === false;
    };
    await ready(mailpitReady, controller.signal, "Mailpit", mailpit);

    resourcesMayExist = true;
    await docker(["volume", "create", "--label", `${label}=${id}`, name]);
    const volume = JSON.parse(await docker(["volume", "inspect", name]))[0];
    if (volume?.Labels?.[label] !== id)
      throw new Error(`Refusing to use a volume with an unexpected ownership label: ${name}`);
    controller.signal.throwIfAborted();
    await docker(
      [
        "create",
        "--name",
        name,
        "--label",
        `${label}=${id}`,
        "--memory",
        "256m",
        "--cpus",
        "1",
        "-p",
        "127.0.0.1::5432",
        "--mount",
        `type=volume,source=${name},target=/var/lib/postgresql/data`,
        "-e",
        `POSTGRES_USER=${dbUser}`,
        "-e",
        `POSTGRES_PASSWORD=${dbPassword}`,
        "-e",
        `POSTGRES_DB=${dbName}`,
        "postgres:17-alpine",
      ],
      180_000,
    );
    controller.signal.throwIfAborted();
    await docker(["start", name]);
    controller.signal.throwIfAborted();
    const portOutput = await docker(["port", name, "5432/tcp"]);
    const dbPort = /^127\.0\.0\.1:(\d+)$/m.exec(portOutput)?.[1];
    if (!dbPort) throw new Error(`Docker did not report a loopback Postgres port: ${portOutput}`);
    await ready(
      () => postgresReady(name, Number(dbPort), controller.signal),
      controller.signal,
      "Postgres",
      undefined,
      60_000,
    );
    const referenceEnv = {
      ...serviceEnv,
      ZONEINFO: binaries.zoneinfo,
      LISTMONK_app__address: `127.0.0.1:${referencePort}`,
      LISTMONK_db__host: "127.0.0.1",
      LISTMONK_db__port: dbPort,
      LISTMONK_db__user: dbUser,
      LISTMONK_db__password: dbPassword,
      LISTMONK_db__database: dbName,
      LISTMONK_db__ssl_mode: "disable",
      LISTMONK_db__max_open: "10",
      LISTMONK_db__max_idle: "10",
      LISTMONK_db__max_lifetime: "300s",
    };
    const installation = await command([binaries.listmonk, "--install", "--yes", "--config", ""], {
      cwd: directory,
      env: {
        ...referenceEnv,
        LISTMONK_ADMIN_USER: adminUser,
        LISTMONK_ADMIN_PASSWORD: adminPassword,
        LISTMONK_ADMIN_API_USER: apiUser,
      },
      timeout: 60_000,
      signal: controller.signal,
    });
    if (installation.code !== 0) {
      const diagnostic = `${installation.stdout}\n${installation.stderr}`
        .replace(/LISTMONK_ADMIN_API_TOKEN=.*/g, "LISTMONK_ADMIN_API_TOKEN=[redacted]")
        .replaceAll(adminPassword, "[redacted]")
        .replaceAll(dbPassword, "[redacted]");
      throw new Error(
        `listmonk installation failed (exit ${installation.code}): ${diagnostic.trim()}`,
      );
    }
    const token = /^export LISTMONK_ADMIN_API_TOKEN="([^"]+)"$/m.exec(installation.stderr)?.[1];
    if (!token) throw new Error("listmonk installer did not generate an API token");
    const authorization = `Basic ${Buffer.from(`${apiUser}:${token}`).toString("base64")}`;
    const listArgs = ["--config", ""];
    listmonk = service(binaries.listmonk, [...listArgs, "--passive"], referenceEnv, "listmonk.log");
    await ready(() => healthy(`${referenceUrl}/health`), controller.signal, "listmonk", listmonk);
    const settingsResponse = await fetch(`${referenceUrl}/api/settings`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (!settingsResponse.ok)
      throw new Error(`Authenticated settings read failed: HTTP ${settingsResponse.status}`);
    const envelope = (await settingsResponse.json()) as { data: Record<string, unknown> };
    const settings = envelope.data;
    const smtp = settings.smtp as Array<Record<string, unknown>>;
    if (!Array.isArray(smtp) || !smtp[0])
      throw new Error("Upstream did not provide default SMTP settings");
    const localSMTP = [
      {
        ...smtp[0],
        uuid: "",
        enabled: true,
        host: "127.0.0.1",
        port: smtpPort,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
      },
    ];
    // Update individual keys: the full settings response masks unrelated
    // passwords, so writing it back would change upstream's other defaults.
    for (const [key, value] of [
      ["smtp", localSMTP],
      ["app.check_updates", false],
      ["app.root_url", referenceUrl],
    ] as const) {
      let badStatus = 0;
      await ready(
        async () => {
          let response: Response;
          try {
            response = await fetch(`${referenceUrl}/api/settings/${key}`, {
              method: "PUT",
              headers: { Authorization: authorization, "Content-Type": "application/json" },
              body: JSON.stringify(value),
              signal: AbortSignal.timeout(2_000),
            });
          } catch {
            return false;
          } // listmonk may be reloading after the previous update.
          if (!response.ok) badStatus = response.status;
          return true;
        },
        controller.signal,
        `settings update ${key}`,
        listmonk,
      );
      if (badStatus) throw new Error(`Could not update ${key}: HTTP ${badStatus}`);
    }
    // Reload is scheduled asynchronously by listmonk; restart once to guarantee
    // the persisted local-only SMTP and disabled update checker are active.
    await stop(listmonk);
    controller.signal.throwIfAborted();
    listmonk = service(binaries.listmonk, listArgs, referenceEnv, "listmonk.log");
    await ready(
      () => healthy(`${referenceUrl}/health`),
      controller.signal,
      "configured listmonk",
      listmonk,
    );
    const verified = await fetch(`${referenceUrl}/api/settings`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (!verified.ok)
      throw new Error(`Configured listmonk authentication failed: HTTP ${verified.status}`);
    await ready(mailpitReady, controller.signal, "Mailpit", mailpit);
    controller.signal.throwIfAborted();
    const executable = args[0]!;
    testCommand = spawnGroup(executable, args.slice(1), {
      cwd: process.cwd(),
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        REFERENCE_RUN_ID: id,
        REFERENCE_URL: referenceUrl,
        REFERENCE_API_USER: apiUser,
        REFERENCE_API_TOKEN: token,
        MAILPIT_URL: mailUrl,
        MAILPIT_SMTP_HOST: "127.0.0.1",
        MAILPIT_SMTP_PORT: String(smtpPort),
        WEBHOOK_URL: `${receiver.url}/deliver`,
        WEBHOOK_RECEIVER_URL: receiver.url,
      },
    });
    const child = testCommand;
    let timedOut = false;
    let forceTimeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      stopGroup(child);
      forceTimeout = setTimeout(() => stopGroup(child, "SIGKILL"), 3_000);
    }, commandTimeout);
    let exit: number;
    try {
      exit = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) =>
          resolve(code ?? (signal ? 128 + osConstants.signals[signal] : 1)),
        );
      });
    } finally {
      clearTimeout(deadline);
      if (forceTimeout) clearTimeout(forceTimeout);
    }
    if (timedOut) console.error(`Reference command exceeded ${commandTimeout}ms`);
    exitCode = receivedSignal ? (receivedSignal === "SIGINT" ? 130 : 143) : timedOut ? 124 : exit;
  } catch (error) {
    if (receivedSignal) exitCode = receivedSignal === "SIGINT" ? 130 : 143;
    else {
      failed = true;
      failure = error;
    }
  } finally {
    // Each cleanup action is independent: a failed removal must not skip the rest.
    for (const action of [
      () => stop(testCommand),
      () => stop(listmonk),
      () => stop(mailpit),
      async () => {
        if (receiver) await receiver.server.stop(true);
      },
      async () => {
        if (resourcesMayExist) await removeOwned("container");
      },
      async () => {
        if (resourcesMayExist) await removeOwned("volume");
      },
      async () => {
        if (ownsDirectory) await rm(directory, { recursive: true, force: true });
      },
    ]) {
      try {
        await action();
      } catch (error) {
        cleanupError = true;
        console.error(`Reference cleanup: ${error instanceof Error ? error.message : error}`);
      }
    }
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
    if (forceStop) clearTimeout(forceStop);
  }
  if (failed) throw failure;
  if (cleanupError) throw new Error("Reference cleanup was incomplete");
  return exitCode;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(`reference:run: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
