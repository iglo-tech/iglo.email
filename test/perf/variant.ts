// Which code a measurement ran: the commit, a hash of the source files as they stand in the working
// tree (so an uncommitted "before" or "after" variant is told apart), and the executable's hash.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function git(repository: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout;
}

export function variantIdentity(repository: string, executable: string) {
  const files = git(repository, [
    "ls-files",
    "-z",
    "--",
    "src",
    "migrations",
    "package.json",
    "bun.lock",
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  const tree = createHash("sha256");
  for (const file of files) {
    let content: Uint8Array;
    try {
      content = readFileSync(join(repository, file));
    } catch {
      continue; // listed in the index but removed in the working tree
    }
    tree.update(`${file}\0${sha256(content)}\n`);
  }
  return {
    variant: process.env.PERF_VARIANT ?? null,
    commit: git(repository, ["rev-parse", "HEAD"]).toString().trim(),
    sourceSha256: tree.digest("hex"),
    sourceFiles: files.length,
    executableSha256: sha256(readFileSync(executable)),
  };
}
