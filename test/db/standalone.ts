import { startDbFixture } from "@/test/db/fixture";

const fixture = startDbFixture(process.argv[2]!);
process.stdout.write(`${fixture.origin}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fixture.close();
  });
}
