// The iglo.base test harness (15-external-sources section 8, D187, D189, D190). `startIgloBase`
// runs the real iglo.base 1.3.0 binary in its own temporary directory on a free loopback port with
// the fixture schema of the shared harness (harness.ts), the same as `startPocketBase`. It returns
// the `PocketBase` harness interface of pocketbase.ts, so `sourceConfig` and any test written
// against that interface run unchanged on either binary. The one difference in the command line:
// no `--hooksDir` (iglo.base refuses it and exits with status 1, D189). See README.md.
import { join } from "node:path";
import { command, startHarness } from "@/test/sources/harness";
import { igloBaseBinary } from "@/test/sources/iglo-base-binary";
import type { PocketBase } from "@/test/sources/pocketbase";

/** Runs one CLI command of the binary; returns its stdout, throws with stderr on a failure. */
export async function igloBaseCommand(args: Array<string>): Promise<string> {
  return command("iglo-base", await igloBaseBinary(), args);
}

/** Starts iglo.base with the fixture schema and the service account. */
export function startIgloBase(): Promise<PocketBase> {
  return startHarness({
    label: "iglo.base",
    prefix: "iglo-base-",
    binary: igloBaseBinary,
    serveArgs: (root) => [
      `--dir=${join(root, "pb_data")}`,
      `--publicDir=${join(root, "pb_public")}`,
      `--migrationsDir=${join(root, "pb_migrations")}`,
      "--automigrate=false",
    ],
  });
}
