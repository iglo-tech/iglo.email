// Shared result recording for the M6.1 measurements (docs/perf/M6.1-performance.md): each record
// carries the commit, a hash of the measured source and, for compiled runs, of the executable.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const repository = resolve(import.meta.dir, "../../..");
// M6.1 records stay in M6.1-results.jsonl; M6.1b appends to its own file.
export const resultsFile = join(repository, "docs/perf/M6.1b-results.jsonl");

/** Durable measurement directory (never tmpfs/ramfs, which also keeps /tmp free). */
export function measurementBase() {
  const base = resolve(
    process.env.IGLO_EMAIL_PERF_DIR ?? join(repository, "upstream/measurements"),
  );
  mkdirSync(base, { recursive: true });
  const fsType = Bun.spawnSync(["stat", "-f", "-c", "%T", base]).stdout.toString().trim();
  if (/tmpfs|ramfs/.test(fsType)) throw new Error(`Refusing ${fsType} measurement directory`);
  return base;
}

const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: repository })
    .stdout.toString()
    .trim();

/** SHA-256 over every tracked file under src/ and migrations/ as it is on disk now. */
export function sourceHash() {
  const hash = createHash("sha256");
  for (const file of git("ls-files", "src", "migrations").split("\n").sort()) {
    hash.update(file + "\0");
    hash.update(readFileSync(join(repository, file)));
  }
  return hash.digest("hex").slice(0, 16);
}
export function executableHash(path = join(repository, "dist/iglo.email")) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}
export const provenance = (compiled: boolean) => ({
  head: git("rev-parse", "--short", "HEAD"),
  dirty: git("status", "--porcelain", "src", "migrations") !== "",
  source: sourceHash(),
  executable: compiled ? executableHash() : null,
  bun: Bun.version,
});

/** `free -m` MemAvailable in MiB. */
export const memAvailable = () =>
  Number(
    /Mem:\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(
      Bun.spawnSync(["free", "-m"]).stdout.toString(),
    )?.[1] ?? NaN,
  );
/** Resident set of a process in MiB, or null when it is gone. */
export function rssOf(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return kb ? Math.round(Number(kb) / 1024) : null;
  } catch {
    return null;
  }
}

export function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (n: number) => +n.toFixed(3);
  return {
    n: values.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)!),
  };
}

export function record(entry: object, compiled: boolean) {
  const line = { at: new Date().toISOString(), ...provenance(compiled), ...entry };
  appendFileSync(resultsFile, JSON.stringify(line) + "\n");
  console.log(JSON.stringify(line, null, 2));
}
