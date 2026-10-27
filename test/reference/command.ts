import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface GroupChild extends ChildProcess {
  stopGroup(signal?: NodeJS.Signals): void;
}

export function spawnGroup(executable: string, args: string[], options: SpawnOptions = {}) {
  const child = spawn(executable, args, { ...options, detached: true }) as GroupChild;
  let owned = true;
  child.stopGroup = (signal = "SIGTERM") => {
    if (!owned || !child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  child.once("exit", () => {
    // Stop descendants immediately, while the group still belongs to this
    // child. Later cleanup must never signal a saved group ID after its exit.
    try {
      child.stopGroup("SIGKILL");
    } finally {
      owned = false;
    }
  });
  child.once("error", () => {
    owned = false;
  });
  return child;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Every process has its own process group, including any children it starts.
export function stopGroup(child: GroupChild, signal: NodeJS.Signals = "SIGTERM") {
  child.stopGroup(signal);
}

export async function command(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
  } = {},
): Promise<CommandResult> {
  const executable = args[0];
  if (!executable) throw new Error("Missing executable");
  options.signal?.throwIfAborted();
  const child = spawnGroup(executable, args.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let reason = "";
  let force: ReturnType<typeof setTimeout> | undefined;
  const terminate = (why: string) => {
    reason ||= why;
    stopGroup(child);
    force ??= setTimeout(() => stopGroup(child, "SIGKILL"), 2_000);
  };
  const timer = setTimeout(
    () => terminate(`timed out after ${options.timeout ?? 30_000}ms`),
    options.timeout ?? 30_000,
  );
  const abort = () => terminate("interrupted");
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? 1));
    });
    if (reason) throw new Error(`${executable} ${reason}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    options.signal?.removeEventListener("abort", abort);
  }
}
