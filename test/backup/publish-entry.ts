// Compiled test-only caller: the real `backup` command with something happening at the moment of
// publication, which nothing outside can hit reliably. Production builds have no such moment to
// reach: `src/main.ts` passes no hook.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runBackup } from "@/backup/cli";
import { flushChildArgument, runFlushChild } from "@/backup/snapshot";
import { asBody } from "@/test/read-body";

if (process.argv[2] === flushChildArgument) {
  await runFlushChild();
}

const [action, path, ...args] = process.argv.slice(2);
const actions: Record<string, () => void> = {
  kill: () => process.kill(process.pid, "SIGKILL"),
  file: () => {
    rmSync(path!, { recursive: true, force: true });
    writeFileSync(path!, "someone else's");
  },
  empty: () => mkdirSync(path!),
  // B170 (D198): the project whose directory `path` is deleted from the registry after its copy, as
  // a delete through the instance would; its rows go, its directory stays for the release check.
  unregister: () => {
    const db = new Database(join(dirname(dirname(path!)), "instance.db"));
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.transaction(() => {
        db.query("DELETE FROM hostnames WHERE project = ?").run(basename(path!));
        db.query("DELETE FROM projects WHERE slug = ?").run(basename(path!));
      })();
    } finally {
      db.close();
    }
  },
  claim: () => {
    rmSync(path!, { recursive: true, force: true });
    mkdirSync(path!);
    writeFileSync(join(path!, "precious.txt"), "someone else's");
  },
};
try {
  runBackup(args, process.env, { beforePublish: actions[action!]! });
} catch (error) {
  console.error(asBody<Error>(error).message);
  process.exitCode = 1;
}
