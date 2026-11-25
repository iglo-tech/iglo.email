// The project registry in instance.db (14-projects sections 1 and 3, D142, D151). Native: listmonk
// serves one database per process. This module owns the `projects` and `hostnames` tables; nothing
// else reads them.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import { must } from "@/invariant";
import {
  INSTANCE_DATABASE,
  oldLayoutMessage,
  projectDirectory,
  usesOldLayout,
} from "@/projects/layout";

/** A project's permanent ID and directory name ("Terms"). */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface ProjectRecord {
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
  readonly primary: boolean;
  /** The main hostname, used for every new link and Message-ID. */
  readonly hostname: string;
  /** Other hostnames that serve the project; never used for new links. */
  readonly extra: ReadonlyArray<string>;
}

/** A rename and the new list of extra hostnames; a field left out keeps its value. */
export interface ProjectChange {
  readonly name?: string | undefined;
  readonly extra?: ReadonlyArray<string> | undefined;
}

/**
 * A refused or failed lifecycle change, with the HTTP status the instance API answers it with: 400
 * for input that is invalid, 404 for a slug no project has, 409 for one that conflicts with another
 * project, 500 for a delete that stopped part way (B149a: delete it again to finish), 503 for a
 * create during shutdown.
 */
export class RegistryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** The longest project name. */
export const NAME_MAX = 200;

/** A project's name as stored: trimmed, not empty, at most NAME_MAX characters, one line. */
export function projectName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new RegistryError(400, "A project needs a name");
  }
  if (
    name.length > NAME_MAX ||
    Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    throw new RegistryError(400, `A project name is one line of at most ${NAME_MAX} characters`);
  }
  return name;
}

export interface NewProject {
  readonly slug: string;
  readonly name: string;
  readonly hostname: string;
  readonly primary?: boolean;
  readonly extra?: ReadonlyArray<string>;
}

/**
 * A hostname as stored and looked up: lowercase, without a port. It must be a bare host: no port,
 * path, user or query. IPv6 keeps its brackets, as URL.hostname writes it.
 */
export function normalizeHostname(value: string): string {
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    throw new RegistryError(400, `Invalid hostname: ${value}`);
  }
  if (
    !value ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname !== value.toLowerCase()
  ) {
    throw new RegistryError(400, `Invalid hostname: ${value}`);
  }
  return url.hostname;
}

/** The hostname a request's Host header names, lowercase and without its port; "" if it has none. */
export function requestHostname(host: string | null): string {
  if (!host) {
    return "";
  }
  try {
    const url = new URL(`http://${host}`);
    return url.username || url.password || url.pathname !== "/" ? "" : url.hostname;
  } catch {
    return "";
  }
}

interface ProjectRow {
  slug: string;
  name: string;
  created_at: string;
  is_primary: bigint;
}

interface HostnameRow {
  hostname: string;
  project: string;
  kind: "main" | "extra";
}

export type Registry = ReturnType<typeof createRegistry>;

/** The registry over an open, migrated instance database. */
export function createRegistry(db: Database, clock: Clock) {
  const projects = db.query<ProjectRow, []>(
    "SELECT slug, name, created_at, is_primary FROM projects ORDER BY slug",
  );
  const hostnames = db.query<HostnameRow, []>(
    "SELECT hostname, project, kind FROM hostnames ORDER BY hostname",
  );
  const holder = db.query<{ project: string }, [string]>(
    "SELECT project FROM hostnames WHERE hostname = ?",
  );
  const insertProject = db.query<null, [string, string, string, bigint]>(
    "INSERT INTO projects (slug, name, created_at, is_primary) VALUES (?, ?, ?, ?)",
  );
  const insertHostname = db.query<null, [string, string, string]>(
    "INSERT INTO hostnames (hostname, project, kind) VALUES (?, ?, ?)",
  );
  const deleteProject = db.query<null, [string]>("DELETE FROM projects WHERE slug = ?");
  const updateMain = db.query<null, [string, string]>(
    "UPDATE hostnames SET hostname = ? WHERE project = ? AND kind = 'main'",
  );
  const renameProject = db.query<null, [string, string]>(
    "UPDATE projects SET name = ? WHERE slug = ?",
  );
  const deleteExtra = db.query<null, [string]>(
    "DELETE FROM hostnames WHERE project = ? AND kind = 'extra'",
  );

  function list(): Array<ProjectRecord> {
    const hosts = hostnames.all();
    return projects.all().map((row) => ({
      slug: row.slug,
      name: row.name,
      createdAt: row.created_at,
      primary: row.is_primary === 1n,
      hostname: hosts.find((h) => h.project === row.slug && h.kind === "main")?.hostname ?? "",
      extra: hosts
        .filter((h) => h.project === row.slug && h.kind === "extra")
        .map((h) => h.hostname),
    }));
  }

  return {
    list,
    /**
     * Registers a project and its hostnames in one transaction. A slug, a hostname held by any
     * project, or a second primary is refused with nothing written.
     */
    add(input: NewProject): ProjectRecord {
      if (!SLUG_PATTERN.test(input.slug)) {
        throw new RegistryError(400, `Invalid project slug: ${input.slug}`);
      }
      const name = projectName(input.name);
      const main = normalizeHostname(input.hostname);
      const extra = (input.extra ?? []).map(normalizeHostname);
      const all = [main, ...extra];
      if (new Set(all).size !== all.length) {
        throw new RegistryError(400, "A hostname is listed twice");
      }
      writeTransaction(db, () => {
        if (list().some((p) => p.slug === input.slug)) {
          throw new RegistryError(409, `A project named ${input.slug} exists`);
        }
        if (input.primary && list().some((p) => p.primary)) {
          throw new RegistryError(409, "There is a primary project already");
        }
        for (const hostname of all) {
          if (holder.get(hostname)) {
            throw new RegistryError(409, `The hostname ${hostname} belongs to another project`);
          }
        }
        insertProject.run(input.slug, name, clock.now().toISOString(), input.primary ? 1n : 0n);
        insertHostname.run(main, input.slug, "main");
        for (const hostname of extra) {
          insertHostname.run(hostname, input.slug, "extra");
        }
      });
      return must(
        list().find((p) => p.slug === input.slug),
        "registered project",
      );
    },
    /**
     * Renames a project and replaces its extra hostnames in one transaction (14-projects section
     * 10). The slug and the main hostname never change. A hostname another project holds, or one
     * listed twice, is refused with nothing written.
     */
    update(slug: string, change: ProjectChange): ProjectRecord {
      const current = list().find((p) => p.slug === slug);
      if (!current) {
        throw new RegistryError(404, `No project ${slug}`);
      }
      const name = change.name === undefined ? current.name : projectName(change.name);
      const extra =
        change.extra === undefined ? [...current.extra] : change.extra.map(normalizeHostname);
      const all = [current.hostname, ...extra];
      if (new Set(all).size !== all.length) {
        throw new RegistryError(400, "A hostname is listed twice");
      }
      writeTransaction(db, () => {
        for (const hostname of extra) {
          const owner = holder.get(hostname)?.project;
          if (owner !== undefined && owner !== slug) {
            throw new RegistryError(409, `The hostname ${hostname} belongs to another project`);
          }
        }
        renameProject.run(name, slug);
        deleteExtra.run(slug);
        for (const hostname of extra) {
          insertHostname.run(hostname, slug, "extra");
        }
      });
      return must(
        list().find((p) => p.slug === slug),
        "updated project",
      );
    },
    /** Removes a project's rows, its hostnames with it. Returns whether it was registered. */
    remove(slug: string): boolean {
      return writeTransaction(db, () => deleteProject.run(slug).changes > 0);
    },
    /**
     * Points the primary project's main hostname at the instance host (D151: the primary follows
     * `--root-url`, as a single install's links always have). Refused when another project holds it.
     */
    followInstanceHost(hostname: string): void {
      const host = normalizeHostname(hostname);
      writeTransaction(db, () => {
        const primary = list().find((p) => p.primary);
        if (!primary || primary.hostname === host) {
          return;
        }
        const owner = holder.get(host)?.project;
        if (owner !== undefined && owner !== primary.slug) {
          throw new Error(
            `The instance host ${host} is a hostname of project ${owner}, not of the primary project`,
          );
        }
        if (owner === primary.slug) {
          // An extra hostname of the primary becomes its main one.
          db.run("DELETE FROM hostnames WHERE hostname = ?", [host]);
        }
        updateMain.run(host, primary.slug);
      });
    },
    close(): void {
      for (const statement of [
        projects,
        hostnames,
        holder,
        insertProject,
        insertHostname,
        deleteProject,
        updateMain,
        renameProject,
        deleteExtra,
      ]) {
        statement.finalize();
      }
    },
  };
}

/**
 * The primary project's directory, for the commands that act on a stopped server (backup,
 * reset-password, reset-totp) until they learn about projects (B140, B144). Read-only: it writes
 * nothing, so a missing instance is reported as a missing database.
 */
export function primaryProjectDirectory(dataDir: string): string {
  const root = resolve(dataDir);
  if (usesOldLayout(root)) {
    throw new Error(oldLayoutMessage(root));
  }
  const path = join(root, INSTANCE_DATABASE);
  if (!existsSync(path)) {
    throw new Error(`No database at ${path}`);
  }
  const db = new Database(path, {
    readonly: true,
    strict: true,
    safeIntegers: true,
  });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const exists = db
      .query<{ found: bigint }, []>(
        "SELECT count(*) AS found FROM sqlite_schema WHERE type = 'table' AND name = 'projects'",
      )
      .get();
    const primary =
      exists?.found === 1n
        ? db.query<{ slug: string }, []>("SELECT slug FROM projects WHERE is_primary = 1").get()
        : null;
    if (!primary) {
      throw new Error(`${root} has no primary project`);
    }
    return projectDirectory(root, primary.slug);
  } finally {
    db.close();
  }
}
