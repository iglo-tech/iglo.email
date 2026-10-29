// Kill the compiled scheduler fixture (dist/scheduler-crash) at each crash point, restart it
// with its clock past the 5-minute lease, and show that no step is ever sent twice.
// Run with `bun run scheduler:crash`. Mail goes only to the loopback sink below.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Sink {
  port: number;
  /** Subjects of messages whose data ended, accepted or held. */
  subjects: string[];
  held: Promise<void>;
  close(): Promise<void>;
}
/** Loopback SMTP sink; with `hold`, the first message's final dot is never answered. */
async function startSink(hold: boolean): Promise<Sink> {
  const subjects: string[] = [];
  const sockets = new Set<Socket>();
  let announce!: () => void;
  const held = new Promise<void>((r) => (announce = r));
  let holding = hold;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("latin1");
    let buffer = "";
    let data: string[] | null = null;
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line !== ".") {
            data.push(line);
            continue;
          }
          subjects.push(/^Subject: (.*)$/m.exec(data.join("\n"))?.[1] ?? "");
          data = null;
          if (holding) {
            holding = false;
            announce();
          } else socket.write("250 queued\r\n");
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "DATA") {
          data = [];
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sink address");
  return {
    port: address.port,
    subjects,
    held,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function launch(dir: string, port: number, env: Record<string, string>) {
  const child = spawn(resolve("dist/scheduler-crash"), [], {
    env: {
      ...process.env,
      SCHEDULER_CRASH_DIR: dir,
      SCHEDULER_CRASH_SMTP_PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
    child.once("exit", (code, signal) => r({ code, signal })),
  );
  return { child, exited };
}
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await within(exited, 15_000, "fixture stop").catch(() => {
    child.kill("SIGKILL");
  });
}
interface SendRow {
  step: number;
  status: string;
  skip_reason: string | null;
}
function state(dir: string) {
  const db = new Database(join(dir, "iglo-email.db"), { readonly: true });
  try {
    const sends = db
      .query<SendRow, []>(
        "SELECT st.position AS step, s.status, s.skip_reason FROM sends s JOIN sequence_steps st ON st.id = s.step_id ORDER BY s.id",
      )
      .all();
    const enrollments = db
      .query<{ status: string }, []>("SELECT status FROM enrollments")
      .all()
      .map((r) => r.status);
    return { sends, enrollments };
  } finally {
    db.close();
  }
}

for (const point of ["claim", "insert", "advance", "commit", "smtp"]) {
  const dir = await mkdtemp(join(tmpdir(), "iglo-scheduler-crash-"));
  const sink = await startSink(point === "smtp");
  try {
    const first = launch(dir, sink.port, {
      SCHEDULER_CRASH_SEED: "1",
      ...(point === "smtp" ? {} : { SCHEDULER_CRASH_AT: point }),
    });
    if (point === "smtp") {
      await within(sink.held, 20_000, "held SMTP data");
      first.child.kill("SIGKILL");
    }
    const killed = await within(first.exited, 20_000, `${point} kill`);
    assert.equal(killed.signal, "SIGKILL", `${point}: fixture was killed at its barrier`);
    const before = state(dir);

    // Restart six minutes later on the injected clock, so the dead process's lease expired.
    const second = launch(dir, sink.port, { SCHEDULER_CRASH_OFFSET_MS: String(6 * 60_000) });
    const deadline = Date.now() + 30_000;
    let after = state(dir);
    while (
      after.enrollments[0] !== "completed" ||
      after.sends.some((s) => s.status === "queued" || s.status === "sending")
    ) {
      if (Date.now() > deadline) throw new Error(`${point}: restart did not finish`);
      await Bun.sleep(50);
      after = state(dir);
    }
    await stop(second.child, second.exited);

    const perStep = [0, 1].map((step) => after.sends.filter((s) => s.step === step));
    const mails = [0, 1].map((step) => sink.subjects.filter((s) => s.startsWith(`Step ${step} `)));
    for (const step of [0, 1]) {
      assert.equal(perStep[step]!.length, 1, `${point}: one send row for step ${step}`);
      assert.ok(mails[step]!.length <= 1, `${point}: step ${step} reached SMTP at most once`);
    }
    if (point === "smtp") {
      // The interrupted delivery is unknown and never retried; the next step still sends once.
      assert.equal(perStep[0]![0]!.status, "unknown");
      assert.equal(perStep[1]![0]!.status, "sent");
      assert.equal(mails[1]!.length, 1);
    } else {
      assert.deepEqual(
        after.sends.map((s) => s.status),
        ["sent", "sent"],
      );
      assert.deepEqual(
        mails.map((m) => m.length),
        [1, 1],
      );
    }
    console.log(
      `${point}: killed with ${before.sends.length} send row(s) [${before.sends.map((s) => `${s.step}:${s.status}`).join(", ")}]; after restart [${after.sends.map((s) => `${s.step}:${s.status}`).join(", ")}], SMTP data ${sink.subjects.length}`,
    );
  } finally {
    await sink.close();
    await rm(dir, { recursive: true, force: true });
  }
}
// The real production executable: kill it while SMTP delivery of step 0 is in flight.
async function production(dir: string) {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  const child = spawn(
    resolve("dist/iglo.email"),
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dir],
    {
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: "fixture-admin",
        IGLO_EMAIL_ADMIN_PASSWORD: "fixture-admin-password",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
    child.once("exit", (code, signal) => r({ code, signal })),
  );
  return { child, exited };
}
{
  const dir = await mkdtemp(join(tmpdir(), "iglo-scheduler-production-"));
  const sink = await startSink(true);
  try {
    const seeded = launch(dir, sink.port, {
      SCHEDULER_CRASH_SEED: "1",
      SCHEDULER_CRASH_AT: "seed",
    });
    assert.equal((await within(seeded.exited, 20_000, "seed")).code, 0);
    const first = await production(dir);
    await within(sink.held, 20_000, "production held SMTP data");
    first.child.kill("SIGKILL");
    assert.equal((await within(first.exited, 20_000, "production kill")).signal, "SIGKILL");
    const before = state(dir);
    const second = await production(dir);
    const deadline = Date.now() + 30_000;
    let after = state(dir);
    while (
      after.enrollments[0] !== "completed" ||
      after.sends.some((s) => s.status === "queued" || s.status === "sending")
    ) {
      if (Date.now() > deadline) throw new Error("production: restart did not finish");
      await Bun.sleep(50);
      after = state(dir);
    }
    await stop(second.child, second.exited);
    assert.deepEqual(
      after.sends.map((s) => [s.step, s.status]),
      [
        [0, "unknown"],
        [1, "sent"],
      ],
    );
    assert.ok(sink.subjects.filter((s) => s.startsWith("Step 0 ")).length <= 1);
    assert.equal(sink.subjects.filter((s) => s.startsWith("Step 1 ")).length, 1);
    console.log(
      `production smtp: killed with [${before.sends.map((s) => `${s.step}:${s.status}`).join(", ")}]; after restart [${after.sends.map((s) => `${s.step}:${s.status}`).join(", ")}], SMTP data ${sink.subjects.length}`,
    );
  } finally {
    await sink.close();
    await rm(dir, { recursive: true, force: true });
  }
}
console.log("no duplicate sends at any crash point");
