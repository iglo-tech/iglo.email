// Compiled fixture process killed at explicit producer/SMTP/journal barriers.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { faultRelay } from "@/test/messaging/fault-relay";
import { createServer, createConnection, type Socket } from "node:net";

const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
const directory = await mkdtemp(join(tmpdir(), "iglo-sends-crash-"));
let active: ChildProcessWithoutNullStreams | undefined;
async function launch(dir: string, smtpPort = sink.port) {
  const child = spawn(resolve("dist/sends-producer"), [], {
    env: { ...process.env, SENDS_FIXTURE_DIR: dir, SENDS_FIXTURE_SMTP_PORT: String(smtpPort) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  active = child;
  const port = await new Promise<string>((resolvePort, reject) => {
    let value = "";
    child.stdout.on("data", (chunk) => {
      value += chunk.toString();
      if (value.includes("\n")) resolvePort(value.split("\n")[0]!);
    });
    child.once("exit", () => reject(new Error("Fixture exited before readiness")));
    child.once("error", reject);
  });
  if (!/^\d+$/.test(port)) throw new Error("Invalid fixture readiness");
  const origin = `http://127.0.0.1:${port}`;
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
    if (!response.ok) throw new Error(`Fixture ${path} returned ${response.status}`);
    return ((await response.json()) as { data: any }).data;
  }
  const session = await call("/fixture/session");
  const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  return { child, call, get: (id: number) => call(`/api/sends/${id}`, "GET", undefined, headers) };
}
async function kill(child: ChildProcessWithoutNullStreams) {
  const done = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGKILL");
  await done;
  if (active === child) active = undefined;
}
async function dataBarrier() {
  const sockets = new Set<Socket>();
  let announce!: () => void;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const server = createServer((client) => {
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
    upstream.pipe(client);
    let pending = "",
      data = false;
    client.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      for (;;) {
        const index = pending.indexOf("\r\n");
        if (index < 0) break;
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        if (data) {
          announce();
          return;
        }
        upstream.write(`${line}\r\n`, "latin1");
        if (line === "DATA") data = true;
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay address");
  return {
    port: address.port,
    entered,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}
try {
  for (const [scenario, mode, kind] of [
    ["queued", "", "transactional"],
    ["claimed", "before-smtp", "transactional"],
    ["acknowledged", "after-ack", "transactional"],
    ["committed", "normal", "transactional"],
    ["marketing-claimed", "before-smtp", "marketing"],
    ["marketing-acknowledged", "after-ack", "marketing"],
  ] as const) {
    const dataDir = join(directory, scenario);
    let process = await launch(dataDir);
    const entry = await process.call(
      "/fixture/enqueue",
      "POST",
      JSON.stringify({ subject: `${marker} ${scenario}`, kind }),
      { "content-type": "application/json" },
    );
    if (mode) {
      await process.call("/fixture/start", "POST", mode);
      await process.call(mode === "normal" ? "/fixture/committed" : "/fixture/entered");
    }
    await kill(process.child);
    process = await launch(dataDir);
    await process.call("/fixture/start", "POST", "normal");
    if (scenario === "queued") await process.call("/fixture/committed");
    const row = await process.get(entry.id);
    assert.equal(
      row.status,
      scenario === "queued" || scenario === "committed" ? "sent" : "unknown",
      scenario,
    );
    assert.equal(row.smtp_message_id, entry.smtp_message_id);
    const messages = (await mailpit.list()).filter((m) => m.Subject === `${marker} ${scenario}`);
    assert.equal(messages.length, scenario.endsWith("claimed") ? 0 : 1, scenario);
    if (messages.length)
      assert.equal(
        messages[0]!.MessageID.replace(/[<>]/g, ""),
        entry.smtp_message_id.replace(/[<>]/g, ""),
      );
    await kill(process.child);
    globalThis.process.stdout.write(`PASS compiled ${kind} fixture ${scenario}\n`);
  }
  for (const [scenario, kind] of [
    ["during-data", "marketing"],
    ["lost-final", "marketing"],
    ["during-data", "transactional"],
    ["lost-final", "transactional"],
  ] as const) {
    const relay =
      scenario === "during-data" ? await dataBarrier() : await faultRelay(sink, "hold-final");
    try {
      const dataDir = join(directory, `${kind}-${scenario}`);
      let worker = await launch(dataDir, relay.port);
      const entry = await worker.call(
        "/fixture/enqueue",
        "POST",
        JSON.stringify({ subject: `${marker} ${kind}-${scenario}`, kind }),
        { "content-type": "application/json" },
      );
      await worker.call("/fixture/start", "POST", "normal");
      await ("atFinal" in relay ? relay.atFinal : relay.entered);
      await kill(worker.child);
      await relay.close();
      worker = await launch(dataDir);
      await worker.call("/fixture/start", "POST", "normal");
      const row = await worker.get(entry.id);
      assert.equal(row.status, "unknown", scenario);
      const messages = (await mailpit.list()).filter(
        (m) => m.Subject === `${marker} ${kind}-${scenario}`,
      );
      assert.equal(messages.length, scenario === "lost-final" ? 1 : 0, scenario);
      if (messages.length)
        assert.equal(
          messages[0]!.MessageID.replace(/[<>]/g, ""),
          entry.smtp_message_id.replace(/[<>]/g, ""),
        );
      await kill(worker.child);
      globalThis.process.stdout.write(`PASS compiled ${kind} fixture ${scenario}\n`);
    } finally {
      await relay.close().catch(() => {});
    }
  }
} finally {
  if (active) await kill(active);
  await mailpit.removeOwned();
  await rm(directory, { recursive: true, force: true });
}
