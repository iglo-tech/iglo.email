// Invariant 9 of 14-projects section 14 (B149e, D168): no new runtime dependency. The runtime
// dependencies the package manifest installs are exactly the packages the design's dependency
// table lists (02-architecture.md "Dependencies"); a package added to either alone fails here.
// Built-in APIs in the table (`Bun.markdown`) are not packages. Dev dependencies are build and test
// tools, bundled into browser assets or not shipped, and are not checked.
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { asBody } from "@/test/read-body";

const repository = resolve(import.meta.dir, "../..");

interface Manifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}

/** The packages named in the first column of the design's dependency table. */
async function designed(): Promise<Array<string>> {
  const design = await Bun.file(join(repository, "docs/design/02-architecture.md")).text();
  const start = design.indexOf("\n## Dependencies\n");
  const end = design.indexOf("\n## ", start + 1);
  const section = start < 0 ? "" : design.slice(start, end < 0 ? undefined : end);
  const names = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].flatMap((match) =>
    match[1] && !match[1].startsWith("Bun.") ? [match[1]] : [],
  );
  return names.sort();
}

test("the runtime dependencies are exactly the design's list", async () => {
  const listed = await designed();
  // The table is found and read: a renamed heading must not make this pass on an empty list.
  expect(listed).toContain("liquidjs");
  const manifest = asBody<Manifest>(await Bun.file(join(repository, "package.json")).json());
  expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(listed);
  // No other field installs a package at run time.
  expect(manifest.optionalDependencies).toBeUndefined();
  expect(manifest.peerDependencies).toBeUndefined();
  expect(manifest.bundleDependencies).toBeUndefined();
  expect(manifest.bundledDependencies).toBeUndefined();
});
