// Serial local comparison: M0.8 non-pooled control versus the production messaging owner.
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import nodemailer from "nodemailer";
import { createRealClock } from "@/clock";
import { createEmailer, type SMTPServer } from "@/messaging/email";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { verifyFixtureDkim } from "@/test/perf/runtime-compat/dkim-check";
import { percentile } from "@/test/perf/runtime-compat/metrics";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const sockets = new Set<Socket>();
const relayClosed = new Map<number, Promise<void>>();
let connects = 0,
  live = 0,
  peak = 0;
let idle: (() => void) | undefined;
const proxy = createServer((client) => {
  connects++;
  live++;
  peak = Math.max(peak, live);
  const upstream = createConnection({ host: sink.host, port: sink.port });
  if (client.remotePort)
    relayClosed.set(client.remotePort, new Promise<void>((done) => client.once("close", done)));
  sockets.add(client);
  sockets.add(upstream);
  client.on("error", () => {});
  upstream.on("error", () => {});
  client.pipe(upstream).pipe(client);
  client.once("close", () => {
    live--;
    if (live === 0) idle?.();
    sockets.delete(client);
    upstream.destroy();
  });
  upstream.once("close", () => {
    sockets.delete(upstream);
    client.destroy();
  });
});
await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
const address = proxy.address();
if (!address || typeof address === "string") throw new Error("Missing relay port");
const config: SMTPServer = {
  name: "",
  enabled: true,
  exclude_from_default: false,
  host: "127.0.0.1",
  port: address.port,
  hello_hostname: "fixture.test",
  max_conns: 4,
  idle_timeout: "30s",
  wait_timeout: "5s",
  auth_protocol: "none",
  username: "",
  tls_type: "none",
  tls_skip_verify: false,
  email_headers: [],
  from_addresses: [],
  dkim: { domain_name: "fixture.example.test", key_selector: "m08", private_key: keys.privateKey },
};
async function run(mode: "control" | "owner", count: number, repetition: string) {
  const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
  const mailpit = new Mailpit(sink, marker);
  const before = connects;
  peak = live;
  const emailer = createEmailer({
    settings: () => ({ smtp: [config], rootUrl: "https://example.test" }),
    clock: createRealClock(),
  });
  let accepted = 0,
    matched = 0,
    signatures = 0,
    sendMs = 0,
    observationMs = 0,
    rss = process.memoryUsage().rss;
  const latency: number[] = [];
  try {
    for (let offset = 0; offset < count; offset += 100) {
      const end = Math.min(count, offset + 100),
        ids = new Set<string>();
      let next = offset;
      const start = performance.now();
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < end) {
            const i = next++,
              id = `<${marker}.${i}@example.test>`,
              subject = `${marker} ${i}`,
              body = `Synthetic campaign ${i}: hello Zażółć & world.`;
            ids.add(id.slice(1, -1));
            const begin = performance.now();
            if (mode === "owner") {
              const result = await emailer.push({
                from: "sender@example.test",
                to: [`user${i}@example.test`],
                subject,
                contentType: "plain",
                body: Buffer.from(body),
                messageId: id,
              }).result;
              assert.equal(result.status, "accepted");
              assert.deepEqual(result.accepted, [`user${i}@example.test`]);
              accepted++;
            } else {
              let socketClosed: Promise<void> | undefined;
              let localPort: number | undefined;
              const transport = nodemailer.createTransport({
                getSocket(
                  _options: unknown,
                  callback: (error: Error | null, result: false | { connection: Socket }) => void,
                ) {
                  const socket = createConnection({ host: config.host, port: config.port });
                  socketClosed = new Promise<void>((done) => socket.once("close", done));
                  socket.once("error", (error) => callback(error, false));
                  socket.once("connect", () => {
                    localPort = socket.localPort;
                    callback(null, { connection: socket });
                  });
                },
                host: config.host,
                port: config.port,
                secure: false,
                ignoreTLS: true,
                name: config.hello_hostname,
                connectionTimeout: 5000,
                socketTimeout: 30000,
                disableFileAccess: true,
                disableUrlAccess: true,
                dkim: {
                  domainName: config.dkim!.domain_name,
                  keySelector: config.dkim!.key_selector,
                  privateKey: keys.privateKey,
                },
              });
              try {
                const info = await transport.sendMail({
                  from: "sender@example.test",
                  to: `user${i}@example.test`,
                  subject,
                  text: Buffer.from(body),
                  messageId: id,
                });
                assert.equal(info.messageId, id);
                assert.equal(info.accepted.length, 1);
                accepted++;
              } finally {
                transport.close();
                await socketClosed;
                if (localPort) {
                  await relayClosed.get(localPort);
                  relayClosed.delete(localPort);
                }
              }
            }
            latency.push(performance.now() - begin);
          }
        }),
      );
      sendMs += performance.now() - start;
      const observe = performance.now(),
        found = await mailpit.list();
      assert.equal(found.length, end - offset);
      const actual = new Set(found.map((m) => m.MessageID.replace(/[<>]/g, "")));
      assert.equal(actual.size, ids.size);
      for (const id of ids) assert.ok(actual.has(id));
      matched += actual.size;
      assert.equal(
        verifyFixtureDkim(await mailpit.raw(found[0]!.ID), createPublicKey(keys.publicKey)),
        true,
      );
      signatures++;
      await mailpit.removeOwned();
      observationMs += performance.now() - observe;
      rss = Math.max(rss, process.memoryUsage().rss);
    }
    await emailer.close();
    // Wait for observable relay-side closes, bounded only as a failure guard.
    if (live) {
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((done) => {
            idle = done;
          }),
          new Promise<never>((_, reject) => {
            guard = setTimeout(() => reject(new Error("Relay connections did not close")), 5000);
          }),
        ]);
      } finally {
        idle = undefined;
        clearTimeout(guard);
      }
    }
    assert.equal((await mailpit.list()).length, 0);
    assert.ok(peak <= 4);
    relayClosed.clear();
    console.log(
      JSON.stringify({
        mode,
        repetition,
        count,
        accepted,
        matched,
        signatures,
        connections: connects - before,
        peakConnections: peak,
        liveAfterClose: live,
        sendMs,
        observationMs,
        latency: percentile(latency),
        sampledRss: rss,
      }),
    );
  } finally {
    await emailer.close();
    await mailpit.removeOwned();
  }
}
try {
  await run("control", 100, "warmup");
  await run("owner", 100, "warmup");
  for (let i = 1; i <= 3; i++) {
    await run("control", 1000, String(i));
    await run("owner", 1000, String(i));
  }
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((done) => proxy.close(() => done()));
}
