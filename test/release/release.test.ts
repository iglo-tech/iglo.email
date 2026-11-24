import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureProductionBuild } from "@/test/production-build";
import { healthWhenReady, startOnFreePort } from "@/test/serve-port";
import { version } from "@/../package.json";

const repository = resolve(import.meta.dir, "../..");
const executable = join(repository, "dist/iglo.email");
setDefaultTimeout(30_000);
let temporaryDirectory = "";

async function run(command: Array<string>, env: Record<string, string> = {}, cwd = repository) {
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

const name = `iglo.email-linux-${process.arch}`;
const script = (...args: Array<string>) => [process.execPath, "scripts/release.ts", ...args];

beforeAll(async () => {
  await ensureProductionBuild();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-release-test-"));
}, 60_000);

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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

// scripts/release.ts runs on Linux only (D89), so every case of these two describes is Linux-only.
describe.skipIf(process.platform !== "linux")("release verify", () => {
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

  // The executable binds the port it names (D144), so a port that another server holds cannot stop
  // the start. The plain holder answers /health exactly as iglo.email does; the start still
  // succeeds, because the answer that counts is the one from the process that named its port.
  test("passes while a plain HTTP server holds a fixed port", async () => {
    const holder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response('{"data":true}\n'),
    });
    try {
      const result = await run(script("verify", executable), {
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "main",
      });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    } finally {
      await holder.stop(true);
    }
  });

  // A port in use is no longer a race between two starts, since the child chooses its port (D144):
  // a start that reports one fails once, with the child's own message, and no second start follows.
  // Mutation: the five-attempt retry back in the script, and "after 5 attempts" is in the message.
  test("fails at once, with the child's message, when its port is in use", async () => {
    const fake = join(temporaryDirectory, "port-in-use");
    await writeFile(
      fake,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi\nprintf '%s\\n' 'listen: port 4242 in use' >&2\nexit 1\n`,
    );
    await chmod(fake, 0o755);
    const result = await run(script("verify", fake), {
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("port 4242 in use");
    expect(result.stderr).not.toContain("attempts");
  });

  // The script reads the port from the child's line and checks that the child listens on it. The
  // fake names port 1, where nothing listens, and then stays alive: the start must fail on that
  // port, not on a port the script chose itself. Mutation: the script ignores the named port and
  // starts its own check on another port, and the message no longer names port 1.
  test("fails when the port the server names is not one it listens on", async () => {
    const fake = join(temporaryDirectory, "names-another-port");
    await writeFile(
      fake,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi\nprintf '%s\\n' 'listening on port 1'\nexec sleep 30\n`,
    );
    await chmod(fake, 0o755);
    const result = await run(script("verify", fake), {
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("port 1");
  });

  test("passes while another iglo.email server holds a fixed port", async () => {
    const directory = join(temporaryDirectory, "holder");
    await Bun.write(join(directory, ".keep"), "");
    const holder = await startOnFreePort(async (port) => {
      const child = Bun.spawn([executable, "serve", "--port", String(port)], {
        cwd: directory,
        env: { PATH: "" },
        stdout: "ignore",
        stderr: "pipe",
      });
      try {
        await healthWhenReady(child, port);
        return { child, port };
      } catch (error) {
        child.kill("SIGKILL");
        await child.exited;
        throw error;
      }
    });
    try {
      const result = await run(script("verify", executable), {
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "main",
      });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    } finally {
      holder.child.kill("SIGTERM");
      await holder.child.exited;
    }
  });
});

describe.skipIf(process.platform !== "linux")("release package", () => {
  test("writes the executable, notices and checksums, and nothing else", async () => {
    const output = join(temporaryDirectory, "release");
    const result = await run(script("package", executable, output));
    expect(result.code).toBe(0);
    expect((await readdir(output)).sort()).toEqual([
      "LICENSE",
      "SHA256SUMS",
      "THIRD-PARTY-NOTICES.txt",
      name,
    ]);

    const checked = await run(["sha256sum", "--check", "--strict", "SHA256SUMS"], {}, output);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain(`${name}: OK`);

    expect((await run([join(output, name), "--version"])).stdout).toBe(`${version}\n`);
    expect(await Bun.file(join(output, "LICENSE")).text()).toContain("AFFERO GENERAL PUBLIC");
    const notices = await Bun.file(join(output, "THIRD-PARTY-NOTICES.txt")).text();
    expect(notices).toContain(`/tree/v${version}`);
    expect(notices).toContain("JavaScriptCore");
    expect(notices).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(notices).toContain("Version 2.1, February 1999");
    expect(notices).toContain("tree/bun-v1.4.5");
    expect(notices).toContain("d6375c72affe0f70222cdcb45012b10f0bf3a9d5");
    expect(notices).toContain("SIL OPEN FONT LICENSE");
    expect(notices).toContain("liquidjs@");
    expect(notices).toContain("alpinejs_csp@");
  });
});
