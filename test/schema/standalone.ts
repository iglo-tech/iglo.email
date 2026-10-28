// Compiled test-only process boundary; no production route is registered.
import { startSchemaFixture } from "@/test/schema/fixture";

const fixture = startSchemaFixture(process.argv[2]!);
process.stdout.write(`${fixture.origin}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fixture.close();
  });
}
