// The PocketBase test binary (15-external-sources section 8, D169, D170): the official 0.40.5
// release for this machine's Linux architecture, checked against a pinned SHA-256 and cached in
// node_modules/.cache/ (test-excluded, so Bun's test discovery never walks it). A test tool only:
// the shipped executable gains no dependency. Run directly (`bun run pocketbase:download`) to fetch
// it ahead of the tests, as CI does.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

export const POCKETBASE_VERSION = "0.40.5";

/** The release archives' SHA-256, from the release's checksums.txt (2026-11-25). */
const archives: Record<string, { name: string; sha256: string }> = {
  x64: {
    name: `pocketbase_${POCKETBASE_VERSION}_linux_amd64.zip`,
    sha256: "1dbea1b01eb3dfe64953513859d01e759c96650c4e3264fa4eecd54b769382e4",
  },
  arm64: {
    name: `pocketbase_${POCKETBASE_VERSION}_linux_arm64.zip`,
    sha256: "570baa1c45d2fb92fc0073582b945ca0ece03cbf9837ccabf49a222f99dd02e3",
  },
};

const root = join(import.meta.dir, "..", "..");
const cacheDir = join(root, "node_modules", ".cache", `pocketbase-${POCKETBASE_VERSION}`);

/** One file of a zip archive, read through its central directory. */
function unzipEntry(archive: Uint8Array, wanted: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = archive.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06_05_4b_50) {
    end--;
  }
  if (end < 0) {
    throw new Error("PocketBase archive: no end of central directory");
  }
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02_01_4b_50) {
      throw new Error("PocketBase archive: bad central directory");
    }
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (name === wanted) {
      const dataAt =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = archive.subarray(dataAt, dataAt + compressed);
      if (method === 0) {
        return data;
      }
      if (method === 8) {
        return inflateRawSync(data);
      }
      throw new Error(`PocketBase archive: unsupported compression ${method}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`PocketBase archive: no ${wanted}`);
}

/**
 * The cached binary's path, downloading and verifying it first when it is missing. Concurrent
 * callers (parallel test workers) each write their own temporary file and rename it into place, so
 * a half-written binary is never run.
 */
export async function pocketBaseBinary(): Promise<string> {
  const binary = join(cacheDir, "pocketbase");
  if (existsSync(binary)) {
    return binary;
  }
  if (process.platform !== "linux") {
    throw new Error("The PocketBase test binary is pinned for Linux only (D89)");
  }
  const archive = archives[process.arch];
  if (!archive) {
    throw new Error(`No pinned PocketBase archive for ${process.arch}`);
  }
  const url = `https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/${archive.name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`PocketBase download failed: ${response.status} ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== archive.sha256) {
    throw new Error(`PocketBase archive checksum mismatch: ${digest}, expected ${archive.sha256}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const temporary = join(cacheDir, `pocketbase.${process.pid}.${crypto.randomUUID()}`);
  try {
    writeFileSync(temporary, unzipEntry(bytes, "pocketbase"));
    chmodSync(temporary, 0o755);
    renameSync(temporary, binary);
  } finally {
    rmSync(temporary, { force: true });
  }
  return binary;
}

if (import.meta.main) {
  console.log(await pocketBaseBinary());
}
