// A sends script's own directory under $TMPDIR, and the check that the run left nothing beside it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTANCE_FILES = ["instance.db", "instance.db-wal", "instance.db-shm"];

function instanceFilesInTmpdir() {
  return INSTANCE_FILES.filter((name) => existsSync(join(tmpdir(), name)));
}

// The producer's directory is a project's, and it opens the instance database two levels above it
// (`<data>/projects/main`, as a server's data directory is laid out). Each scenario's data directory
// is inside the run's own directory, so no run writes beside it in $TMPDIR or shares another run's
// instance database and SMTP key (D183).
export async function runDirectory(prefix: string) {
  const before = instanceFilesInTmpdir();
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return {
    directory,
    projectDirectory: (scenario: string) => join(directory, scenario, "projects", "main"),
    // Call after the run's directory is removed.
    assertNothingLeft() {
      assert.deepEqual(
        instanceFilesInTmpdir(),
        before,
        `the run left an instance database in ${tmpdir()}`,
      );
      assert.equal(existsSync(directory), false, `the run left ${directory}`);
    },
  };
}
