// Process startup and shutdown are adapted from listmonk's cmd/main.go.
import { createApp, createErrorLogger } from "@/app";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { helpText, parseBootstrap } from "@/config/bootstrap";
import { startServer } from "@/server/server";

async function main(): Promise<void> {
  const bootstrap = parseBootstrap(process.argv.slice(2), process.env);
  if (bootstrap.help) {
    process.stdout.write(helpText);
    return;
  }

  const clock = createRealClock();
  const db = openDatabase(bootstrap.config.dataDir);
  try {
    runMigrations(db, bootstrap.config.dataDir, clock, productionMigrations);
    const app = createApp({
      bootstrap: bootstrap.config,
      clock,
      db,
      logger: createErrorLogger(),
      i18n: createTranslation(),
    });
    const server = startServer(app);
    await new Promise<void>((resolve, reject) => {
      const shutdown = () => {
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
        server.stop().then(resolve, reject);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
  } finally {
    db.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed to start server");
  process.exitCode = 1;
});
