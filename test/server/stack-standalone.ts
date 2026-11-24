// Test-only compiled fixture: production never registers these routes. Its logger is the
// production error logger, so an unexpected handler error prints to this process's stderr as it
// does in the executable (B110).
import { createErrorLogger } from "@/app";
import { startFixture } from "@/test/server/fixture";

const fixture = startFixture({ logger: createErrorLogger() });
process.stdout.write(`${fixture.origin}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void fixture.close();
  });
}
