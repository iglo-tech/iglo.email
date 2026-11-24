// What the server does with an upload directory it finds at startup.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listensOn, startOnFreePort } from "@/test/serve-port";
import { untilState } from "@/test/wait";

// A 15 s stall fails by name before this timeout, not after a single-file run's 5 s default.
setDefaultTimeout(30_000);

const repository = resolve(import.meta.dir, "../..");
const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "iglo-startup-"));
  directories.push(directory);
  return directory;
}
function serve(dataDir: string, port: number) {
  const child = Bun.spawn(
    [
      process.execPath,
      "src/main.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
    ],
    {
      cwd: repository,
      env: {
        PATH: process.env.PATH ?? "",
        IGLO_EMAIL_ADMIN_USER: "fixture-admin",
        IGLO_EMAIL_ADMIN_PASSWORD: "fixture-admin-password",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  return { child, origin: `http://127.0.0.1:${port}` };
}
/** Started and stopped: the startup work is done by the first healthy answer. */
async function bootOnce(dataDir: string) {
  return startOnFreePort((port) => bootAt(dataDir, port));
}

async function bootAt(dataDir: string, port: number) {
  const { child, origin } = serve(dataDir, port);
  try {
    // Ready, or exited (reported below); the wait ends at its 15 s stall, as the old deadline did.
    await untilState(
      async () => {
        if (child.exitCode !== null) {
          return true;
        }
        const up = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) }).catch(
          () => null,
        );
        return Boolean(up?.ok && listensOn(child.pid, port));
      },
      {
        label: "media startup",
        progress: () => String(child.exitCode),
        stallMs: 15_000,
        intervalMs: 25,
      },
    ).catch(() => undefined);
    if (child.exitCode !== null) {
      throw new Error(await new Response(child.stderr).text());
    }
  } finally {
    child.kill();
    await child.exited;
  }
  return new Response(child.stderr).text();
}

test("a root that leaves the data directory refuses media and stops nothing else", async () => {
  const base = temporary();
  const data = join(base, "data");
  const elsewhere = join(base, "elsewhere");
  mkdirSync(data);
  const stale = join(elsewhere, ".iglo-email-uploading", crypto.randomUUID());
  await Bun.write(stale, "x");
  symlinkSync(elsewhere, join(data, "uploads"));
  const reason = await bootOnce(data);
  expect(reason).toContain("data directory");
  expect(existsSync(stale)).toBe(true);
});

test("the startup sweep removes its own temporary files and leaves the rest alone", async () => {
  const data = temporary();
  const uploads = join(data, "uploads");
  const own = join(uploads, ".iglo-email-uploading");
  const stale = join(own, crypto.randomUUID());
  const operator = [
    join(uploads, ".tmp/operator-owned"),
    join(uploads, "operator/keep.txt"),
    join(own, "operator-owned"),
    join(own, crypto.randomUUID(), "nested.txt"),
  ];
  for (const path of [stale, ...operator]) {
    await Bun.write(path, "x");
  }
  await bootOnce(data);
  expect(existsSync(stale)).toBe(false);
  for (const path of operator) {
    expect({ path, kept: existsSync(path) }).toEqual({ path, kept: true });
  }
});
