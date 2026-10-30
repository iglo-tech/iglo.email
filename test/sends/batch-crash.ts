// Kill the outbox while a batched claim is outstanding and restart it: between the claim
// commit and SMTP, and mid-batch with some messages already accepted. Every claimed row of
// the killed batch becomes `unknown` and is never resent; the rest are sent exactly once.
// Run with `bun run sends:batch-crash`. Mail goes only to the loopback sink below.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COUNT = 25;
interface Sink {
  port: number;
  /** Recipient of every message whose final dot the sink received. */
  data: string[];
  /** Recipients the sink answered 250 for. */
  accepted: string[];
  connected: Promise<void>;
  held: Promise<void>;
  release(): void;
  close(): Promise<void>;
}
/**
 * Loopback SMTP sink. `greet: false` never sends the greeting, so no SMTP command is ever
 * exchanged. With `holdAfter` = n, the final dot of every message after the first n accepted
 * ones is never answered.
 */
async function startSink(options: { greet: boolean; holdAfter?: number }): Promise<Sink> {
  const data: string[] = [];
  const accepted: string[] = [];
  const sockets = new Set<Socket>();
  let connect!: () => void;
  const connected = new Promise<void>((r) => (connect = r));
  let announce!: () => void;
  const held = new Promise<void>((r) => (announce = r));
  let greet = options.greet;
  let holdAfter = options.holdAfter;
  const server = createServer((socket) => {
    sockets.add(socket);
    connect();
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("latin1");
    let buffer = "";
    let to = "";
    let body: string[] | null = null;
    if (greet) socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (body) {
          if (line !== ".") continue;
          body = null;
          data.push(to);
          if (holdAfter !== undefined && accepted.length >= holdAfter) announce();
          else {
            accepted.push(to);
            socket.write("250 queued\r\n");
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "RCPT") {
          to = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          body = [];
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
    data,
    accepted,
    connected,
    held,
    release() {
      greet = true;
      holdAfter = undefined;
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
function launch(dir: string, port: number, mode: "seed" | "run") {
  const child = spawn("bun", [resolve("test/sends/batch-crash-entry.ts")], {
    env: {
      ...process.env,
      BATCH_CRASH_DIR: dir,
      BATCH_CRASH_SMTP_PORT: String(port),
      BATCH_CRASH_MODE: mode,
      BATCH_CRASH_COUNT: String(COUNT),
    },
    stdio: ["ignore", "ignore", "inherit"],
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
function rows(dir: string) {
  const db = new Database(join(dir, "iglo-email.db"), { readonly: true });
  try {
    return db
      .query<{ to_email: string; status: string; attempts: number; error: string | null }, []>(
        "SELECT to_email, status, attempts, error FROM sends ORDER BY id",
      )
      .all();
  } finally {
    db.close();
  }
}
const count = (list: string[], value: string) => list.filter((v) => v === value).length;

for (const point of ["claimed", "mid-batch"] as const) {
  const dir = await mkdtemp(join(tmpdir(), "iglo-batch-crash-"));
  const sink = await startSink(
    point === "claimed" ? { greet: false } : { greet: true, holdAfter: 3 },
  );
  const children: ReturnType<typeof launch>[] = [];
  try {
    const seeded = launch(dir, sink.port, "seed");
    children.push(seeded);
    assert.equal((await within(seeded.exited, 60_000, "seed")).code, 0);
    assert.ok(rows(dir).every((r) => r.status === "queued"));

    const first = launch(dir, sink.port, "run");
    children.push(first);
    // `claimed`: the outbox connected, but no SMTP command was exchanged.
    // `mid-batch`: three messages were accepted and the next final dot is held.
    if (point === "claimed") await within(sink.connected, 30_000, "first connection");
    else await within(sink.held, 30_000, "held data");
    first.child.kill("SIGKILL");
    assert.equal((await within(first.exited, 20_000, "kill")).signal, "SIGKILL");
    const before = rows(dir);
    const claimed = before.filter((r) => r.status === "sending").map((r) => r.to_email);
    assert.equal(claimed.length, 10, `${point}: one full batch was claimed before SMTP`);
    assert.ok(before.every((r) => r.status === "queued" || r.status === "sending"));
    const acceptedBefore = [...sink.accepted];
    const dataBefore = [...sink.data];
    if (point === "claimed") assert.equal(sink.data.length, 0);
    else assert.equal(acceptedBefore.length, 3);

    sink.release();
    const second = launch(dir, sink.port, "run");
    children.push(second);
    const deadline = Date.now() + 30_000;
    let after = rows(dir);
    while (after.some((r) => r.status === "queued" || r.status === "sending")) {
      if (Date.now() > deadline) throw new Error(`${point}: restart did not finish`);
      await Bun.sleep(50);
      after = rows(dir);
    }
    second.child.kill("SIGTERM");
    await within(second.exited, 15_000, "stop");

    assert.equal(after.length, COUNT);
    for (const row of after) {
      const wasClaimed = claimed.includes(row.to_email);
      // At most once at SMTP, whatever happened.
      assert.ok(count(sink.data, row.to_email) <= 1, `${point}: ${row.to_email} reached SMTP once`);
      if (wasClaimed) {
        assert.equal(row.status, "unknown", `${point}: claimed ${row.to_email} is unknown`);
        assert.equal(row.error, "interrupted");
        assert.equal(row.attempts, 1, `${point}: ${row.to_email} was never claimed again`);
        // Nothing of the killed batch reached SMTP again after the restart.
        assert.equal(count(sink.data, row.to_email), count(dataBefore, row.to_email));
      } else {
        assert.equal(row.status, "sent", `${point}: unclaimed ${row.to_email} was sent`);
        assert.equal(count(sink.accepted, row.to_email), 1);
      }
    }
    console.log(
      `${point}: killed with ${claimed.length} claimed of ${COUNT} queued, ${acceptedBefore.length} accepted and ${dataBefore.length - acceptedBefore.length} held at DATA; after restart ${after.filter((r) => r.status === "unknown").length} unknown, ${after.filter((r) => r.status === "sent").length} sent, SMTP data ${sink.data.length}`,
    );
  } finally {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((c) => c.exited));
    await sink.close();
    await rm(dir, { recursive: true, force: true });
  }
}
console.log("no duplicate sends and every claimed row of a killed batch is unknown");
