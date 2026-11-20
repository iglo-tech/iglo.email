// Every contract, messaging, sends, templates, reference and server script is run by a workflow
// step, or is excluded here with a reason (B122). The workflow files and package.json are read as
// configuration data, not as implementation.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import packageJson from "@/../package.json";

const repository = resolve(import.meta.dir, "../..");
const workflows = ["ci.yml", "release.yml"];
const family = /^(contract|messaging|sends|templates|reference|server):/;
const scripts: Record<string, string> = packageJson.scripts;

/** Family scripts no workflow runs, each with the reason. Empty: every script is wired (B122). */
const excluded: Record<string, string> = {};

/** Each `bun run <script>` a workflow step runs, with the workflows that run it. */
async function workflowRuns(): Promise<Map<string, Set<string>>> {
  const runs = new Map<string, Set<string>>();
  for (const file of workflows) {
    const text = await Bun.file(resolve(repository, ".github/workflows", file)).text();
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      for (const [, name] of line.matchAll(/bun run ([\w:.-]+)/g)) {
        if (!runs.has(name!)) runs.set(name!, new Set());
        runs.get(name!)!.add(file);
      }
    }
  }
  return runs;
}

test("every family script is run by a workflow step or excluded with a reason", async () => {
  const runs = await workflowRuns();
  const names = Object.keys(scripts).filter((name) => family.test(name));
  expect(names.length).toBeGreaterThan(0);
  const unwired = names.filter((name) => !runs.has(name) && !(name in excluded));
  expect(unwired).toEqual([]);
});

test("an exclusion names an existing script, gives a reason and is not also run", async () => {
  const runs = await workflowRuns();
  for (const [name, reason] of Object.entries(excluded)) {
    expect(name in scripts).toBe(true);
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(runs.has(name)).toBe(false);
  }
});

test("every script a workflow runs exists in package.json", async () => {
  const runs = await workflowRuns();
  const unknown = [...runs.keys()].filter((name) => !(name in scripts));
  expect(unknown).toEqual([]);
});
