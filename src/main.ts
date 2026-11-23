// Process startup and shutdown are adapted from listmonk's cmd/main.go.
import { createRealClock } from "@/clock";
import { holdDataDirectory } from "@/db/instance-lock";
import { helpText, parseBootstrap, versionText } from "@/config/bootstrap";
import type { Router } from "@/server/router";
import { startServer } from "@/server/server";
import { childArgument, runQueryChild } from "@/subscribers/query-runner";
import { analyticsChildArgument, runAnalyticsChild } from "@/analytics/reader";
import { backupHelp, runBackup } from "@/backup/cli";
import { flushChildArgument, runFlushChild } from "@/backup/snapshot";
import { resetPasswordHelp, resetTotpHelp, runResetPassword, runResetTotp } from "@/users/cli";
import { createProject } from "@/projects/compose";
import type { Project } from "@/projects/compose";

// Process-wide budget (invariant 7): one budget for the process, however many projects it serves.
const BOUNCE_WEBHOOK_PER_MINUTE = 6000;

/** `inspect` sees the composed router before anything listens; a test may throw to stop there. */
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
    return runBackup(process.argv.slice(3), process.env);
  }
  if (process.argv[2] === "reset-password") {
    return runResetPassword(process.argv.slice(3), process.env);
  }
  if (process.argv[2] === "reset-totp") {
    return runResetTotp(process.argv.slice(3), process.env);
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

  const clock = createRealClock();
  // Before anything reads or migrates the database, and released after it closes (D69).
  const instance = holdDataDirectory(bootstrap.config.dataDir);
  let project: Project | undefined;
  try {
    // Every store, route and loop is wired before the port binds; no loop runs yet (B52).
    const composed = await createProject(
      { clock, budgets: { bounceWebhookPerMinute: BOUNCE_WEBHOOK_PER_MINUTE } },
      { config: bootstrap.config },
    );
    project = composed;
    inspect?.(composed.router);
    // The port is bound before any loop starts (B52). A bind that fails throws here, with nothing
    // started, so the finally block closes the stores and releases the lock and nothing else.
    const server = startServer(composed.app, composed.router);
    composed.attach(server);
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const shutdown = (failure?: unknown) => {
        if (closing) {
          return;
        }
        closing = true;
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        // Stop campaign and sequence claims first, as the project lists them; the HTTP stop is last.
        const stops = [...composed.stop(), server.stop()];
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
    await project?.close();
    instance.release();
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
