// Compiled test-only caller: the real `backup` command with something happening at the moment of
// publication, which nothing outside can hit reliably. Production builds have no such moment to
// reach: `src/main.ts` passes no hook.
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runBackup } from "@/backup/cli";
import { flushChildArgument, runFlushChild } from "@/backup/snapshot";
import { asBody } from "@/test/read-body";

if (process.argv[2] === flushChildArgument) {
  await runFlushChild();
}

const [action, path, ...args] = process.argv.slice(2);
/** instance.db beside the projects directory that holds the project at `path`. */
const instanceDatabase = () => join(dirname(dirname(path!)), "instance.db");
/** The directory at `path` replaced by a copy of itself: the same names in new inodes. */
const replaceFiles = () => {
  const fresh = `${path!}.new`;
  cpSync(path!, fresh, { recursive: true });
  rmSync(path!, { recursive: true, force: true });
  renameSync(fresh, path!);
};
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
  // B172 (D200): the project at `path` deleted and created again under its slug, as a delete then a
  // create through the instance would leave it: a new registry row (a later creation time) and a
  // new directory and database file (copies, so new inodes) holding the same names.
  recreate: () => {
    const slug = basename(path!);
    const db = new Database(instanceDatabase());
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.transaction(() => {
        const row = asBody<{ name: string; created_at: string; is_primary: number }>(
          db.query("SELECT name, created_at, is_primary FROM projects WHERE slug = ?").get(slug),
        );
        const hosts = db
          .query<{ hostname: string; kind: string }, [string]>(
            "SELECT hostname, kind FROM hostnames WHERE project = ?",
          )
          .all(slug);
        db.query("DELETE FROM hostnames WHERE project = ?").run(slug);
        db.query("DELETE FROM projects WHERE slug = ?").run(slug);
        const later = new Date(Date.parse(row.created_at) + 1000).toISOString();
        db.query(
          "INSERT INTO projects (slug, name, created_at, is_primary) VALUES (?, ?, ?, ?)",
        ).run(slug, row.name, later, row.is_primary);
        for (const host of hosts) {
          db.query("INSERT INTO hostnames (hostname, project, kind) VALUES (?, ?, ?)").run(
            host.hostname,
            slug,
            host.kind,
          );
        }
      })();
    } finally {
      db.close();
    }
    replaceFiles();
  },
  // B172: only the files of `recreate`, the registry row kept: what the device and inode check meets.
  replace: () => replaceFiles(),
  // B172: the project at `path` deleted as the instance deletes one: its rows and its directory.
  delete: () => {
    const slug = basename(path!);
    const db = new Database(instanceDatabase());
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.transaction(() => {
        db.query("DELETE FROM hostnames WHERE project = ?").run(slug);
        db.query("DELETE FROM projects WHERE slug = ?").run(slug);
      })();
    } finally {
      db.close();
    }
    rmSync(path!, { recursive: true, force: true });
  },
  // D201: the project's directory, or only its database file, moved away while instance.db still
  // lists it, and nothing put in its place.
  moveaway: () => renameSync(path!, `${path!}.moved`),
  movedb: () => renameSync(join(path!, "iglo-email.db"), join(path!, "moved.db")),
  claim: () => {
    rmSync(path!, { recursive: true, force: true });
    mkdirSync(path!);
    writeFileSync(join(path!, "precious.txt"), "someone else's");
  },
};
// `seal:<action>` runs the action before a project's snapshot is sealed instead (B172), once.
const sealing = action!.startsWith("seal:");
const name = sealing ? action!.slice("seal:".length) : action!;
let ran = false;
const once = () => {
  if (!ran) {
    ran = true;
    actions[name]!();
  }
};
try {
  runBackup(args, process.env, sealing ? { beforeSeal: once } : { beforePublish: once });
} catch (error) {
  console.error(asBody<Error>(error).message);
  process.exitCode = 1;
}
