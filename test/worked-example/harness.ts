// Harness for the 05-sequences worked example: the compiled production executable in a temporary
// directory, a loopback SMTP sink that records when each message arrived, and API helpers.
// Everything runs against generated data; mail never leaves the loopback sink.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";
import { startSink } from "@/test/tx/sink";

export const admin = { user: "worked-admin", password: "worked-example-admin-password" };

export class Failure extends Error {}
export function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Failure(`FAIL worked-example: ${label}`);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** The compiled executable, started, stopped and restarted on one data directory and port. */
export async function startProduction(executable = resolve("dist/iglo.email")) {
  const directory = await mkdtemp(join(tmpdir(), "iglo-worked-example-"));
  const copy = join(directory, "iglo.email");
  await copyFile(executable, copy);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  /** Everything the process wrote to stderr: application code logs only what needs attention. */
  let errors = "";

  const start = async () => {
    child = spawn(
      copy,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        join(directory, "data"),
      ],
      {
        cwd: directory,
        env: {
          PATH: "",
          IGLO_EMAIL_ADMIN_USER: admin.user,
          IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr!.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-8000);
    });
    const current = child;
    exited = new Promise((r) => current.once("exit", (code) => r(code)));
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (current.exitCode !== null) throw new Error(`production exited early: ${errors}`);
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
        if (response.status === 200) return;
      } catch {}
      if (Date.now() > deadline) throw new Error("production readiness timed out");
      await Bun.sleep(25);
    }
  };
  /** Graceful stop (SIGTERM); SIGKILL only if it hangs, which fails the run. */
  const stop = async () => {
    if (!child || !exited) return;
    const current = child;
    if (current.exitCode === null && current.signalCode === null) current.kill("SIGTERM");
    const timer = setTimeout(() => current.kill("SIGKILL"), 15_000);
    const code = await exited;
    clearTimeout(timer);
    child = undefined;
    check(code === 0, `graceful shutdown exit code ${code}`);
  };
  await start();
  return {
    origin,
    start,
    stop,
    errors: () => errors,
    async close() {
      try {
        if (child) {
          child.kill("SIGKILL");
          await exited;
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export type Production = Awaited<ReturnType<typeof startProduction>>;

export interface Mail {
  to: string;
  subject: string;
  body: string;
  header(name: string): string | null;
  /** When the poller first saw it at the sink, in epoch milliseconds. */
  at: number;
}

/** Unfolded headers plus a quoted-printable-decoded body, as test/unsubscribe decodes mail. */
function decode(data: string, to: string, at: number): Mail {
  const split = data.indexOf("\r\n\r\n");
  const headers = data.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const body = data
    .slice(split + 4)
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const header = (name: string) =>
    new RegExp(`^${name}: (.*)$`, "mi").exec(headers)?.[1]?.trim() ?? null;
  return { to, subject: header("Subject") ?? "", body, header, at };
}

export async function startMailbox() {
  const sink = await startSink();
  const mails: Mail[] = [];
  const poll = setInterval(() => {
    while (mails.length < sink.messages.length) {
      const message = sink.messages[mails.length]!;
      check(message.to.length === 1, "one envelope recipient per message");
      mails.push(decode(message.data, message.to[0]!, Date.now()));
    }
  }, 20);
  const find = (to: string, subject: string) =>
    mails.filter((m) => m.to === to && m.subject === subject);
  return {
    port: sink.port,
    mails,
    find,
    /** Wait until exactly one matching message arrived and return it. */
    async one(to: string, subject: string, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (find(to, subject).length === 0) {
        check(Date.now() < deadline, `no "${subject}" for ${to} within ${timeoutMs} ms`);
        await Bun.sleep(50);
      }
      const found = find(to, subject);
      check(found.length === 1, `exactly one "${subject}" for ${to}`);
      return found[0]!;
    },
    async close() {
      clearInterval(poll);
      await sink.close();
    },
  };
}
export type Mailbox = Awaited<ReturnType<typeof startMailbox>>;

export async function apiClient(origin: string) {
  const credentials = await provisionApiUser(origin, admin);
  const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  /** A call that must succeed; returns `data`. */
  const ok = async (path: string, method = "GET", body?: unknown) => {
    const response = await call(path, method, body);
    check(
      response.status === 200,
      `${method} ${path} → ${response.status} ${JSON.stringify(response.body)}`,
    );
    return response.body.data;
  };
  return { call, ok };
}
export type Api = Awaited<ReturnType<typeof apiClient>>;
