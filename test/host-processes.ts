// What the host's processes are, for tests that check a child is gone or a file is closed. Linux
// reads /proc. macOS, the owner's workstation, has no /proc, so it asks ps and lsof, which ship
// with the OS and answer the same questions.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";

function run(cmd: Array<string>): Array<string> {
  return Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n");
}

/** The pids of this process's children: the processes whose parent is this process. */
export function childPids(): Array<number> {
  if (process.platform !== "linux") {
    const children: Array<number> = [];
    for (const line of run([PS, "-A", "-o", "pid=,ppid="])) {
      const [pid, parent] = line.trim().split(/\s+/).map(Number);
      if (pid !== undefined && parent === process.pid) {
        children.push(pid);
      }
    }
    return children;
  }
  const out: Array<number> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf-8");
      if (new RegExp(`^PPid:\\s+${process.pid}$`, "m").test(status)) {
        out.push(Number(entry));
      }
    } catch {
      /* exited meanwhile */
    }
  }
  return out;
}

/** The command line of every process on the host, as one string each. */
export function commandLines(): Array<string> {
  if (process.platform !== "linux") {
    return run([PS, "-A", "-ww", "-o", "command="]);
  }
  const out: Array<string> = [];
  for (const entry of readdirSync("/proc")) {
    try {
      out.push(readFileSync(`/proc/${entry}/cmdline`, "utf-8"));
    } catch {
      /* not a process, or exited meanwhile */
    }
  }
  return out;
}

/** The paths of the files this process has open, as the OS names them. */
export function openFilePaths(): Array<string> {
  if (process.platform !== "linux") {
    return run([LSOF, "-nP", "-p", String(process.pid), "-Fn"])
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1));
  }
  const out: Array<string> = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      out.push(readlinkSync(join("/proc/self/fd", fd)));
    } catch {
      // The descriptor that listed the directory is already closed.
    }
  }
  return out;
}
