// Test-only compiled fixture: production never registers these routes.
import { createTranslation } from "@/i18n/i18n";
import { startFixture } from "@/test/server/fixture";

const fixture = startFixture({ i18n: createTranslation("fr") });
process.stdout.write(`${fixture.origin}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void fixture.server.stop(true);
  });
}
