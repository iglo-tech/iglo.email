// The instance data directory's layout (14-projects section 1, D142). Native: listmonk keeps no
// data directory. The paths are fixed: only `--data-dir` is configurable.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The instance database at the data directory's root. */
export const INSTANCE_DATABASE = "instance.db";
/** A project database's file name, inside its directory, as before projects. */
export const PROJECT_DATABASE = "iglo-email.db";
/** Where every project directory lives. */
export const PROJECTS = "projects";

export function projectDirectory(dataDir: string, slug: string): string {
  return join(dataDir, PROJECTS, slug);
}

/** Pre-migration snapshots of the instance database and of every project. */
export function preMigrationDirectory(dataDir: string): string {
  return join(dataDir, "backups", "pre-migration");
}

/** An earlier iglo.email's data directory: its database at the root. */
export function usesOldLayout(dataDir: string): boolean {
  return existsSync(join(dataDir, PROJECT_DATABASE));
}

/** The one message for an earlier layout. Nothing converts it (owner, 2026-11-23). */
export function oldLayoutMessage(dataDir: string): string {
  return (
    `${dataDir} is a data directory from an earlier iglo.email: it has ${PROJECT_DATABASE} at its root. ` +
    `The data directory layout changed and nothing is converted; start with an empty data directory. ` +
    `An earlier backup is restored into projects/main/ of the new data directory.`
  );
}
