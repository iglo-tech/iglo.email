// Owns a disposable compiled process for the documented manual browser check.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const fixture = await readFile(resolve(repository, "test/users/fixtures.md"), "utf8");
const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1];
const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1];
if (!user || !password) throw new Error("Synthetic browser fixture is missing");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  await withProduction(
    resolve(repository, "dist/iglo.email"),
    controller.signal,
    async (origin, signal) => {
      process.stdout.write(`Browser fixture: ${origin}\n`);
      await new Promise<void>((done) =>
        signal.addEventListener("abort", () => done(), { once: true }),
      );
    },
    { user, password },
    300_000,
  );
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
