// Compiled test-only caller: the real `backup` command with something happening at the moment of
// publication, which nothing outside can hit reliably. Production builds have no such moment to
// reach: `src/main.ts` passes no hook.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBackup } from "@/backup/cli";
import { flushChildArgument, runFlushChild } from "@/backup/snapshot";

if (process.argv[2] === flushChildArgument) await runFlushChild();

const [action, path, ...args] = process.argv.slice(2);
const actions: Record<string, () => void> = {
  kill: () => process.kill(process.pid, "SIGKILL"),
  file: () => {
    rmSync(path!, { recursive: true, force: true });
    writeFileSync(path!, "someone else's");
  },
  empty: () => mkdirSync(path!),
  claim: () => {
    rmSync(path!, { recursive: true, force: true });
    mkdirSync(path!);
    writeFileSync(join(path!, "precious.txt"), "someone else's");
  },
};
try {
  runBackup(args, process.env, { beforePublish: actions[action!]! });
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
