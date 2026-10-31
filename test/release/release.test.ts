import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "@/../package.json";

const repository = resolve(import.meta.dir, "../..");
const executable = join(repository, "dist/iglo.email");
setDefaultTimeout(30_000);
let temporaryDirectory = "";

async function run(command: string[], env: Record<string, string> = {}, cwd = repository) {
  const child = Bun.spawn(command, {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const script = (...args: string[]) => [process.execPath, "scripts/release.ts", ...args];

beforeAll(async () => {
  const build = await run([process.execPath, "run", "build"]);
  if (build.code !== 0) throw new Error(`Build failed:\n${build.stdout}\n${build.stderr}`);
  temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-release-test-"));
}, 60_000);

afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("--version", () => {
  test("prints the package version and touches nothing", async () => {
    const directory = join(temporaryDirectory, "version");
    await Bun.write(join(directory, ".keep"), "");
    for (const args of [["--version"], ["serve", "--version"]]) {
      const result = await run([executable, ...args], { PATH: "" }, directory);
      expect(result).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
    }
    expect(await readdir(directory)).toEqual([".keep"]);
  });

  test("is listed in the help", async () => {
    expect((await run([executable, "--help"])).stdout).toContain("--version");
  });

  test("takes no value", async () => {
    const result = await run([executable, "--version=1"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown flag: --version");
  });
});

describe("release verify", () => {
  test("passes on a tag that matches and on a dry run", async () => {
    for (const env of [
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${version}` },
      { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
    ]) {
      const result = await run(script("verify", executable), env);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }
  });

  test("fails when the tag and the reported version disagree", async () => {
    const result = await run(script("verify", executable), {
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v9.9.9",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Reported version");
  });

  test("fails on an executable that reports the version but does not serve", async () => {
    const fake = join(temporaryDirectory, "fake");
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    await chmod(fake, 0o755);
    const result = await run(script("verify", fake));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Server exited");
  });
});

describe("release package", () => {
  test("writes the executable, notices and checksums, and nothing else", async () => {
    const output = join(temporaryDirectory, "release");
    const result = await run(script("package", executable, output));
    expect(result.code).toBe(0);
    expect((await readdir(output)).sort()).toEqual([
      "LICENSE",
      "SHA256SUMS",
      "THIRD-PARTY-NOTICES.txt",
      "iglo.email-linux-x64",
    ]);

    const checked = await run(["sha256sum", "--check", "--strict", "SHA256SUMS"], {}, output);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("iglo.email-linux-x64: OK");

    expect((await run([join(output, "iglo.email-linux-x64"), "--version"])).stdout).toBe(
      `${version}\n`,
    );
    expect(await Bun.file(join(output, "LICENSE")).text()).toContain("AFFERO GENERAL PUBLIC");
    const notices = await Bun.file(join(output, "THIRD-PARTY-NOTICES.txt")).text();
    expect(notices).toContain(`/tree/v${version}`);
    expect(notices).toContain("JavaScriptCore");
    expect(notices).toContain("liquidjs@");
    expect(notices).toContain("alpinejs@");
  });
});
