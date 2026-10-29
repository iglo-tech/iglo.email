import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { command } from "@/test/reference/command";

export const repository = resolve(import.meta.dir, "../..");
export const cache = join(repository, "upstream", "reference");
export const sourceCommit = "6fcd95f32bb633d3a62a06c383c0b3322eecc898";
// Bun excludes hidden directories from ordinary test discovery.
const source = join(cache, ".listmonk-source");

const platforms = {
  "linux-x64": [
    "linux",
    "amd64",
    "78e7795fbe75a8114ba161df62c19851ce6681d750681160f6da65a631a66c4b",
    "4b5993c978e8604c70d43927e2ad103b311bba3b1822fa0cf1d4ee4ec890a93c",
  ],
  "linux-arm64": [
    "linux",
    "arm64",
    "c2b1ce59e76d5e225211ee7f87e28d3358b0601b60d52ebafc1dd33f2fbef827",
    "e1e45d1dc72bd497fb262a1e4100178eee057c42c5fc36d143eb8621769e1137",
  ],
  "darwin-x64": [
    "darwin",
    "amd64",
    "16655c302d6ce8e69ef71c64d6d8d688206a38a748bd37b8286cdb355ec72ec5",
    "d7f3d0964cd2ea4c2a7d10660a12e02876718e67d88ced390d9cd90350a453da",
  ],
  "darwin-arm64": [
    "darwin",
    "arm64",
    "af3d2f12daa0893c5864b0bb1c95541319b026b502be552e949f0af03a9fff2d",
    "23709bd727f20da2290de6a2a40c4685c48a3127586d77370efd1a3a595f9ef6",
  ],
} as const;

function hash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function regularFile(path: string): Promise<Uint8Array> {
  if (!(await lstat(path)).isFile()) throw new Error(`Cache entry is not a regular file: ${path}`);
  return readFile(path);
}

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await command(["git", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cache,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function verifySource(signal?: AbortSignal) {
  if (!(await lstat(source)).isDirectory())
    throw new Error(`Source cache is not a directory: ${source}`);
  const head = await git(["rev-parse", "HEAD"], source, signal);
  const changes = await git(["status", "--porcelain", "--untracked-files=all"], source, signal);
  if (head !== sourceCommit || changes)
    throw new Error(`Source cache is not clean at ${sourceCommit}: ${source}`);
}

async function prepareSource(signal?: AbortSignal) {
  if (!(await exists(source))) {
    const temp = await mkdtemp(join(cache, ".source-"));
    try {
      await git(["init", "--quiet"], temp, signal);
      await git(
        [
          "-c",
          "protocol.version=2",
          "fetch",
          "--quiet",
          "--depth=1",
          "https://github.com/knadh/listmonk.git",
          sourceCommit,
        ],
        temp,
        signal,
      );
      await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], temp, signal);
      const head = await git(["rev-parse", "HEAD"], temp, signal);
      if (head !== sourceCommit) throw new Error("Fetched listmonk source has the wrong commit");
      // Reserve the destination exclusively. Rename can then only replace the
      // empty directory we just created, never an existing checkout.
      try {
        await mkdir(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(`Source cache appeared during preparation: ${source}`);
        throw error;
      }
      try {
        await rename(temp, source);
      } catch (error) {
        await rmdir(source).catch(() => {});
        throw error;
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  await verifySource(signal);
}

async function prepareArchive(
  archiveName: string,
  url: string,
  expected: string,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: Uint8Array }> {
  const archivePath = join(cache, archiveName);
  if (!(await exists(archivePath))) {
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`Download failed for ${archiveName}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (hash(bytes) !== expected)
      throw new Error(`Downloaded archive checksum mismatch: ${archiveName}`);
    try {
      await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const archive = await regularFile(archivePath);
  if (hash(archive) !== expected)
    throw new Error(`Cached archive checksum mismatch: ${archivePath}`);
  return { path: archivePath, bytes: archive };
}

async function prepareBinary(
  name: string,
  archiveName: string,
  url: string,
  expected: string,
  signal?: AbortSignal,
): Promise<string> {
  const { bytes: archive } = await prepareArchive(archiveName, url, expected, signal);
  const files = await new Bun.Archive(archive).files();
  const entries = [...files.entries()].filter(([path]) => path === name || path === `./${name}`);
  if (entries.length !== 1) throw new Error(`Expected one ${name} executable in ${archiveName}`);
  const executable = new Uint8Array(await entries[0]![1].arrayBuffer());
  const binaryPath = join(cache, `${archiveName}-${name}`);
  try {
    await writeFile(binaryPath, executable, { flag: "wx", mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (hash(await regularFile(binaryPath)) !== hash(executable))
    throw new Error(`Cached executable differs from verified archive: ${binaryPath}`);
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

export async function prepare(signal?: AbortSignal) {
  const key = `${process.platform}-${process.arch}` as keyof typeof platforms;
  const platform = platforms[key];
  if (!platform)
    throw new Error(
      `Unsupported platform ${process.platform}/${process.arch}; supported: Linux and macOS x64/arm64`,
    );
  const [os, arch, listHash, mailHash] = platform;
  await mkdir(cache, { recursive: true });
  await prepareSource(signal);
  const listArchive = `listmonk_7.0.0-beta.1_${os}_${arch}.tar.gz`;
  const mailArchive = `mailpit-${os}-${arch}.tar.gz`;
  const listmonk = await prepareBinary(
    "listmonk",
    listArchive,
    `https://github.com/knadh/listmonk/releases/download/v7.0.0-beta.1/${listArchive}`,
    listHash,
    signal,
  );
  const mailpit = await prepareBinary(
    "mailpit",
    mailArchive,
    `https://github.com/axllent/mailpit/releases/download/v1.32.0/${mailArchive}`,
    mailHash,
    signal,
  );
  const { path: zoneinfo } = await prepareArchive(
    "go1.27.2-zoneinfo.zip",
    "https://raw.githubusercontent.com/golang/go/go1.27.2/lib/time/zoneinfo.zip",
    "b2d18a7c8fa8142097a48c99609fb3c92db5ee98bc740294e57eab8ae9f94779",
    signal,
  );
  for (const [binary, args, expectedVersion] of [
    [listmonk, ["--version"], "v7.0.0-beta.1"],
    [mailpit, ["version", "--no-release-check"], "1.32.0"],
  ] as const) {
    const result = await command([binary, ...args], {
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "", HOME: cache },
      ...(signal ? { signal } : {}),
    });
    const version = `${result.stdout} ${result.stderr}`.trim();
    if (result.code !== 0 || !version.includes(expectedVersion))
      throw new Error(`Unexpected ${binary} version: ${version}`);
    console.log(`${binary === listmonk ? "listmonk" : "Mailpit"}: ${version}`);
  }
  console.log(`listmonk source: ${sourceCommit}`);
  return { listmonk, mailpit, source, zoneinfo };
}

if (import.meta.main) {
  try {
    await prepare();
  } catch (error) {
    console.error(`reference:prepare: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
