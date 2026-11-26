// Kill the compiled scheduler fixture (dist/scheduler-crash) at each crash point, restart it
// with its clock past the 5-minute lease, and show that no step is ever sent twice: a row claimed at
// the kill ends `unknown`, every other row is sent once (checkSmtpCrash, B156).
// Run with `bun run scheduler:crash`. Mail goes only to the loopback sink below.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { portZeroRootUrl, reportedPort, stderrDrained } from "@/test/serve-port";
import { untilState } from "@/test/wait";

interface Sink {
  port: number;
  /** Subjects of messages whose data ended, accepted or held. */
  subjects: Array<string>;
  held: Promise<void>;
  close(): Promise<void>;
}
/** Loopback SMTP sink; with `hold`, the first message's final dot is never answered. */
async function startSink(hold: boolean): Promise<Sink> {
  const subjects: Array<string> = [];
  const sockets = new Set<Socket>();
  let announce!: () => void;
  const held = new Promise<void>((r) => {
    announce = r;
  });
  let holding = hold;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("latin1");
    let buffer = "";
    let data: Array<string> | null = null;
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
          } else {
            socket.write("250 queued\r\n");
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") {
          socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        } else if (verb === "DATA") {
          data = [];
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("sink address");
  }
  return {
    port: address.port,
    subjects,
    held,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((r) => {
        server.close(() => r());
      });
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
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
    child.once("exit", (code, signal) => r({ code, signal }));
  });
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
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  await within(exited, 15_000, "fixture stop").catch(async () => {
    child.kill("SIGKILL");
    // Reaped before the caller goes on: a process still running would outlive the test.
    await exited;
  });
}
interface SendRow {
  step: number;
  status: string;
  skip_reason: string | null;
  error: string | null;
}
function state(dir: string) {
  const db = new Database(join(dir, "iglo-email.db"), { readonly: true });
  try {
    // The restarted fixture recovers the WAL the killed one left; a read meanwhile is BUSY_RECOVERY,
    // which the busy handler retries instead of failing the poll.
    db.run("PRAGMA busy_timeout = 5000");
    const sends = db
      .query<SendRow, []>(
        "SELECT st.position AS step, s.status, s.skip_reason, s.error FROM sends s JOIN sequence_steps st ON st.id = s.step_id ORDER BY s.id",
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
type State = ReturnType<typeof state>;
const stepMails = (subjects: ReadonlyArray<string>, step: number) =>
  subjects.filter((s) => s.startsWith(`Step ${step} `)).length;
/**
 * A kill while step 0's SMTP data is held. Each step ends as the journal stood at the kill (D80,
 * D155, 04-sending "Reserve before claim"): a row claimed `sending` may already be in SMTP flight, so
 * it ends `unknown`/`interrupted` and is never pushed again; a row not yet claimed (queued, or not
 * inserted yet) is sent exactly once by the restart. Since B141 step 1, a marketing row, is claimed
 * by the outbox's second loop as soon as it has a grant, so it is usually `sending` at the kill,
 * waiting for its start behind step 0. Returns how each step's row stood at the kill.
 */
function checkSmtpCrash(
  label: string,
  before: State,
  after: State,
  atKill: ReadonlyArray<string>,
  subjects: ReadonlyArray<string>,
) {
  const outcome: Array<string> = [];
  for (const step of [0, 1]) {
    const rows = after.sends.filter((s) => s.step === step);
    assert.equal(rows.length, 1, `${label}: one send row for step ${step}`);
    const killed = before.sends.find((s) => s.step === step)?.status ?? "absent";
    const mails = stepMails(subjects, step);
    assert.ok(mails <= 1, `${label}: step ${step} reached SMTP at most once`);
    if (step === 0) {
      // The held delivery: in flight at the kill.
      assert.equal(killed, "sending", `${label}: step 0 was in SMTP flight at the kill`);
      assert.equal(mails, 1, `${label}: step 0 reached SMTP once`);
    }
    if (killed === "sending") {
      assert.deepEqual(
        [rows[0]!.status, rows[0]!.error],
        ["unknown", "interrupted"],
        `${label}: step ${step}, claimed at the kill, is unknown and never retried`,
      );
      assert.equal(mails, stepMails(atKill, step), `${label}: step ${step} not pushed again`);
    } else {
      assert.ok(["absent", "queued", "sent"].includes(killed), `${label}: step ${step} ${killed}`);
      assert.equal(
        rows[0]!.status,
        "sent",
        `${label}: step ${step}, unclaimed at the kill, is sent`,
      );
      assert.equal(mails, 1, `${label}: step ${step} sent once`);
    }
    outcome.push(`${step}:${killed}`);
  }
  return outcome.join(", ");
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
    const atKill = [...sink.subjects];

    // Restart six minutes later on the injected clock, so the dead process's lease expired.
    const second = launch(dir, sink.port, { SCHEDULER_CRASH_OFFSET_MS: String(6 * 60_000) });
    let after = state(dir);
    await untilState(
      () => {
        after = state(dir);
        return (
          after.enrollments[0] === "completed" &&
          !after.sends.some((s) => s.status === "queued" || s.status === "sending")
        );
      },
      {
        label: `${point}: restart did not finish`,
        progress: () => JSON.stringify(after),
        stallMs: 30_000,
        intervalMs: 50,
      },
    );
    await stop(second.child, second.exited);

    if (point === "smtp") {
      checkSmtpCrash(point, before, after, atKill, sink.subjects);
    } else {
      const mails = [0, 1].map((step) => stepMails(sink.subjects, step));
      for (const step of [0, 1]) {
        assert.equal(
          after.sends.filter((s) => s.step === step).length,
          1,
          `${point}: one send row for step ${step}`,
        );
        assert.ok(mails[step]! <= 1, `${point}: step ${step} reached SMTP at most once`);
      }
      assert.deepEqual(
        after.sends.map((s) => s.status),
        ["sent", "sent"],
      );
      assert.deepEqual(mails, [1, 1]);
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
type Launched = Awaited<ReturnType<typeof launchProduction>>;
async function production(dir: string, launched: Array<Launched>) {
  const running = await launchProduction(dir);
  launched.push(running);
  return running;
}
// Returns once this process has bound port 0 and named the port (D144): the line comes after the
// bind, so the process listens by then. Its stderr is kept, and printed only if the run fails: a
// healthy start writes nothing to read.
async function launchProduction(dir: string) {
  const child = spawn(
    resolve("dist/iglo.email"),
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--root-url",
      portZeroRootUrl,
      "--data-dir",
      dir,
    ],
    {
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: "fixture-admin",
        IGLO_EMAIL_ADMIN_PASSWORD: "fixture-admin-password",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
    child.once("exit", (code, signal) => r({ code, signal }));
  });
  try {
    await reportedPort(child, 20_000).catch(async (error: unknown) => {
      await stderrDrained(child);
      throw new Error(`production did not listen: ${String(error)}: ${errors}`);
    });
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
  return { child, exited, errors: () => errors };
}
{
  const dir = await mkdtemp(join(tmpdir(), "iglo-scheduler-production-"));
  const sink = await startSink(true);
  const launched: Array<Launched> = [];
  // B138b layout: the seed writes the primary project's database, which production adopts.
  const project = join(dir, "projects", "main");
  try {
    const seeded = launch(project, sink.port, {
      SCHEDULER_CRASH_SEED: "1",
      SCHEDULER_CRASH_AT: "seed",
    });
    assert.equal((await within(seeded.exited, 20_000, "seed")).code, 0);
    const first = await production(dir, launched);
    await within(sink.held, 20_000, "production held SMTP data");
    first.child.kill("SIGKILL");
    assert.equal((await within(first.exited, 20_000, "production kill")).signal, "SIGKILL");
    const before = state(project);
    const atKill = [...sink.subjects];
    const second = await production(dir, launched);
    let after = state(project);
    await untilState(
      () => {
        after = state(project);
        return (
          after.enrollments[0] === "completed" &&
          !after.sends.some((s) => s.status === "queued" || s.status === "sending")
        );
      },
      {
        label: "production: restart did not finish",
        progress: () => JSON.stringify(after),
        stallMs: 30_000,
        intervalMs: 50,
      },
    );
    await stop(second.child, second.exited);
    checkSmtpCrash("production", before, after, atKill, sink.subjects);
    console.log(
      `production smtp: killed with [${before.sends.map((s) => `${s.step}:${s.status}`).join(", ")}]; after restart [${after.sends.map((s) => `${s.step}:${s.status}`).join(", ")}], SMTP data ${sink.subjects.length}`,
    );
  } catch (error) {
    // A failed run stops every production process it started, and prints what they wrote.
    for (const [index, running] of launched.entries()) {
      console.error(`production process ${index + 1} stderr:\n${running.errors()}`);
      if (running.child.exitCode === null && running.child.signalCode === null) {
        running.child.kill("SIGKILL");
      }
      await running.exited;
    }
    throw error;
  } finally {
    await sink.close();
    await rm(dir, { recursive: true, force: true });
  }
}
console.log("no duplicate sends at any crash point");
