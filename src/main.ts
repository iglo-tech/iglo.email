// Process startup and shutdown are adapted from listmonk's cmd/main.go.
import { writeSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createRealClock } from "@/clock";
import { holdDataDirectory } from "@/db/instance-lock";
import { helpText, parseBootstrap, versionText } from "@/config/bootstrap";
import type { Router } from "@/server/router";
import { serveRouted } from "@/server/server";
import { childArgument, runQueryChild } from "@/subscribers/query-runner";
import { analyticsChildArgument, runAnalyticsChild } from "@/analytics/reader";
import { backupHelp, runBackup } from "@/backup/cli";
import { flushChildArgument, runFlushChild } from "@/backup/snapshot";
import { resetPasswordHelp, resetTotpHelp, runResetPassword, runResetTotp } from "@/users/cli";
import { recoverAdmin } from "@/projects/admin-recovery";
import { openInstance } from "@/projects/instance";
import type { Instance, InstanceConfig } from "@/projects/instance";
import { oldLayoutMessage, usesOldLayout } from "@/projects/layout";

/**
 * Writes the one line that names a port of 0 once it is bound (D144). It is written synchronously
 * to the stdout descriptor, so it is out before any loop starts. A stdout that no one reads (a
 * closed pipe) is the caller's choice: the write fails, and the server serves on, with no error
 * output and no change to its exit code.
 */
function reportPort(port: number | undefined): void {
  try {
    writeSync(1, `listening on port ${port}\n`);
  } catch {
    // No reader for stdout: the line is lost, and nothing else depends on it.
  }
}

/**
 * `inspect` sees the primary project's composed router before anything listens; a test may throw
 * to stop there.
 */
export async function main(inspect?: (router: Router) => void): Promise<void> {
  // The compiled executable re-runs itself to evaluate raw subscriber SQL in a killable process.
  if (process.argv[2] === childArgument) {
    return runQueryChild();
  }
  if (process.argv[2] === analyticsChildArgument) {
    return runAnalyticsChild();
  }
  if (process.argv[2] === flushChildArgument) {
    return runFlushChild();
  }
  if (process.argv[2] === "backup") {
    process.exitCode = runBackup(process.argv.slice(3), process.env);
    return;
  }
  if (process.argv[2] === "reset-password") {
    return runResetPassword(process.argv.slice(3), process.env, recoverAdmin);
  }
  if (process.argv[2] === "reset-totp") {
    return runResetTotp(process.argv.slice(3), process.env, recoverAdmin);
  }
  const bootstrap = parseBootstrap(process.argv.slice(2), process.env);
  if (bootstrap.help) {
    process.stdout.write(helpText + backupHelp + resetPasswordHelp + resetTotpHelp);
    return;
  }
  if (bootstrap.version) {
    process.stdout.write(versionText);
    return;
  }

  const config = bootstrap.config;
  const clock = createRealClock();
  // An earlier layout is refused before the lock, so nothing is written to it (D142).
  if (usesOldLayout(resolvePath(config.dataDir))) {
    throw new Error(oldLayoutMessage(resolvePath(config.dataDir)));
  }
  const seed: InstanceConfig["seed"] = config.initialApi
    ? { admin: config.initialAdmin, api: config.initialApi }
    : { admin: config.initialAdmin };
  // Before anything reads or migrates a database, and released after they close (D69).
  const lock = holdDataDirectory(config.dataDir);
  let opened: Instance | undefined;
  try {
    // The instance and every project's stores, routes and loops are wired before the port binds;
    // no loop runs yet (B52).
    const composed = await openInstance(
      {
        dataDir: config.dataDir,
        rootUrl: config.rootUrl,
        listen: { host: config.host, port: config.port },
        seed,
      },
      clock,
    );
    opened = composed;
    const router = composed.primaryRouter();
    if (router) {
      inspect?.(router);
    }
    // The port is bound before any loop starts (B52). A bind that fails throws here, with nothing
    // started, so the finally block closes the stores and releases the lock and nothing else.
    const server = serveRouted({ host: config.host, port: config.port }, (request, peer) =>
      composed.dispatch(request, peer),
    );
    composed.attach(server);
    // A port of 0 is known only now, so the one line that names it comes right after the bind (D144).
    if (bootstrap.config.port === 0) {
      reportPort(server.port);
    }
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const shutdown = (failure?: unknown) => {
        if (closing) {
          return;
        }
        closing = true;
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        // Stop campaign and sequence claims first, as each project lists them, the last project
        // first; the HTTP stop is last, its requests in flight bounded at 5 s (B149a, D164).
        const stops = [...composed.stop(), composed.stopServer()];
        void Promise.allSettled(stops).then((results) => {
          const error = failure ?? results.find((result) => result.status === "rejected");
          if (error) {
            reject(
              error instanceof Error
                ? error
                : error && typeof error === "object" && "reason" in error
                  ? error.reason
                  : new Error("Outbox stopped"),
            );
          } else {
            resolve();
          }
        });
      };
      const onSignal = () => shutdown();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      // The loops start once the server listens, in their wiring order. A loop's failure, or a
      // start that throws, shuts the server down with the rest.
      composed.start(shutdown);
    });
  } finally {
    await opened?.close();
    lock.release();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Failed to start server");
    process.exitCode = 1;
  }
}
