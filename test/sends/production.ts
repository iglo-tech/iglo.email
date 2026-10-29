// Real production process with fixture-seeded disposable databases and owned SMTP peers.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { provisionApiUser } from "@/test/contract/owned";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { faultRelay } from "@/test/messaging/fault-relay";
import { expectMessageId, header } from "@/test/perf/runtime-compat/smtp-expect";

const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
const dir = await mkdtemp(join(tmpdir(), "iglo-production-outbox-"));
const active = new Set<ChildProcessWithoutNullStreams>();
const admin = { user: "fixture-admin", password: "fixture-admin-password" };
async function stop(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) =>
    child.once("exit", (code, sig) => ok({ code, signal: sig })),
  );
  child.kill(signal);
  const result = await Promise.race([
    done,
    new Promise<never>((_, fail) =>
      setTimeout(() => fail(new Error("Process did not exit")), 9000),
    ),
  ]);
  active.delete(child);
  return result;
}
async function fixture(dataDir: string, smtpPort: number) {
  const child = spawn(resolve("dist/sends-producer"), [], {
    env: { ...process.env, SENDS_FIXTURE_DIR: dataDir, SENDS_FIXTURE_SMTP_PORT: String(smtpPort) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  active.add(child);
  const port = await new Promise<string>((ok, fail) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("\n")) ok(out.split("\n")[0]!);
    });
    child.once("exit", () => fail(new Error("Fixture exited before readiness")));
  });
  const origin = `http://127.0.0.1:${port}`;
  const call = async (
    path: string,
    method = "GET",
    value?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...headers,
        ...(value === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(value === undefined
        ? {}
        : { body: typeof value === "string" ? value : JSON.stringify(value) }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, path);
    return ((await response.json()) as { data: any }).data;
  };
  const session = await call("/fixture/session");
  return {
    child,
    call,
    get: (id: number) => call(`/api/sends/${id}`, "GET", undefined, { cookie: session.cookie }),
  };
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
  return address.port;
}
// A second invocation-owned sink observes its own intake without forwarding.
async function localSink() {
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 fixture.test ESMTP\r\n");
    let input = "",
      data = false,
      mail = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("latin1");
      for (;;) {
        const end = input.indexOf("\r\n");
        if (end < 0) return;
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(mail);
            mail = "";
            socket.write("250 2.0.0 accepted\r\n");
          } else mail += `${line}\r\n`;
        } else if (/^EHLO |^HELO /i.test(line)) socket.write("250 fixture.test\r\n");
        else if (/^MAIL FROM:|^RCPT TO:|^RSET/i.test(line)) socket.write("250 2.1.0 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No sink port");
  return {
    port: address.port,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
    },
  };
}
async function production(dataDir: string) {
  const port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    resolve("dist/iglo.email"),
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
    {
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  active.add(child);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Production exited before readiness");
    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).status === 200)
        return { child, origin };
    } catch {
      /* startup */
    }
    await Bun.sleep(25);
  }
  throw new Error("Production readiness timed out");
}
async function api(origin: string, credentials: { user: string; token: string }, path: string) {
  const response = await fetch(origin + path, {
    headers: { authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: any }).data;
}
async function terminal(origin: string, credentials: { user: string; token: string }, id: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const row = await api(origin, credentials, `/api/sends/${id}`);
    if (!["queued", "sending"].includes(row.status)) return row;
  }
  throw new Error("Timed out awaiting terminal journal projection");
}
try {
  // One queued row, one interrupted claim, and one completed row survive fixture termination.
  const dataDir = join(dir, "reopen");
  let seed = await fixture(dataDir, sink.port);
  await seed.call("/fixture/settings", "POST", "");
  const queued = await seed.call("/fixture/enqueue", "POST", {
    subject: `${marker} queued`,
    kind: "transactional",
    mutation: true,
  });
  const large = await seed.call("/fixture/enqueue", "POST", {
    subject: `${marker} large`,
    kind: "transactional",
    large: true,
  });
  const alternate = await seed.call("/fixture/enqueue", "POST", {
    subject: `${marker} alternate`,
    kind: "transactional",
    alternate: true,
  });
  await stop(seed.child, "SIGKILL");
  let app = await production(dataDir);
  const credentials = await provisionApiUser(app.origin, admin);
  const delivered = await terminal(app.origin, credentials, queued.id);
  assert.equal(delivered.status, "sent");
  assert.equal(delivered.smtp_message_id, queued.smtp_message_id);
  let captures = (await mailpit.list()).filter((m) => m.Subject === `${marker} queued`);
  assert.equal(captures.length, 1);
  const raw = await mailpit.raw(captures[0]!.ID),
    captured = await mailpit.message(captures[0]!.ID);
  expectMessageId(raw, queued.smtp_message_id);
  assert.equal(header(raw, "X-Fixture"), "original");
  assert.equal(captured.Text.trim(), "original UTF-8: zażółć");
  assert.deepEqual(
    captured.To.map((x) => x.Address),
    ["recipient@example.test"],
  );
  assert.deepEqual(
    await mailpit.part(captures[0]!.ID, captured.Attachments[0]!.PartID),
    Buffer.from([0, 1, 2, 13, 10, 127, 128, 255]),
  );
  assert.equal((await terminal(app.origin, credentials, large.id)).status, "sent");
  const largeCapture = (await mailpit.list()).filter((m) => m.Subject === `${marker} large`);
  assert.equal(largeCapture.length, 1);
  const largeMessage = await mailpit.message(largeCapture[0]!.ID);
  expectMessageId(await mailpit.raw(largeCapture[0]!.ID), large.smtp_message_id);
  assert.equal(largeMessage.Text.trim(), "A".repeat(1024 * 1024));
  assert.equal(largeMessage.Attachments.length, 10);
  const largePart = largeMessage.Attachments.find((a) => a.FileName === "part-0.bin")!;
  assert.deepEqual(
    await mailpit.part(largeCapture[0]!.ID, largePart.PartID),
    Buffer.alloc(4 * 1024 * 1024 - 9, 0xa5),
  );
  assert.equal((await terminal(app.origin, credentials, alternate.id)).status, "sent");
  const alternateCapture = (await mailpit.list()).filter(
    (m) => m.Subject === `${marker} alternate`,
  );
  assert.equal(alternateCapture.length, 1);
  const alternateMessage = await mailpit.message(alternateCapture[0]!.ID);
  assert.equal(alternateMessage.Text.trim(), "B".repeat(1024 * 1024));
  assert.equal(alternateMessage.HTML.trim(), "<p>synthetic alternate</p>");
  expectMessageId(await mailpit.raw(alternateCapture[0]!.ID), alternate.smtp_message_id);
  assert.equal((await stop(app.child, "SIGTERM")).code, 0);
  app = await production(dataDir);
  assert.equal((await api(app.origin, credentials, `/api/sends/${queued.id}`)).status, "sent");
  assert.equal((await stop(app.child, "SIGTERM")).code, 0);
  captures = (await mailpit.list()).filter((m) => m.Subject === `${marker} queued`);
  assert.equal(captures.length, 1);
  globalThis.process.stdout.write(
    "PASS actual production queued reopen, immutable bytes, stable ID and terminal restart\n",
  );

  const interruptedDir = join(dir, "interrupted");
  seed = await fixture(interruptedDir, sink.port);
  await seed.call("/fixture/settings", "POST", "");
  const interrupted = await seed.call("/fixture/enqueue", "POST", {
    subject: `${marker} interrupted`,
    kind: "transactional",
  });
  await seed.call("/fixture/start", "POST", "before-smtp");
  await seed.call("/fixture/entered");
  await stop(seed.child, "SIGKILL");
  app = await production(interruptedDir);
  const interruptedCredentials = await provisionApiUser(app.origin, admin);
  assert.equal(
    (await api(app.origin, interruptedCredentials, `/api/sends/${interrupted.id}`)).status,
    "unknown",
  );
  assert.equal((await stop(app.child, "SIGTERM")).code, 0);
  app = await production(interruptedDir);
  assert.equal(
    (await api(app.origin, interruptedCredentials, `/api/sends/${interrupted.id}`)).status,
    "unknown",
  );
  assert.equal((await stop(app.child, "SIGTERM")).code, 0);
  assert.equal(
    (await mailpit.list()).filter((m) => m.Subject === `${marker} interrupted`).length,
    0,
  );
  globalThis.process.stdout.write(
    "PASS actual production interrupted claim recovery and stable unknown\n",
  );

  const relay = await faultRelay(sink, "hold-final");
  try {
    const heldDir = join(dir, "held");
    seed = await fixture(heldDir, relay.port);
    await seed.call("/fixture/settings", "POST", "");
    const held = await seed.call("/fixture/enqueue", "POST", {
      subject: `${marker} held`,
      kind: "transactional",
    });
    const remainder = await seed.call("/fixture/enqueue", "POST", {
      subject: `${marker} remainder`,
      kind: "transactional",
    });
    await stop(seed.child, "SIGKILL");
    app = await production(heldDir);
    const heldCredentials = await provisionApiUser(app.origin, admin);
    await Promise.race([
      relay.atFinal,
      new Promise<never>((_, fail) =>
        setTimeout(() => fail(new Error("No held SMTP boundary")), 10000),
      ),
    ]);
    // Hold a real authenticated HTTP body open while shutdown starts. Its
    // completion is deliberately withheld until the mailer cancels the socket.
    const httpSocket = createConnection({
      host: "127.0.0.1",
      port: Number(new URL(app.origin).port),
    });
    httpSocket.on("error", () => {});
    await new Promise<void>((ok, fail) => {
      httpSocket.once("connect", ok);
      httpSocket.once("error", fail);
    });
    const authorization = `Basic ${btoa(`${heldCredentials.user}:${heldCredentials.token}`)}`;
    const continuing = new Promise<void>((ok, fail) => {
      let response = "";
      httpSocket.on("data", (chunk) => {
        response += chunk.toString();
        if (response.includes("100 Continue")) ok();
      });
      httpSocket.once("error", fail);
    });
    await new Promise<void>((ok, fail) =>
      httpSocket.write(
        `POST /api/sends/${held.id}/resend HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${authorization}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`,
        (error) => (error ? fail(error) : ok()),
      ),
    );
    await Promise.race([
      continuing,
      new Promise<never>((_, fail) =>
        setTimeout(() => fail(new Error("No held HTTP body barrier")), 5000),
      ),
    ]);
    httpSocket.write("{");
    const start = performance.now();
    const exited = stop(app.child, "SIGTERM");
    await relay.disconnected;
    httpSocket.write("x");
    httpSocket.end();
    assert.equal((await exited).code, 0);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4000 && elapsed < 8000, `bounded active drain ${elapsed}`);
    seed = await fixture(heldDir, sink.port);
    assert.equal((await seed.get(held.id)).status, "unknown");
    assert.equal((await seed.get(remainder.id)).status, "queued");
    await seed.call("/fixture/settings", "POST", "");
    await stop(seed.child, "SIGKILL");
    app = await production(heldDir);
    assert.equal((await terminal(app.origin, heldCredentials, remainder.id)).status, "sent");
    assert.equal(
      (await api(app.origin, heldCredentials, `/api/sends/${held.id}`)).status,
      "unknown",
    );
    assert.equal((await stop(app.child, "SIGTERM")).code, 0);
    for (const subject of ["held", "remainder"])
      assert.equal(
        (await mailpit.list()).filter((m) => m.Subject === `${marker} ${subject}`).length,
        1,
      );
    globalThis.process.stdout.write(
      `PASS actual production shutdown, socket cancel, queued remainder and reopen (${Math.round(elapsed)}ms)\n`,
    );
  } finally {
    await relay.close();
  }

  const isolateRelay = await faultRelay(sink, "hold-final");
  const secondSink = await localSink();
  try {
    const aDir = join(dir, "isolation-a"),
      bDir = join(dir, "isolation-b");
    const aSeed = await fixture(aDir, isolateRelay.port);
    await aSeed.call("/fixture/settings", "POST", "");
    const aRow = await aSeed.call("/fixture/enqueue", "POST", {
      subject: `${marker} isolation-a`,
      kind: "transactional",
    });
    await stop(aSeed.child, "SIGKILL");
    const bSeed = await fixture(bDir, secondSink.port);
    await bSeed.call("/fixture/settings", "POST", "");
    const bRow = await bSeed.call("/fixture/enqueue", "POST", {
      subject: `${marker} isolation-b`,
      kind: "transactional",
    });
    const wakeOriginal = await bSeed.call("/fixture/enqueue", "POST", {
      subject: `${marker} isolation-wake`,
      kind: "transactional",
    });
    await bSeed.call("/fixture/failed", "POST", { id: wakeOriginal.id });
    await stop(bSeed.child, "SIGKILL");
    const a = await production(aDir),
      b = await production(bDir);
    const aCredentials = await provisionApiUser(a.origin, admin),
      bCredentials = await provisionApiUser(b.origin, admin);
    await isolateRelay.atFinal;
    assert.equal((await terminal(b.origin, bCredentials, bRow.id)).status, "sent");
    const wakeResponse = await fetch(`${b.origin}/api/sends/${wakeOriginal.id}/resend`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${bCredentials.user}:${bCredentials.token}`)}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(wakeResponse.status, 200);
    const wakeChild = (
      (await wakeResponse.json()) as { data: { id: number; smtp_message_id: string } }
    ).data;
    assert.equal((await terminal(b.origin, bCredentials, wakeChild.id)).status, "sent");
    assert.equal((await api(a.origin, aCredentials, `/api/sends/${aRow.id}`)).status, "sending");
    assert.equal(
      (await api(b.origin, bCredentials, `/api/sends/${bRow.id}`)).smtp_message_id,
      bRow.smtp_message_id,
    );
    const wrong = await fetch(`${b.origin}/api/sends`, {
      headers: { authorization: `Basic ${btoa(`${aCredentials.user}:${aCredentials.token}`)}` },
    });
    assert.equal(wrong.status, 403);
    const aExit = stop(a.child, "SIGTERM");
    await isolateRelay.disconnected;
    assert.equal((await aExit).code, 0);
    assert.equal((await api(b.origin, bCredentials, `/api/sends/${bRow.id}`)).status, "sent");
    assert.equal((await stop(b.child, "SIGTERM")).code, 0);
    assert.equal(
      (await mailpit.list()).filter((m) => m.Subject === `${marker} isolation-a`).length,
      1,
    );
    assert.equal(
      (await mailpit.list()).filter((m) => m.Subject === `${marker} isolation-b`).length,
      0,
    );
    assert.equal(secondSink.messages.length, 2);
    const firstMessage = secondSink.messages.find((message) =>
      message.includes(`${marker} isolation-b`),
    );
    const wakeMessage = secondSink.messages.find((message) =>
      message.includes(`${marker} isolation-wake`),
    );
    assert.ok(firstMessage && wakeMessage);
    expectMessageId(firstMessage, bRow.smtp_message_id);
    expectMessageId(wakeMessage, wakeChild.smtp_message_id);
    globalThis.process.stdout.write(
      "PASS two actual production instances, independent credentials, queues, SMTP and shutdown\n",
    );
  } finally {
    await isolateRelay.close();
    await secondSink.close();
  }
} finally {
  for (const child of active)
    if (child.exitCode === null && child.signalCode === null)
      await stop(child, "SIGKILL").catch(() => {});
  await mailpit.removeOwned();
  await rm(dir, { recursive: true, force: true });
}
