// Process startup and shutdown are adapted from listmonk's cmd/main.go.
import { helpText, parseBootstrap } from "@/config/bootstrap";
import { startServer } from "@/server/server";

async function main(): Promise<void> {
  const bootstrap = parseBootstrap(process.argv.slice(2), process.env);
  if (bootstrap.help) {
    process.stdout.write(helpText);
    return;
  }

  const server = startServer(bootstrap.config);
  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      process.off("SIGTERM", shutdown);
      process.off("SIGINT", shutdown);
      server.stop().then(resolve, reject);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed to start server");
  process.exitCode = 1;
});
