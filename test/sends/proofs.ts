// Real SMTP responses at the native outbox boundary, under reference:run.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker),
  directory = await mkdtemp(join(tmpdir(), "iglo-proofs-"));
let child: ChildProcessWithoutNullStreams | undefined;
async function relay(mode: string) {
  const sockets = new Set<Socket>();
  let connections = 0,
    recipients = 0;
  const server = createServer((client) => {
    connections++;
    const upstream = createConnection({ host: sink.host, port: sink.port });
    sockets.add(client);
    sockets.add(upstream);
    client.on("error", () => {});
    upstream.on("error", () => {});
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    let toServer = "",
      fromServer = "",
      data = false,
      ehlo = false;
    client.on("data", (chunk: Buffer) => {
      toServer += chunk.toString("latin1");
      for (;;) {
        const end = toServer.indexOf("\r\n");
        if (end < 0) break;
        const line = toServer.slice(0, end);
        toServer = toServer.slice(end + 2);
        if (data) {
          upstream.write(`${line}\r\n`, "latin1");
          if (line === ".") data = false;
          continue;
        }
        if (line.startsWith("AUTH ")) {
          client.write(
            mode === "auth-temporary" ? "454 4.7.0 temporary\r\n" : "535 5.7.8 rejected\r\n",
          );
          continue;
        }
        if (line.startsWith("RCPT TO:")) {
          recipients++;
          if (mode === "rcpt-temporary") {
            client.write("450 4.1.1 temporary\r\n");
            continue;
          }
          if (
            mode === "rcpt-permanent" ||
            (mode === "partial" && line.includes("rejected@example.test"))
          ) {
            client.write("550 5.1.1 rejected\r\n");
            continue;
          }
        }
        if (line.startsWith("EHLO ")) ehlo = true;
        upstream.write(`${line}\r\n`, "latin1");
        if (line === "DATA") data = true;
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      fromServer += chunk.toString("latin1");
      for (;;) {
        const end = fromServer.indexOf("\r\n");
        if (end < 0) break;
        const line = fromServer.slice(0, end);
        fromServer = fromServer.slice(end + 2);
        if (/^250[- ]PIPELINING/i.test(line)) continue;
        if (ehlo && line.startsWith("250 ")) {
          client.write("250-AUTH PLAIN\r\n");
          ehlo = false;
        }
        client.write(`${line}\r\n`, "latin1");
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay port");
  return {
    port: address.port,
    counts: () => ({ connections, recipients }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
    },
  };
}
async function start(port: number, auth: boolean, dir: string) {
  child = spawn(resolve("dist/sends-producer"), [], {
    env: {
      ...process.env,
      SENDS_FIXTURE_DIR: dir,
      SENDS_FIXTURE_SMTP_PORT: String(port),
      SENDS_FIXTURE_AUTH: auth ? "1" : "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const portText = await new Promise<string>((ok, fail) => {
    let value = "";
    child!.stdout.on("data", (chunk) => {
      value += chunk.toString();
      if (value.includes("\n")) ok(value.split("\n")[0]!);
    });
    child!.once("exit", () => fail(new Error("Fixture exited before readiness")));
  });
  const origin = `http://127.0.0.1:${portText}`;
  async function call(
    path: string,
    method = "GET",
    body?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Fixture ${path} failed: ${response.status}`);
    return ((await response.json()) as { data: any }).data;
  }
  const session = await call("/fixture/session");
  return {
    call,
    get: (id: number) => call(`/api/sends/${id}`, "GET", undefined, { cookie: session.cookie }),
  };
}
async function kill() {
  if (!child) return;
  const old = child;
  child = undefined;
  const exited = new Promise<void>((ok) => old.once("exit", () => ok()));
  old.kill("SIGKILL");
  await exited;
}
try {
  for (const mode of [
    "auth-temporary",
    "auth-permanent",
    "rcpt-temporary",
    "rcpt-permanent",
    "partial",
  ] as const) {
    const peer = await relay(mode);
    try {
      const fixture = await start(peer.port, mode.startsWith("auth"), join(directory, mode));
      const entry = await fixture.call(
        "/fixture/enqueue",
        "POST",
        JSON.stringify({
          subject: `${marker} ${mode}`,
          kind: "transactional",
          ...(mode === "partial" ? { cc: "rejected@example.test" } : {}),
        }),
        { "content-type": "application/json" },
      );
      await fixture.call("/fixture/start", "POST", "normal");
      await fixture.call("/fixture/finished?count=1");
      let row = await fixture.get(entry.id);
      const temporary = mode.endsWith("temporary");
      assert.equal(row.status, temporary ? "queued" : mode === "partial" ? "sent" : "failed", mode);
      assert.equal(row.attempts, 1);
      if (mode === "partial") assert.equal(row.error, "partial_acceptance");
      if (temporary) {
        await fixture.call("/fixture/clock", "POST", "999");
        row = await fixture.get(entry.id);
        assert.equal(row.attempts, 1);
        await fixture.call("/fixture/clock", "POST", "1");
        await fixture.call("/fixture/finished?count=2");
        row = await fixture.get(entry.id);
        assert.equal(row.attempts, 2);
        assert.equal(row.smtp_message_id, entry.smtp_message_id);
      }
      const messages = (await mailpit.list()).filter((m) => m.Subject === `${marker} ${mode}`);
      assert.equal(messages.length, mode === "partial" ? 1 : 0, mode);
      globalThis.process.stdout.write(`PASS SMTP proof ${mode} ${JSON.stringify(peer.counts())}\n`);
    } finally {
      await kill();
      await peer.close();
    }
  }
} finally {
  await kill();
  await mailpit.removeOwned();
  await rm(directory, { recursive: true, force: true });
}
